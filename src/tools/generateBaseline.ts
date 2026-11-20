/*!
 * Copyright 2026 WPPConnect Team
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

import ts from 'typescript';

import { IGNORE_FAIL_MODULES } from '../loader/blacklist';
import { LAZY_MODULES } from '../loader/lazyModules';

const projectRoot = resolve(__dirname, '../..');
const whatsappRoot = resolve(projectRoot, 'src/whatsapp');
const registryFile = resolve(whatsappRoot, 'exportModule.ts');
const baselineMarker = '/* @probe-baseline */ null';

// This binding has been session-gated in some versions (see updateModuleID).
const sessionGated = new Set(['functions.createGroup']);

type Binding = {
  source: string;
  exportPaths: string[] | null;
  moduleIds: string[];
};

type Arity = [min: number, max: number | null];

function localPath(file: string) {
  return relative(projectRoot, file).split(sep).join('/');
}

function location(node: ts.Node) {
  const file = node.getSourceFile();
  const line = file.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  return `${localPath(file.fileName)}:${line}`;
}

function unsupported(node: ts.Node): never {
  throw new Error(`Unsupported WA-JS binding syntax at ${location(node)}`);
}

function aliasTarget(checker: ts.TypeChecker, symbol?: ts.Symbol) {
  return symbol && symbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(symbol)
    : symbol;
}

function staticString(
  node: ts.Expression,
  checker: ts.TypeChecker,
  locals: ReadonlyMap<string, string>
): string {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isIdentifier(node)) {
    const value = locals.get(node.text);
    if (value !== undefined) return value;
    const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
    if (
      declaration &&
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      declaration.getSourceFile() === node.getSourceFile() &&
      declaration.getStart() < node.getStart()
    ) {
      return staticString(declaration.initializer, checker, locals);
    }
  }
  // The stores registration loop derives collection export names this way.
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'replace' &&
    node.arguments.length === 2
  ) {
    const [search, replacement] = node.arguments;
    if (ts.isStringLiteralLike(search) && ts.isStringLiteralLike(replacement)) {
      return staticString(node.expression.expression, checker, locals).replace(
        search.text,
        replacement.text
      );
    }
  }
  return unsupported(node);
}

function selectorIds(
  selector: ts.Expression | undefined,
  checker: ts.TypeChecker
) {
  const declaration =
    selector && ts.isIdentifier(selector)
      ? checker.getSymbolAtLocation(selector)?.valueDeclaration
      : selector;
  const callback =
    declaration && ts.isVariableDeclaration(declaration)
      ? declaration.initializer
      : declaration;
  if (
    !callback ||
    !(
      ts.isArrowFunction(callback) ||
      ts.isFunctionExpression(callback) ||
      ts.isFunctionDeclaration(callback)
    )
  )
    return [];
  const id = callback.parameters[1]?.name;
  if (!id || !ts.isIdentifier(id)) return [];
  const idSymbol = checker.getSymbolAtLocation(id);
  const ids = new Set<string>();
  function visit(node: ts.Node) {
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken)
    ) {
      for (const [left, right] of [
        [node.left, node.right],
        [node.right, node.left],
      ]) {
        if (
          ts.isIdentifier(left) &&
          checker.getSymbolAtLocation(left) === idSymbol &&
          ts.isStringLiteralLike(right)
        ) {
          ids.add(right.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  if (callback.body) visit(callback.body);
  return [...ids].sort();
}

function bindingsForFile(file: ts.SourceFile, checker: ts.TypeChecker) {
  const bindings = new Map<string, Binding[]>();

  function visit(node: ts.Node, locals: ReadonlyMap<string, string>) {
    if (
      ts.isForOfStatement(node) &&
      ts.isVariableDeclarationList(node.initializer)
    ) {
      const [variable] = node.initializer.declarations;
      const values = checker.getSymbolAtLocation(
        node.expression
      )?.valueDeclaration;
      if (
        variable &&
        ts.isIdentifier(variable.name) &&
        values &&
        ts.isVariableDeclaration(values) &&
        values.initializer &&
        ts.isArrayLiteralExpression(values.initializer) &&
        values.initializer.elements.every(ts.isStringLiteralLike)
      ) {
        for (const value of values.initializer.elements) {
          visit(
            node.statement,
            new Map([...locals, [variable.name.text, value.text]])
          );
        }
        return;
      }
    }

    if (ts.isCallExpression(node)) {
      const symbol = aliasTarget(
        checker,
        checker.getSymbolAtLocation(node.expression)
      );
      if (
        symbol?.valueDeclaration?.getSourceFile().fileName === registryFile &&
        ['exportModule', 'exportProxyModel'].includes(symbol.name)
      ) {
        const [exportsArg, bindingArg, selector] = node.arguments;
        // Some patches register bindings on a temporary object, not on WPP.
        if (
          !exportsArg ||
          !ts.isIdentifier(exportsArg) ||
          exportsArg.text !== 'exports'
        )
          return;
        if (!bindingArg) return unsupported(node);
        const source = location(node);
        const moduleIds = selectorIds(selector, checker);
        function add(name: string, exportPaths: string[] | null) {
          const entries = bindings.get(name) ?? [];
          entries.push({ source, exportPaths, moduleIds });
          bindings.set(name, entries);
        }
        if (symbol.name === 'exportProxyModel') {
          const name = staticString(bindingArg, checker, locals);
          add(name, ['default', name, name.replace(/Model$/, '')]);
        } else if (ts.isStringLiteralLike(bindingArg)) {
          add(bindingArg.text, null);
        } else if (ts.isObjectLiteralExpression(bindingArg)) {
          for (const property of bindingArg.properties) {
            if (!ts.isPropertyAssignment(property))
              return unsupported(property);
            const key = property.name;
            const name =
              ts.isIdentifier(key) || ts.isStringLiteralLike(key)
                ? key.text
                : ts.isComputedPropertyName(key)
                  ? staticString(key.expression, checker, locals)
                  : unsupported(key);
            const value = property.initializer;
            add(
              name,
              value.kind === ts.SyntaxKind.NullKeyword ||
                (ts.isIdentifier(value) && value.text === 'undefined')
                ? null
                : ts.isArrayLiteralExpression(value)
                  ? value.elements.map((entry) =>
                      staticString(entry, checker, locals)
                    )
                  : [staticString(value, checker, locals)]
            );
          }
        } else {
          return unsupported(bindingArg);
        }
      }
    }
    ts.forEachChild(node, (child) => visit(child, locals));
  }

  if (file.fileName !== registryFile) visit(file, new Map());
  return bindings;
}

function documentedIds(declarations: readonly ts.Declaration[]) {
  const ids = new Set<string>();
  for (const declaration of declarations) {
    const documented = ts.isVariableDeclaration(declaration)
      ? declaration.parent.parent
      : declaration;
    for (const tag of ts.getJSDocTags(documented)) {
      if (tag.tagName.text !== 'whatsapp') continue;
      const id = ts
        .getTextOfJSDocComment(tag.comment)
        ?.trim()
        .split(/\s+/, 1)[0];
      if (id && /^(?:WA[A-Za-z0-9_.$-]*|\d+)$/.test(id)) ids.add(id);
    }
  }
  return [...ids].sort();
}

function contract(checker: ts.TypeChecker, type: ts.Type, site: ts.Node) {
  const calls = type.getCallSignatures();
  const kind =
    calls.length || type.getConstructSignatures().length
      ? 'function'
      : type.flags & ts.TypeFlags.Object
        ? 'object'
        : 'value';
  const signatures = calls.map((call) => {
    let min = 0;
    let max: number | null = 0;
    const parameters = call.getParameters().map((parameter, index) => {
      const declaration = parameter.valueDeclaration;
      const parameterNode =
        declaration && ts.isParameter(declaration) ? declaration : undefined;
      const rest = Boolean(parameterNode?.dotDotDotToken);
      const optional = Boolean(
        parameterNode?.questionToken ||
        parameterNode?.initializer ||
        parameter.flags & ts.SymbolFlags.Optional
      );
      if (!rest && !optional) min = index + 1;
      if (rest) max = null;
      else if (max !== null) max++;
      return {
        name: parameterNode?.name.getText() ?? parameter.name,
        type:
          parameterNode?.type?.getText() ??
          checker.typeToString(
            checker.getTypeOfSymbolAtLocation(parameter, site)
          ),
        optional,
        rest,
      };
    });
    return {
      parameters,
      returns:
        call.getDeclaration()?.type?.getText() ??
        checker.typeToString(call.getReturnType()),
      arity: [min, max] as Arity,
    };
  });
  return { kind, signatures };
}

type Target = ReturnType<typeof contract> & {
  path: string;
  group: string;
  source: string;
  bindings: Binding[];
  moduleIds: string[];
  availability: string[];
};

function buildBaseline() {
  const configFile = resolve(projectRoot, 'tsconfig.json');
  const config = ts.readConfigFile(configFile, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    projectRoot
  );
  const errors = config.error
    ? [config.error, ...parsed.errors]
    : parsed.errors;
  if (errors.length)
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(errors, {
        getCanonicalFileName: (name) => name,
        getCurrentDirectory: () => projectRoot,
        getNewLine: () => '\n',
      })
    );
  const program = ts.createProgram(parsed.fileNames, {
    ...parsed.options,
    module: ts.ModuleKind.ESNext,
    noEmit: true,
  });
  const checker = program.getTypeChecker();
  const files = program
    .getSourceFiles()
    .filter((file) => localPath(file.fileName).startsWith('src/whatsapp/'));
  const bindings = new Map(
    files.map((file) => [file.fileName, bindingsForFile(file, checker)])
  );
  const entry = program.getSourceFile(resolve(whatsappRoot, 'index.ts'));
  const root = entry && checker.getSymbolAtLocation(entry);
  if (!root) throw new Error('WA-JS WhatsApp namespace was not found');

  function targetsFor(
    module: ts.Symbol,
    prefix = '',
    visited = new Set<ts.Symbol>()
  ): Target[] {
    if (visited.has(module)) return [];
    const visitedHere = new Set([...visited, module]);
    const targets: Target[] = [];
    for (const exported of checker.getExportsOfModule(module)) {
      const symbol = aliasTarget(checker, exported);
      const declaration = symbol?.valueDeclaration;
      const path = prefix ? `${prefix}.${exported.name}` : exported.name;
      if (!symbol || !declaration) continue;
      if (ts.isSourceFile(declaration) && bindings.has(declaration.fileName)) {
        targets.push(...targetsFor(symbol, path, visitedHere));
        continue;
      }
      const registrations = bindings
        .get(declaration.getSourceFile().fileName)
        ?.get(symbol.name);
      if (!registrations?.length) continue;
      const moduleIds = [
        ...new Set([
          ...registrations.flatMap(({ moduleIds }) => moduleIds),
          ...documentedIds(symbol.getDeclarations() ?? []),
        ]),
      ].sort();
      const availability: string[] = [];
      if (
        moduleIds.some((id) =>
          Object.prototype.hasOwnProperty.call(LAZY_MODULES, id)
        )
      )
        availability.push('known_lazy');
      if (sessionGated.has(path)) availability.push('known_session_gated');
      if (IGNORE_FAIL_MODULES.has(symbol.name))
        availability.push('version_or_fallback');
      targets.push({
        path,
        group:
          prefix ||
          localPath(declaration.getSourceFile().fileName)
            .split('/')[2]
            .replace(/\.ts$/, ''),
        source: location(declaration),
        bindings: registrations,
        moduleIds,
        availability,
        ...contract(
          checker,
          checker.getTypeOfSymbolAtLocation(symbol, declaration),
          declaration
        ),
      });
    }
    return targets;
  }

  const targets = targetsFor(root).sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  );
  if (!targets.length) throw new Error('No WA-JS module bindings found');

  const { version: waJsVersion } = JSON.parse(
    readFileSync(resolve(projectRoot, 'package.json'), 'utf8')
  );
  if (typeof waJsVersion !== 'string')
    throw new Error('No WA-JS version found');
  const baseline = { schemaVersion: 1, waJsVersion, targets };
  const id = createHash('sha256')
    .update(JSON.stringify(baseline))
    .digest('hex');
  return { ...baseline, id };
}

function main() {
  const { targets, ...meta } = buildBaseline();
  const compact = {
    ...meta,
    targets: targets.map(({ path, group, kind, signatures, availability }) => ({
      path,
      group,
      kind,
      arities: signatures.map(({ arity }) => arity),
      availability,
    })),
  };
  const source = readFileSync(resolve(__dirname, 'probe.js'), 'utf8');
  if (source.split(baselineMarker).length !== 2)
    throw new Error('Expected one probe baseline marker');
  const output = resolve(projectRoot, 'dist');
  mkdirSync(output, { recursive: true });
  writeFileSync(
    resolve(output, 'wppconnect-wa-probe-baseline.json'),
    JSON.stringify({ ...meta, targets }, null, 2) + '\n'
  );
  writeFileSync(
    resolve(output, 'wppconnect-wa-probe.js'),
    source.replace(baselineMarker, () => JSON.stringify(compact))
  );
  console.log(
    `Built WA-JS compatibility probe from ${targets.length} bindings.`
  );
}

main();
