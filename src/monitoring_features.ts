export const DEFAULT_BACKEND_URL =
  'https://build-process-watcher-backend-685615422311.us-central1.run.app';
export const DEFAULT_FRONTEND_BASE_URL = 'https://process-watcher.web.app';
export { DEFAULT_LOG_FILE_NAME } from './action_config';

export type PredictionMode = 'disabled' | 'forecast' | 'predict' | 'bqml-boosted';

const VALID_MODES: PredictionMode[] = ['disabled', 'forecast', 'predict', 'bqml-boosted'];

export function resolvePredictionMode(mode: string): PredictionMode {
  if (!mode) return 'disabled';
  if (!VALID_MODES.includes(mode as PredictionMode)) {
    throw new Error('Invalid prediction_mode; expected disabled, forecast, predict, or bqml-boosted');
  }
  return mode as PredictionMode;
}

export interface MonitoringFeatureFlags {
  enableBackend: boolean;
  backendUrl: string;
  frontendUrl: string;
  exportToBigquery: boolean;
  predictionMode: PredictionMode;
  freshnessDiagnostics: boolean;
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
  freshnessDiagnosticsRequested?: boolean;
  predictionMode?: string;
  backendUrl?: string;
  frontendUrl?: string;
  runId: string;
}): MonitoringFeatureFlags {
  const predictionMode = resolvePredictionMode(inputs.predictionMode || '');
  const enableBackend =
    inputs.remoteMonitoringRequested ||
    predictionMode !== 'disabled' ||
    inputs.freshnessDiagnosticsRequested === true;

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
    exportToBigquery: inputs.exportToBigqueryRequested && useBackend,
    predictionMode,
    freshnessDiagnostics: inputs.freshnessDiagnosticsRequested === true && useBackend,
  };
}
