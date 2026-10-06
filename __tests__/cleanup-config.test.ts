import * as path from 'path';
import {
    resolveCleanupLogFile,
    resolveCleanupLogFileCandidates,
} from '../src/cleanup_config';

describe('cleanup log file resolution', () => {
    const logFileName = 'build_process_watcher.log';
    const actionDir = '/actions/build-process-watcher';
    const workspaceDir = '/workspace/project';
    const runnerTempRoot = '/tmp/runner';
    const runId = 'run-abc';
    const runnerTempLog = path.join(runnerTempRoot, 'build-process-watcher', runId, logFileName);
    const actionLog = path.join(actionDir, '..', logFileName);
    const workspaceLog = path.join(workspaceDir, logFileName);

    function candidates(existingCandidates: string[] = []): string[] {
        return resolveCleanupLogFileCandidates({
            logFileName,
            actionDir,
            workspaceDir,
            runnerTempRoot,
            runId,
        }).filter(candidate => existingCandidates.includes(candidate));
    }

    it('preserves an absolute custom log path', () => {
        const absoluteLog = '/var/log/build-process-watcher.log';
        const resolvedCandidates = resolveCleanupLogFileCandidates({
            logFileName: absoluteLog,
            actionDir,
            workspaceDir,
            runnerTempRoot,
            runId,
        });

        expect(resolvedCandidates).toEqual([absoluteLog]);
        expect(resolveCleanupLogFile(resolvedCandidates, [])).toBe(absoluteLog);
    });

    it('prefers the per-run runner-temp log', () => {
        const resolvedCandidates = resolveCleanupLogFileCandidates({
            logFileName,
            actionDir,
            workspaceDir,
            runnerTempRoot,
            runId,
        });

        expect(resolvedCandidates).toEqual([runnerTempLog, actionLog, workspaceLog]);
        expect(resolveCleanupLogFile(resolvedCandidates, candidates([runnerTempLog, actionLog]))).toBe(runnerTempLog);
    });

    it('falls back to the action-directory log when it exists', () => {
        const resolvedCandidates = resolveCleanupLogFileCandidates({
            logFileName,
            actionDir,
            workspaceDir,
            runnerTempRoot,
            runId,
        });

        expect(resolveCleanupLogFile(resolvedCandidates, candidates([actionLog]))).toBe(actionLog);
    });

    it('falls back to the workspace log when it exists', () => {
        const resolvedCandidates = resolveCleanupLogFileCandidates({
            logFileName,
            actionDir,
            workspaceDir,
            runnerTempRoot,
            runId,
        });

        expect(resolveCleanupLogFile(resolvedCandidates, candidates([workspaceLog]))).toBe(workspaceLog);
    });

    it('uses the first candidate when no candidate exists', () => {
        const resolvedCandidates = resolveCleanupLogFileCandidates({
            logFileName,
            actionDir,
            workspaceDir,
            runnerTempRoot,
            runId,
        });

        expect(resolveCleanupLogFile(resolvedCandidates, [])).toBe(runnerTempLog);
    });
});
