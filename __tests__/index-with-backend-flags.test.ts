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
    });
  });
});
