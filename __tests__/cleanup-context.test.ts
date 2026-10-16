import * as path from 'path';
import { resolveCleanupLogFile } from '../src/cleanup_context';

describe('cleanup log file resolution', () => {
    const logFileName = 'build_process_watcher.log';
    const actionDir = '/actions/build-process-watcher';
    const workspaceDir = '/workspace/project';
    const runnerTempRoot = '/tmp/runner';
    const runId = 'run-abc';
    const runnerTempLog = path.join(runnerTempRoot, 'build-process-watcher', runId, logFileName);
    const actionLog = path.join(actionDir, '..', logFileName);
    const workspaceLog = path.join(workspaceDir, logFileName);

    function resolve(existing: string[] = []): string {
        return resolveCleanupLogFile({
            logFileName,
            actionDir,
            workspaceDir,
            runnerTempRoot,
            runId,
            exists: candidate => existing.includes(candidate),
        });
    }

    it('preserves an absolute custom log path', () => {
        const absoluteLog = '/var/log/build-process-watcher.log';

        expect(resolveCleanupLogFile({
            logFileName: absoluteLog,
            actionDir,
            workspaceDir,
            runnerTempRoot,
            runId,
            exists: () => false,
        })).toBe(absoluteLog);
    });

    it('prefers the per-run runner-temp log', () => {
        expect(resolve([runnerTempLog, actionLog])).toBe(runnerTempLog);
    });

    it('falls back to the action-directory log when it exists', () => {
        expect(resolve([actionLog])).toBe(actionLog);
    });

    it('falls back to the workspace log when it exists', () => {
        expect(resolve([workspaceLog])).toBe(workspaceLog);
    });

    it('uses the first candidate when no candidate exists', () => {
        expect(resolve()).toBe(runnerTempLog);
    });
});
