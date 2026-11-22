import { resolveMonitoringFeatureFlags } from '../src/monitoring_features';
const flags = (mode: string, target?: string) => resolveMonitoringFeatureFlags({
  remoteMonitoringRequested: false, exportToBigqueryRequested: false,
  predictionMode: mode, predictionTarget: target, runId: 'test',
});
test.each(['predict', 'forecast', 'tabpfn'])('activity supports %s independently of export', mode => {
  expect(flags(mode, 'class_loading')).toMatchObject({predictionTarget: 'class_loading', enableBackend: true, exportToBigquery: false});
  expect(flags('forecast')).toMatchObject({predictionTarget: 'memory'});
});
test.each(['disabled', 'bqml-boosted'])('rejects activity with %s', mode => {
  expect(() => flags(mode, 'class_loading')).toThrow('class_loading requires prediction_mode=predict, forecast, or tabpfn');
});
test('rejects unknown targets', () => { expect(() => flags('tabpfn', 'jit')).toThrow('prediction_target'); });

test.each(['disabled', 'forecast', 'predict', 'bqml-boosted', 'tabpfn'])(
  '%s preserves memory behavior for omitted and explicit targets', mode => {
    expect(flags(mode)).toEqual(flags(mode, 'memory'));
    expect(flags(mode).exportToBigquery).toBe(false);
  },
);

test('class-loading prediction preserves explicit export opt-in', () => {
  expect(resolveMonitoringFeatureFlags({
    remoteMonitoringRequested: false,
    exportToBigqueryRequested: true,
    predictionMode: 'tabpfn',
    predictionTarget: 'class_loading',
    runId: 'activity-export',
  })).toMatchObject({
    predictionTarget: 'class_loading', enableBackend: true, exportToBigquery: true,
  });
});
