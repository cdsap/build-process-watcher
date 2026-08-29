import * as path from 'path';

export const DEFAULT_LOG_FILE_NAME = 'build_process_watcher.log';

export interface ActionLogFileTarget {
  runnerTempDir: string;
  logFilePath: string;
  defaultLogFile: boolean;
  collisionFallbackUsed: boolean;
}

export function resolveActionLogFileTarget(inputs: {
  logFileInput: string;
  runId: string;
  workspaceDir?: string;
  runnerTempRoot: string;
  defaultLogPathExists: boolean;
}): ActionLogFileTarget {
  const runnerTempDir = path.join(
    inputs.runnerTempRoot,
    'build-process-watcher',
    inputs.runId
  );
  const defaultLogFile = inputs.logFileInput === DEFAULT_LOG_FILE_NAME;
  const defaultLogFilePath = path.join(runnerTempDir, inputs.logFileInput);
  const collisionFallbackUsed = defaultLogFile && inputs.defaultLogPathExists;

  const logFilePath = collisionFallbackUsed
    ? path.join(runnerTempDir, `build_process_watcher-${inputs.runId}.log`)
    : defaultLogFile
      ? defaultLogFilePath
      : !path.isAbsolute(inputs.logFileInput) && inputs.workspaceDir
        ? path.join(inputs.workspaceDir, inputs.logFileInput)
        : inputs.logFileInput;

  return {
    runnerTempDir,
    logFilePath,
    defaultLogFile,
    collisionFallbackUsed,
  };
}
