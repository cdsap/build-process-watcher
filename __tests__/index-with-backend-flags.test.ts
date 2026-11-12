import {
  DEFAULT_BACKEND_URL,
  DEFAULT_FRONTEND_BASE_URL,
  resolveMonitoringFeatureFlags,
} from '../src/monitoring_features';

describe('resolveMonitoringFeatureFlags', () => {
  it('keeps local mode when no remote-only feature is requested', () => {
    expect(resolveMonitoringFeatureFlags({
      remoteMonitoringRequested: false,
      exportToBigqueryRequested: false,
      predictiveReliabilityRequested: false,
      backendUrl: '',
      runId: 'run-1',
    })).toEqual({
      enableBackend: false,
      backendUrl: '',
      frontendUrl: '',
      exportToBigquery: false,
      predictiveReliability: false,
      predictionMode: 'disabled',
    });
  });

  it('preserves an unused backend URL when remote features are off', () => {
    expect(resolveMonitoringFeatureFlags({
      remoteMonitoringRequested: false,
      exportToBigqueryRequested: false,
      predictiveReliabilityRequested: false,
      backendUrl: 'https://backend.example',
      runId: 'run-1',
    })).toEqual({
      enableBackend: false,
      backendUrl: 'https://backend.example',
      frontendUrl: '',
      exportToBigquery: false,
      predictiveReliability: false,
      predictionMode: 'disabled',
    });
  });

  it('keeps BigQuery export dependent on an enabled backend', () => {
    expect(resolveMonitoringFeatureFlags({
      remoteMonitoringRequested: false,
      exportToBigqueryRequested: true,
      predictiveReliabilityRequested: false,
      backendUrl: 'https://backend.example',
      runId: 'run-1',
    })).toEqual({
      enableBackend: false,
      backendUrl: 'https://backend.example',
      frontendUrl: '',
      exportToBigquery: false,
      predictiveReliability: false,
      predictionMode: 'disabled',
    });
  });

  it('treats predictive reliability as remote monitoring with BigQuery export', () => {
    expect(resolveMonitoringFeatureFlags({
      remoteMonitoringRequested: false,
      exportToBigqueryRequested: false,
      predictiveReliabilityRequested: true,
      backendUrl: 'https://backend.example',
      runId: 'run-1',
    })).toEqual({
      enableBackend: true,
      backendUrl: 'https://backend.example',
      frontendUrl: `${DEFAULT_FRONTEND_BASE_URL}/runs/run-1`,
      exportToBigquery: true,
      predictiveReliability: true,
      predictionMode: 'reliability',
    });
  });

  it('injects the default backend URL for remote monitoring when none is provided', () => {
    expect(resolveMonitoringFeatureFlags({
      remoteMonitoringRequested: true,
      exportToBigqueryRequested: false,
      predictiveReliabilityRequested: false,
      backendUrl: '',
      runId: 'run-remote',
    })).toEqual({
      enableBackend: true,
      backendUrl: DEFAULT_BACKEND_URL,
      frontendUrl: `${DEFAULT_FRONTEND_BASE_URL}/runs/run-remote`,
      exportToBigquery: false,
      predictiveReliability: false,
      predictionMode: 'disabled',
    });
  });

  it('injects the default backend URL for predictive reliability when none is provided', () => {
    expect(resolveMonitoringFeatureFlags({
      remoteMonitoringRequested: false,
      exportToBigqueryRequested: false,
      predictiveReliabilityRequested: true,
      runId: 'run-predictive',
    })).toEqual({
      enableBackend: true,
      backendUrl: DEFAULT_BACKEND_URL,
      frontendUrl: `${DEFAULT_FRONTEND_BASE_URL}/runs/run-predictive`,
      exportToBigquery: true,
      predictiveReliability: true,
      predictionMode: 'reliability',
    });
  });

  it('builds a frontend run URL when the base already ends with /runs', () => {
    expect(resolveMonitoringFeatureFlags({
      remoteMonitoringRequested: true,
      exportToBigqueryRequested: false,
      predictiveReliabilityRequested: false,
      backendUrl: 'https://backend.example',
      frontendUrl: 'https://frontend.example/runs',
      runId: 'run-abc',
    })).toEqual({
      enableBackend: true,
      backendUrl: 'https://backend.example',
      frontendUrl: 'https://frontend.example/runs/run-abc',
      exportToBigquery: false,
      predictiveReliability: false,
      predictionMode: 'disabled',
    });
  });

  it('builds a frontend run URL when the base already ends with /runs/', () => {
    expect(resolveMonitoringFeatureFlags({
      remoteMonitoringRequested: true,
      exportToBigqueryRequested: false,
      predictiveReliabilityRequested: false,
      backendUrl: 'https://backend.example',
      frontendUrl: 'https://frontend.example/runs/',
      runId: 'run-abc',
    })).toEqual({
      enableBackend: true,
      backendUrl: 'https://backend.example',
      frontendUrl: 'https://frontend.example/runs//run-abc',
      exportToBigquery: false,
      predictiveReliability: false,
      predictionMode: 'disabled',
    });
  });

  it('appends /runs/:runId when the frontend base does not end with /runs', () => {
    expect(resolveMonitoringFeatureFlags({
      remoteMonitoringRequested: true,
      exportToBigqueryRequested: false,
      predictiveReliabilityRequested: false,
      backendUrl: 'https://backend.example',
      frontendUrl: 'https://frontend.example',
      runId: 'run-abc',
    })).toEqual({
      enableBackend: true,
      backendUrl: 'https://backend.example',
      frontendUrl: 'https://frontend.example/runs/run-abc',
      exportToBigquery: false,
      predictiveReliability: false,
      predictionMode: 'disabled',
    });
  });
});

describe('prediction mode selection', () => {
  const base = { remoteMonitoringRequested: false, exportToBigqueryRequested: false, predictiveReliabilityRequested: false, runId: 'run-1' };
  it.each(['disabled', 'reliability', 'forecast', 'predict'] as const)('resolves %s', (predictionMode) => {
    const flags = resolveMonitoringFeatureFlags({ ...base, predictionMode });
    expect(flags.predictionMode).toBe(predictionMode);
    expect(flags.enableBackend).toBe(predictionMode !== 'disabled');
    expect(flags.predictiveReliability).toBe(predictionMode === 'reliability');
    expect(flags.exportToBigquery).toBe(predictionMode === 'reliability');
  });
  it('accepts the legacy opt-in with an explicit matching mode', () => {
    expect(resolveMonitoringFeatureFlags({ ...base, predictionMode: 'reliability', predictiveReliabilityRequested: true }).predictionMode).toBe('reliability');
  });
  it.each(['disabled', 'forecast', 'predict'])('rejects legacy opt-in conflicting with %s', (predictionMode) => {
    expect(() => resolveMonitoringFeatureFlags({ ...base, predictionMode, predictiveReliabilityRequested: true })).toThrow('conflicts');
  });
  it('rejects invalid values without echoing them', () => {
    expect(() => resolveMonitoringFeatureFlags({ ...base, predictionMode: 'private-value' })).toThrow('Invalid prediction_mode');
  });
});
