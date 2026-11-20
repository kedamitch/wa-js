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

/* eslint-disable @typescript-eslint/no-require-imports -- This Node test uses CommonJS. */
/* eslint @typescript-eslint/no-unused-vars: ["error", { "argsIgnorePattern": "^_" }] */

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');
const { setTimeout } = require('node:timers');
const { runInNewContext } = require('node:vm');

const dist = resolve(__dirname, '../dist');
const baseline = JSON.parse(
  readFileSync(resolve(dist, 'wppconnect-wa-probe-baseline.json'), 'utf8')
);
const script = readFileSync(resolve(dist, 'wppconnect-wa-probe.js'), 'utf8');
const webVersion = '2.3000.1054241206-alpha';
const findTarget = (path) =>
  baseline.targets.find((target) => target.path === path);
const findResult = (report, path) =>
  Object.values(report.moduleIntegrity)
    .flat()
    .find((target) => target.path === path);

function inject(wpp, version = webVersion, globals = {}) {
  const page = { WPP: wpp, Debug: { VERSION: version } };
  const context = { window: page, setTimeout, ...globals };
  runInNewContext(script, context);
  return {
    page,
    context,
    // Use the same serialization boundary as the external controller.
    run: async (options) =>
      JSON.parse(JSON.stringify(await page.__WPP_PROBE__.run(options))),
  };
}

function wpp(whatsapp, options = {}) {
  return {
    version: baseline.waJsVersion,
    isReady: true,
    isFullReady: true,
    config: { disableGoogleAnalytics: true },
    whatsapp,
    ...options,
  };
}

test('the paired artifacts identify exported source bindings and declarations', () => {
  assert.ok(baseline.targets.length > 400);
  const paths = baseline.targets.map(({ path }) => path);
  assert.deepEqual(paths, [...new Set(paths)].sort());
  assert.ok(!paths.includes('_moduleIdMap'));
  assert.ok(!paths.includes('enums.StreamMode'));
  assert.ok(!paths.includes('isLidMigrated'));

  const forward = findTarget('functions.forwardMessages');
  assert.ok(forward.moduleIds.includes('WAWebChatForwardMessage'));
  assert.ok(forward.availability.includes('known_lazy'));
  assert.match(
    forward.source,
    /^src\/whatsapp\/functions\/forwardMessages\.ts:\d+$/
  );
  assert.deepEqual(forward.bindings[0].exportPaths, ['forwardMessages']);
  assert.equal(
    forward.signatures[0].parameters[0].type,
    'ForwardMessagesParams'
  );
  assert.equal(forward.signatures[0].returns, 'Promise<Array<any>>');

  assert.deepEqual(
    findTarget('functions.sendSeen').signatures.map(({ arity }) => arity),
    [
      [2, 2],
      [1, 1],
    ]
  );
  assert.ok(
    findTarget('functions.createGroup').availability.includes(
      'known_session_gated'
    )
  );
  assert.deepEqual(findTarget('ChatModel').bindings[0].exportPaths, [
    'default',
    'ChatModel',
    'Chat',
  ]);
  assert.deepEqual(findTarget('ChatStore').bindings[0].exportPaths, [
    'default',
    'ChatCollection',
  ]);
  assert.equal(findTarget('contants.SANITIZED_VERSION_STR').kind, 'value');
  assert.ok(findTarget('websocket.generateId'));

  const manifest = {
    schemaVersion: baseline.schemaVersion,
    waJsVersion: baseline.waJsVersion,
    targets: baseline.targets,
  };
  assert.equal(
    baseline.id,
    createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
  );
});

test('injection is inert and repeatable and early exit does not inspect bindings', async () => {
  let reads = 0;
  const bundle = wpp(null);
  Object.defineProperty(bundle, 'whatsapp', {
    get() {
      reads++;
      throw new Error('unexpected binding read');
    },
  });
  const probe = inject(undefined);
  const api = probe.page.__WPP_PROBE__;
  assert.equal((await probe.run()).stage, 'wpp_not_injected');
  runInNewContext(script, probe.context);
  assert.equal(probe.page.__WPP_PROBE__, api);
  assert.deepEqual(Object.keys(probe.page).sort(), [
    'Debug',
    'WPP',
    '__WPP_PROBE__',
  ]);

  probe.page.WPP = bundle;
  bundle.isReady = false;
  assert.equal((await probe.run()).stage, 'wpp_not_ready');
  bundle.isReady = true;
  assert.equal(
    (await probe.run({ expectedWebVersion: '2.3000.1' })).stage,
    'web_version_mismatch'
  );
  bundle.version = '0.0.1';
  assert.equal((await probe.run()).stage, 'wpp_version_mismatch');
  bundle.version = baseline.waJsVersion;
  bundle.config.disableGoogleAnalytics = false;
  assert.equal((await probe.run()).stage, 'wpp_telemetry_enabled');
  probe.page.Debug.VERSION = { raw: 'not a version' };
  const report = await probe.run();
  assert.equal(report.stage, 'web_version_unavailable');
  assert.equal(report.webVersion, null);
  assert.deepEqual(report.moduleIntegrity, {});
  assert.equal(reads, 0);
});

test('QR-stage reports separate missing, unresolved, callable and changed metadata', async () => {
  let calls = 0;
  function seen(_options) {
    calls++;
  }
  const functions = {
    sendSeen: seen,
    markUnread: function (_chat, _unread, _allowAction, _additional) {
      calls++;
    },
    forwardMessages: undefined,
    createGroup: undefined,
    getImg: undefined,
    getGroupSizeLimit: undefined,
    addAndSendMsgToChat: 0,
  };
  Object.defineProperty(functions, 'markPlayed', {
    get() {
      throw new Error('private fixture text');
    },
  });
  const bundle = wpp(
    {
      functions,
      _moduleIdMap: new Map([[seen, 'WAWebUpdateUnreadChatAction']]),
      ChatStore: {},
    },
    { isFullReady: false }
  );
  const { run } = inject(bundle);
  const report = await run({ expectedWebVersion: webVersion });

  assert.equal(report.stage, 'ready');
  assert.equal(report.versionSource, 'Debug.VERSION');
  assert.equal(report.webVersion, webVersion);
  assert.equal(report.baselineId, baseline.id);
  assert.equal(report.fullReady, false);
  assert.equal(report.returnVerification, 'not_executed');
  assert.equal(report.targetCount, baseline.targets.length);
  assert.equal(
    Object.values(report.summary).reduce((a, b) => a + b),
    report.targetCount
  );
  assert.equal(findResult(report, 'ChatStore').status, 'present');
  assert.deepEqual(findResult(report, 'functions.sendSeen'), {
    path: 'functions.sendSeen',
    status: 'present',
    kind: 'function',
    moduleId: 'WAWebUpdateUnreadChatAction',
    arity: 1,
  });
  const change = findResult(report, 'functions.markUnread');
  assert.equal(change.status, 'signature_suspect');
  assert.equal(change.arity, 4);
  assert.equal(change.reason, 'arity_outside_declarations');
  assert.equal(
    findResult(report, 'functions.addAndSendMsgToChat').reason,
    'unexpected_kind'
  );
  assert.equal(
    findResult(report, 'functions.forwardMessages').status,
    'inconclusive'
  );
  assert.ok(
    findResult(report, 'functions.forwardMessages').conditions.includes(
      'known_lazy'
    )
  );
  assert.ok(
    findResult(report, 'functions.createGroup').conditions.includes(
      'known_session_gated'
    )
  );
  assert.ok(
    findResult(report, 'functions.getImg').conditions.includes(
      'version_or_fallback'
    )
  );
  assert.equal(
    findResult(report, 'functions.getGroupSizeLimit').status,
    'inconclusive'
  );
  assert.equal(
    findResult(report, 'functions.isRegistered').reason,
    'binding_not_exported'
  );
  assert.equal(findResult(report, 'functions.markPlayed').status, 'error');
  assert.ok(!JSON.stringify(report).includes('private fixture text'));
  assert.equal(calls, 0);

  bundle.isFullReady = true;
  const ready = await run();
  assert.equal(
    findResult(ready, 'functions.getGroupSizeLimit').status,
    'missing'
  );
  assert.equal(
    findResult(ready, 'functions.forwardMessages').status,
    'inconclusive'
  );
});

test('a delayed export is read again on the next run without bootloading', async () => {
  let available = false;
  let reads = 0;
  const functions = {
    get forwardMessages() {
      reads++;
      return available ? function (_options) {} : undefined;
    },
  };
  const { run } = inject(
    wpp(
      { functions },
      {
        loader: {
          ensureLazyModule: () => assert.fail('probe must not bootload'),
        },
      }
    )
  );
  assert.equal(
    findResult(await run(), 'functions.forwardMessages').status,
    'inconclusive'
  );
  available = true;
  assert.equal(
    findResult(await run(), 'functions.forwardMessages').status,
    'present'
  );
  assert.equal(reads, 2);
});

test('a page readiness change discards partial results', async () => {
  let now = 0;
  const bundle = wpp(
    {
      get ChatModel() {
        now = 20;
        return class ChatModel {};
      },
    },
    { isFullReady: false }
  );
  const { run } = inject(bundle, webVersion, {
    Date: { now: () => now },
    setTimeout(resolve) {
      bundle.isFullReady = true;
      resolve();
    },
  });
  const report = await run();
  assert.equal(report.stage, 'page_state_changed');
  assert.deepEqual(report.moduleIntegrity, {});
  assert.deepEqual(report.diagnosis, [{ code: 'page_state_changed' }]);
  assert.ok(Object.values(report.summary).every((count) => count === 0));
});
