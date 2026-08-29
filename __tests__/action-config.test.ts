import * as path from 'path';
import {
  DEFAULT_LOG_FILE_NAME,
  resolveActionLogFileTarget,
} from '../src/action_config';

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
