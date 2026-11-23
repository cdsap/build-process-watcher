import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { resolveMonitoringFeatureFlags } from '../src/monitoring_features';

// Exercise the shipped module without starting the action's process monitor.
function loadBundledFlags(): typeof resolveMonitoringFeatureFlags {
  const bundle = fs.readFileSync(path.join(__dirname, '../dist/index_with_backend.js'), 'utf8');
  const featureModule = bundle.split(/(?=\/\*\*\*\/ \d+:)/)
    .find(section => section.includes('exports.resolveMonitoringFeatureFlags ='));
  const moduleId = featureModule?.match(/^\/\*\*\*\/ (\d+):/)?.[1];
  if (!moduleId) throw new Error('Prediction feature module missing from action bundle');
  const startup = /var __webpack_exports__ = __nccwpck_require__\(\d+\);/;
  if (!startup.test(bundle)) throw new Error('Action bundle startup not found');
  const context = { require, module: { exports: {} }, __dirname: path.join(__dirname, '../dist') };
  vm.runInNewContext(bundle.replace(startup, `var __webpack_exports__ = __nccwpck_require__(${moduleId});`), context);
  return (context.module.exports as {resolveMonitoringFeatureFlags: typeof resolveMonitoringFeatureFlags}).resolveMonitoringFeatureFlags;
}

const bundledFlags = loadBundledFlags();
const modes = ['disabled', 'forecast', 'predict', 'bqml-boosted', 'tabpfn'];

describe.each(['memory', 'class_loading'])('shipped action prediction target %s', target => {
  test.each(modes)('matches source validation for %s', mode => {
    const inputs = {
      remoteMonitoringRequested: false, exportToBigqueryRequested: false,
      predictionMode: mode, predictionTarget: target, runId: 'bundled-validation',
    };
    if (target === 'class_loading' && ['disabled', 'bqml-boosted'].includes(mode)) {
      expect(() => bundledFlags(inputs)).toThrow('class_loading requires prediction_mode=predict, forecast, or tabpfn');
    } else {
      expect(bundledFlags(inputs)).toEqual(resolveMonitoringFeatureFlags(inputs));
    }
  });
});
