export const DEFAULT_BACKEND_URL =
  'https://build-process-watcher-backend-685615422311.us-central1.run.app';
export const DEFAULT_FRONTEND_BASE_URL = 'https://process-watcher.web.app';
export { DEFAULT_LOG_FILE_NAME } from './action_config';

export type PredictionMode = 'disabled' | 'forecast' | 'predict' | 'bqml-boosted';

const VALID_MODES: PredictionMode[] = ['disabled', 'forecast', 'predict', 'bqml-boosted'];
export const DEFAULT_PREDICTION_THROTTLE_S = 20;
const MAX_PREDICTION_THROTTLE_S = 3600;

export function resolvePredictionMode(mode: string): PredictionMode {
  if (!mode) return 'disabled';
  if (!VALID_MODES.includes(mode as PredictionMode)) {
    throw new Error('Invalid prediction_mode; expected disabled, forecast, predict, or bqml-boosted');
  }
  return mode as PredictionMode;
}

export function resolvePredictionThrottleS(raw: string | undefined): number {
  const value = (raw ?? '').trim();
  if (!value) return DEFAULT_PREDICTION_THROTTLE_S;
  if (!/^\d+$/.test(value)) {
    throw new Error(
      `Invalid prediction_throttle_s; expected integer seconds from 1 to ${MAX_PREDICTION_THROTTLE_S}`,
    );
  }
  const seconds = Number(value);
  if (seconds < 1 || seconds > MAX_PREDICTION_THROTTLE_S) {
    throw new Error(
      `Invalid prediction_throttle_s; expected integer seconds from 1 to ${MAX_PREDICTION_THROTTLE_S}`,
    );
  }
  return seconds;
}

export interface MonitoringFeatureFlags {
  enableBackend: boolean;
  backendUrl: string;
  frontendUrl: string;
  exportToBigquery: boolean;
  predictionMode: PredictionMode;
  predictionThrottleS: number;
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
  predictionThrottleS?: string;
  backendUrl?: string;
  frontendUrl?: string;
  runId: string;
}): MonitoringFeatureFlags {
  const predictionMode = resolvePredictionMode(inputs.predictionMode || '');
  const predictionThrottleS = resolvePredictionThrottleS(inputs.predictionThrottleS);
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
    predictionThrottleS,
    freshnessDiagnostics: inputs.freshnessDiagnosticsRequested === true && useBackend,
  };
}
