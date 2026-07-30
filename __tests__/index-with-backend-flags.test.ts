import { resolveMonitoringFeatureFlags } from '../src/monitoring_features';

describe('resolveMonitoringFeatureFlags', () => {
  it('keeps local mode when no remote-only feature is requested', () => {
    expect(resolveMonitoringFeatureFlags({
      remoteMonitoringRequested: false,
      exportToBigqueryRequested: false,
      predictiveReliabilityRequested: false,
      backendUrl: '',
    })).toEqual({
      enableBackend: false,
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
    })).toEqual({
      enableBackend: false,
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
    })).toEqual({
      enableBackend: true,
      exportToBigquery: true,
      predictiveReliability: true,
    });
  });
});
