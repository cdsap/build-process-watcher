export interface MonitoringFeatureFlags {
  enableBackend: boolean;
  exportToBigquery: boolean;
  predictiveReliability: boolean;
}

export function resolveMonitoringFeatureFlags(inputs: {
  remoteMonitoringRequested: boolean;
  exportToBigqueryRequested: boolean;
  predictiveReliabilityRequested: boolean;
  backendUrl: string;
}): MonitoringFeatureFlags {
  const enableBackend = inputs.remoteMonitoringRequested || inputs.predictiveReliabilityRequested;
  const useBackend = enableBackend && !!inputs.backendUrl;

  return {
    enableBackend,
    exportToBigquery: (inputs.exportToBigqueryRequested || inputs.predictiveReliabilityRequested) && useBackend,
    predictiveReliability: inputs.predictiveReliabilityRequested && useBackend,
  };
}
