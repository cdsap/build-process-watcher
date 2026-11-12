export const DEFAULT_BACKEND_URL =
  'https://build-process-watcher-backend-685615422311.us-central1.run.app';
export const DEFAULT_FRONTEND_BASE_URL = 'https://process-watcher.web.app';
export { DEFAULT_LOG_FILE_NAME } from './action_config';

export type PredictionMode = 'disabled' | 'reliability' | 'forecast' | 'predict';

export function resolvePredictionMode(mode: string, legacy: boolean): PredictionMode {
  if (!mode) return legacy ? 'reliability' : 'disabled';
  if (!['disabled', 'reliability', 'forecast', 'predict'].includes(mode)) {
    throw new Error('Invalid prediction_mode; expected disabled, reliability, forecast, or predict');
  }
  if (legacy && mode !== 'reliability') {
    throw new Error('predictive_reliability=true conflicts with prediction_mode');
  }
  return mode as PredictionMode;
}

export interface MonitoringFeatureFlags {
  enableBackend: boolean;
  backendUrl: string;
  frontendUrl: string;
  exportToBigquery: boolean;
  predictiveReliability: boolean;
  predictionMode: PredictionMode;
}

function buildFrontendRunUrl(frontendBaseUrl: string, runId: string): string {
  if (frontendBaseUrl.endsWith('/runs') || frontendBaseUrl.endsWith('/runs/')) {
    return `${frontendBaseUrl}/${runId}`;
  }
  return `${frontendBaseUrl}/runs/${runId}`;
}

export function resolveMonitoringFeatureFlags(inputs: {
  remoteMonitoringRequested: boolean;
  exportToBigqueryRequested: boolean;
  predictiveReliabilityRequested: boolean;
  predictionMode?: string;
  backendUrl?: string;
  frontendUrl?: string;
  runId: string;
}): MonitoringFeatureFlags {
  const predictionMode = resolvePredictionMode(inputs.predictionMode || '', inputs.predictiveReliabilityRequested);
  const enableBackend = inputs.remoteMonitoringRequested || predictionMode !== 'disabled';

  let backendUrl = inputs.backendUrl || '';
  if (enableBackend && !backendUrl) {
    backendUrl = DEFAULT_BACKEND_URL;
  }

  const useBackend = enableBackend && !!backendUrl;

  let frontendUrl = '';
  if (useBackend) {
    const explicitFrontendUrl = inputs.frontendUrl || '';
    if (explicitFrontendUrl) {
      frontendUrl = buildFrontendRunUrl(explicitFrontendUrl, inputs.runId);
    } else {
      frontendUrl = buildFrontendRunUrl(DEFAULT_FRONTEND_BASE_URL, inputs.runId);
    }
  }

  return {
    enableBackend,
    backendUrl,
    frontendUrl,
    exportToBigquery:
      (inputs.exportToBigqueryRequested || predictionMode === 'reliability') && useBackend,
    predictiveReliability: predictionMode === 'reliability' && useBackend,
    predictionMode,
  };
}
