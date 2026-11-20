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

/* global window, setTimeout */

(function (page) {
  'use strict';

  const baseline = /* @probe-baseline */ null;
  if (!baseline || page.__WPP_PROBE__) return;

  function observedWebVersion() {
    const version = page.Debug?.VERSION;
    return typeof version === 'string' &&
      version.length <= 80 &&
      /^\d+(?:\.\d+){2,}(?:[-+][\w.-]+)?$/.test(version)
      ? version
      : null;
  }

  function getBinding(whatsapp, path) {
    let value = whatsapp;
    for (const segment of path.split('.')) {
      if (
        value == null ||
        !Object.prototype.hasOwnProperty.call(value, segment)
      ) {
        return { found: false };
      }
      value = value[segment];
    }
    return { found: true, value };
  }

  function inspect(whatsapp, target, fullReady) {
    const result = { path: target.path, status: 'present' };
    try {
      const binding = getBinding(whatsapp, target.path);
      if (!binding.found) {
        return { ...result, status: 'missing', reason: 'binding_not_exported' };
      }
      const { value } = binding;
      if (value == null) {
        const conditions = target.availability.filter(
          (reason) => reason !== 'known_session_gated' || !fullReady
        );
        if (!fullReady) conditions.push('main_not_full_ready');
        return conditions.length
          ? {
              ...result,
              status: 'inconclusive',
              reason: 'binding_unresolved',
              conditions,
            }
          : { ...result, status: 'missing', reason: 'binding_unresolved' };
      }

      const kind = typeof value;
      const moduleId = whatsapp._moduleIdMap?.get?.(value);
      result.kind = kind;
      if (typeof moduleId === 'string' && /^[\w.$-]{1,128}$/.test(moduleId)) {
        result.moduleId = moduleId;
      }
      if (target.kind !== 'value' && kind !== target.kind) {
        result.status = 'signature_suspect';
        result.reason = 'unexpected_kind';
        result.expectedKind = target.kind;
      } else if (kind === 'function' && target.arities.length) {
        // `length` is metadata, not the argument or return contract.
        const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
        result.arity =
          Number.isSafeInteger(length) && length >= 0 ? length : null;
        if (result.arity === null) {
          result.status = 'inconclusive';
          result.reason = 'arity_unobservable';
        } else if (
          !target.arities.some(
            ([min, max]) => length >= min && (max === null || length <= max)
          )
        ) {
          result.status = 'signature_suspect';
          result.reason = 'arity_outside_declarations';
          result.expectedArities = target.arities;
        }
      }
    } catch {
      // Getter exceptions can contain live page data; do not serialize them.
      return {
        path: target.path,
        status: 'error',
        reason: 'binding_inspection_failed',
      };
    }
    return result;
  }

  async function run({ expectedWebVersion } = {}) {
    const webVersion = observedWebVersion();
    const wpp = page.WPP;
    const waJsVersion = typeof wpp?.version === 'string' ? wpp.version : null;
    const fullReady = wpp?.isFullReady === true;
    const report = {
      schemaVersion: baseline.schemaVersion,
      baselineId: baseline.id,
      baselineWaJsVersion: baseline.waJsVersion,
      waJsVersion,
      webVersion,
      versionSource: webVersion ? 'Debug.VERSION' : null,
      stage: 'ready',
      fullReady,
      targetCount: baseline.targets.length,
      summary: {
        present: 0,
        missing: 0,
        inconclusive: 0,
        signature_suspect: 0,
        error: 0,
      },
      returnVerification: 'not_executed',
      moduleIntegrity: {},
      diagnosis: [],
    };
    function stop(code) {
      report.stage = code;
      report.diagnosis = [{ code }];
      return report;
    }
    if (!wpp) return stop('wpp_not_injected');
    if (waJsVersion !== baseline.waJsVersion)
      return stop('wpp_version_mismatch');
    if (wpp.isReady !== true) return stop('wpp_not_ready');
    if (!webVersion) return stop('web_version_unavailable');
    if (expectedWebVersion !== undefined && webVersion !== expectedWebVersion) {
      return stop('web_version_mismatch');
    }
    // A failed WPP lazy getter may call trackException(). Do not scan with it on.
    if (wpp.config?.disableGoogleAnalytics !== true)
      return stop('wpp_telemetry_enabled');
    const whatsapp = wpp.whatsapp;
    if (whatsapp == null) return stop('wpp_whatsapp_unavailable');

    const moduleIntegrity = Object.create(null);
    const summary = { ...report.summary };
    const diagnosis = [];
    let batchStarted = Date.now();
    for (const target of baseline.targets) {
      if (Date.now() - batchStarted >= 16) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (
          page.WPP !== wpp ||
          observedWebVersion() !== webVersion ||
          (wpp.isFullReady === true) !== fullReady
        )
          return stop('page_state_changed');
        if (wpp.config?.disableGoogleAnalytics !== true)
          return stop('wpp_telemetry_enabled');
        batchStarted = Date.now();
      }
      const result = inspect(whatsapp, target, fullReady);
      (moduleIntegrity[target.group] ??= []).push(result);
      summary[result.status]++;
      if (result.reason) {
        diagnosis.push({
          path: result.path,
          status: result.status,
          code: result.reason,
        });
      }
    }
    return { ...report, summary, moduleIntegrity, diagnosis };
  }

  page.__WPP_PROBE__ = Object.freeze({ run });
})(window);
