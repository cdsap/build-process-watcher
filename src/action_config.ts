import * as path from 'path';

export const DEFAULT_LOG_FILE_NAME = 'build_process_watcher.log';
const ACTION_RUNTIME_TEMP_DIR_NAME = 'build-process-watcher';

export const ACTION_RUNTIME_STATE_FILES = {
  runId: '.build-process-watcher-run-id',
  backendUrl: '.build-process-watcher-backend-url',
  frontendUrl: '.build-process-watcher-frontend-url',
} as const;

export const ACTION_RUNTIME_STATE_FILE_NAMES = [
  ACTION_RUNTIME_STATE_FILES.backendUrl,
  ACTION_RUNTIME_STATE_FILES.frontendUrl,
  ACTION_RUNTIME_STATE_FILES.runId,
] as const;

export interface ActionLogFileTarget {
  runnerTempDir: string;
  logFilePath: string;
  defaultLogFile: boolean;
  collisionFallbackUsed: boolean;
}

export interface ActionRuntimeStatePaths {
  runnerTempDir: string;
  runIdFile: string;
  backendUrlFile: string;
  frontendUrlFile: string;
}

export function getActionRuntimeTempRoot(runnerTempRoot: string): string {
  return path.join(runnerTempRoot, ACTION_RUNTIME_TEMP_DIR_NAME);
}

export function getActionRunTempDir(runnerTempRoot: string, runId: string): string {
  return path.join(getActionRuntimeTempRoot(runnerTempRoot), runId);
}

export function resolveActionRuntimeStatePaths(inputs: {
  runnerTempRoot: string;
  runId: string;
}): ActionRuntimeStatePaths {
  const runnerTempDir = getActionRunTempDir(inputs.runnerTempRoot, inputs.runId);

  return {
    runnerTempDir,
    runIdFile: path.join(runnerTempDir, ACTION_RUNTIME_STATE_FILES.runId),
    backendUrlFile: path.join(runnerTempDir, ACTION_RUNTIME_STATE_FILES.backendUrl),
    frontendUrlFile: path.join(runnerTempDir, ACTION_RUNTIME_STATE_FILES.frontendUrl),
  };
}

export function actionRuntimeStateFilePath(dir: string, fileName: string): string {
  return path.join(dir, fileName);
}

export function resolveActionRuntimeStateCandidateDirs(inputs: {
  cwd: string;
  workspaceDir?: string;
  runnerTempRoot?: string;
  runId?: string;
  includeRunnerTempRoot?: boolean;
}): string[] {
  const runTempDir = inputs.runnerTempRoot && inputs.runId
    ? getActionRunTempDir(inputs.runnerTempRoot, inputs.runId)
    : '';
  const candidateDirs = [
    inputs.cwd,
    inputs.workspaceDir,
    inputs.includeRunnerTempRoot ? inputs.runnerTempRoot : '',
    runTempDir,
  ];

  return candidateDirs.filter((dir): dir is string => Boolean(dir));
}

export function resolveRunIdBackupCandidateFiles(inputs: {
  cwd: string;
  workspaceDir?: string;
  runnerTempRoot?: string;
  runnerTempRunEntries?: string[];
}): string[] {
  const runtimeTempRoot = inputs.runnerTempRoot
    ? getActionRuntimeTempRoot(inputs.runnerTempRoot)
    : '';
  const tempRunIdFiles = runtimeTempRoot
    ? (inputs.runnerTempRunEntries || []).map(entry =>
        path.join(runtimeTempRoot, entry, ACTION_RUNTIME_STATE_FILES.runId)
      )
    : [];
  const candidateFiles = [
    path.join(inputs.cwd, ACTION_RUNTIME_STATE_FILES.runId),
    inputs.workspaceDir ? path.join(inputs.workspaceDir, ACTION_RUNTIME_STATE_FILES.runId) : '',
    ...tempRunIdFiles,
  ];

  return candidateFiles.filter((file): file is string => Boolean(file));
}

export function resolveActionLogFileTarget(inputs: {
  logFileInput: string;
  runId: string;
  workspaceDir?: string;
  runnerTempRoot: string;
  defaultLogPathExists: boolean;
}): ActionLogFileTarget {
  const runnerTempDir = getActionRunTempDir(inputs.runnerTempRoot, inputs.runId);
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
