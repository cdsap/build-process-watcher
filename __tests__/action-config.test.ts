import * as path from 'path';
import {
  ACTION_RUNTIME_STATE_FILE_NAMES,
  ACTION_RUNTIME_STATE_FILES,
  DEFAULT_LOG_FILE_NAME,
  getActionRunTempDir,
  resolveActionRuntimeStateCandidateDirs,
  resolveActionRuntimeStatePaths,
  resolveActionLogFileTarget,
  resolveRunIdBackupCandidateFiles,
} from '../src/action_config';

describe('action runtime state paths', () => {
  const runId = 'run-abc';
  const runnerTempRoot = '/tmp/runner';
  const workspaceDir = '/workspace/project';
  const cwd = '/actions/work/build-process-watcher';
  const runnerTempDir = path.join(runnerTempRoot, 'build-process-watcher', runId);

  it('builds the per-run temp directory under RUNNER_TEMP/build-process-watcher/<runId>', () => {
    expect(getActionRunTempDir(runnerTempRoot, runId)).toBe(runnerTempDir);
  });

  it('exposes the hidden state filenames used by action and cleanup steps', () => {
    expect(ACTION_RUNTIME_STATE_FILES).toEqual({
      runId: '.build-process-watcher-run-id',
      backendUrl: '.build-process-watcher-backend-url',
      frontendUrl: '.build-process-watcher-frontend-url',
    });
    expect(ACTION_RUNTIME_STATE_FILE_NAMES).toEqual([
      '.build-process-watcher-backend-url',
      '.build-process-watcher-frontend-url',
      '.build-process-watcher-run-id',
    ]);
  });

  it('resolves all per-run runtime state file paths', () => {
    expect(resolveActionRuntimeStatePaths({ runnerTempRoot, runId })).toEqual({
      runnerTempDir,
      runIdFile: path.join(runnerTempDir, '.build-process-watcher-run-id'),
      backendUrlFile: path.join(runnerTempDir, '.build-process-watcher-backend-url'),
      frontendUrlFile: path.join(runnerTempDir, '.build-process-watcher-frontend-url'),
    });
  });

  it('preserves cleanup candidate directory order without the runner temp root by default', () => {
    expect(resolveActionRuntimeStateCandidateDirs({
      cwd,
      workspaceDir,
      runnerTempRoot,
      runId,
    })).toEqual([
      cwd,
      workspaceDir,
      runnerTempDir,
    ]);
  });

  it('includes the runner temp root when resolving state cleanup candidate directories', () => {
    expect(resolveActionRuntimeStateCandidateDirs({
      cwd,
      workspaceDir,
      runnerTempRoot,
      runId,
      includeRunnerTempRoot: true,
    })).toEqual([
      cwd,
      workspaceDir,
      runnerTempRoot,
      runnerTempDir,
    ]);
  });

  it('omits per-run and runner temp candidates when runtime inputs are absent', () => {
    expect(resolveActionRuntimeStateCandidateDirs({
      cwd,
      workspaceDir,
      includeRunnerTempRoot: true,
    })).toEqual([
      cwd,
      workspaceDir,
    ]);
  });

  it('resolves run-id backup candidate files from cwd, workspace, and per-run temp entries', () => {
    expect(resolveRunIdBackupCandidateFiles({
      cwd,
      workspaceDir,
      runnerTempRoot,
      runnerTempRunEntries: ['run-1', 'run-2'],
    })).toEqual([
      path.join(cwd, '.build-process-watcher-run-id'),
      path.join(workspaceDir, '.build-process-watcher-run-id'),
      path.join(runnerTempRoot, 'build-process-watcher', 'run-1', '.build-process-watcher-run-id'),
      path.join(runnerTempRoot, 'build-process-watcher', 'run-2', '.build-process-watcher-run-id'),
    ]);
  });

  it('resolves only cwd run-id backup candidate when optional locations are absent', () => {
    expect(resolveRunIdBackupCandidateFiles({
      cwd,
    })).toEqual([
      path.join(cwd, '.build-process-watcher-run-id'),
    ]);
  });
});

describe('resolveActionLogFileTarget', () => {
  const runId = 'run-abc';
  const runnerTempRoot = '/tmp/runner';
  const workspaceDir = '/workspace/project';
  const runnerTempDir = path.join(runnerTempRoot, 'build-process-watcher', runId);

  it('places the default log file under RUNNER_TEMP/build-process-watcher/<runId>', () => {
    expect(resolveActionLogFileTarget({
      runId,
      logFileInput: DEFAULT_LOG_FILE_NAME,
      workspaceDir,
      runnerTempRoot,
      defaultLogPathExists: false,
    })).toEqual({
      runnerTempDir,
      logFilePath: path.join(runnerTempDir, DEFAULT_LOG_FILE_NAME),
      defaultLogFile: true,
      collisionFallbackUsed: false,
    });
  });

  it('suffixes the default log file with the run id when that path already exists', () => {
    expect(resolveActionLogFileTarget({
      runId,
      logFileInput: DEFAULT_LOG_FILE_NAME,
      workspaceDir,
      runnerTempRoot,
      defaultLogPathExists: true,
    })).toEqual({
      runnerTempDir,
      logFilePath: path.join(runnerTempDir, `build_process_watcher-${runId}.log`),
      defaultLogFile: true,
      collisionFallbackUsed: true,
    });
  });

  it('preserves an absolute custom log path', () => {
    const absoluteLog = '/var/log/bpw/custom.log';

    expect(resolveActionLogFileTarget({
      runId,
      logFileInput: absoluteLog,
      workspaceDir,
      runnerTempRoot,
      defaultLogPathExists: true,
    })).toEqual({
      runnerTempDir,
      logFilePath: absoluteLog,
      defaultLogFile: false,
      collisionFallbackUsed: false,
    });
  });

  it('resolves a workspace-relative custom log path against GITHUB_WORKSPACE', () => {
    expect(resolveActionLogFileTarget({
      runId,
      logFileInput: 'logs/custom.log',
      workspaceDir,
      runnerTempRoot,
      defaultLogPathExists: true,
    })).toEqual({
      runnerTempDir,
      logFilePath: path.join(workspaceDir, 'logs/custom.log'),
      defaultLogFile: false,
      collisionFallbackUsed: false,
    });
  });

  it('leaves a relative custom log path relative when GITHUB_WORKSPACE is unset', () => {
    expect(resolveActionLogFileTarget({
      runId,
      logFileInput: 'logs/custom.log',
      runnerTempRoot,
      defaultLogPathExists: true,
    })).toEqual({
      runnerTempDir,
      logFilePath: 'logs/custom.log',
      defaultLogFile: false,
      collisionFallbackUsed: false,
    });
  });
});
