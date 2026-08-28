import * as path from 'path';

export const DEFAULT_BACKEND_URL =
  'https://build-process-watcher-backend-685615422311.us-central1.run.app';
export const DEFAULT_FRONTEND_BASE_URL = 'https://process-watcher.web.app';
export const DEFAULT_LOG_FILE_NAME = 'build_process_watcher.log';

export interface MonitoringFeatureFlags {
  enableBackend: boolean;
  backendUrl: string;
  frontendUrl: string;
  exportToBigquery: boolean;
  predictiveReliability: boolean;
}

export interface ActionRuntimePaths {
  runnerTempDir: string;
  logFilePath: string;
  defaultLogFile: boolean;
}

export function resolveActionRuntimePaths(inputs: {
  runId: string;
  logFileInput: string;
  workspaceDir?: string;
  runnerTempRoot: string;
  logFileExists: (candidatePath: string) => boolean;
}): ActionRuntimePaths {
  const runnerTempDir = path.join(
    inputs.runnerTempRoot,
    'build-process-watcher',
    inputs.runId
  );
  const defaultLogFile = inputs.logFileInput === DEFAULT_LOG_FILE_NAME;
  let logFilePath = defaultLogFile
    ? path.join(runnerTempDir, inputs.logFileInput)
    : !path.isAbsolute(inputs.logFileInput) && inputs.workspaceDir
      ? path.join(inputs.workspaceDir, inputs.logFileInput)
      : inputs.logFileInput;

  if (defaultLogFile && inputs.logFileExists(logFilePath)) {
    const logDir = path.dirname(logFilePath);
    logFilePath = path.join(logDir, `build_process_watcher-${inputs.runId}.log`);
  }

  return {
    runnerTempDir,
    logFilePath,
    defaultLogFile,
  };
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
  backendUrl?: string;
  frontendUrl?: string;
  runId: string;
}): MonitoringFeatureFlags {
  const enableBackend =
    inputs.remoteMonitoringRequested || inputs.predictiveReliabilityRequested;

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
      (inputs.exportToBigqueryRequested || inputs.predictiveReliabilityRequested) && useBackend,
    predictiveReliability: inputs.predictiveReliabilityRequested && useBackend,
  };
}
