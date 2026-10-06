import * as path from 'path';

export function resolveCleanupLogFileCandidates(inputs: {
    logFileName: string;
    actionDir: string;
    workspaceDir?: string;
    runnerTempRoot?: string;
    runId?: string;
}): string[] {
    if (path.isAbsolute(inputs.logFileName)) {
        return [inputs.logFileName];
    }

    const runTempDir = inputs.runnerTempRoot && inputs.runId
        ? path.join(inputs.runnerTempRoot, 'build-process-watcher', inputs.runId)
        : '';

    return [
        runTempDir ? path.join(runTempDir, inputs.logFileName) : '',
        path.join(inputs.actionDir, '..', inputs.logFileName),
        inputs.workspaceDir ? path.join(inputs.workspaceDir, inputs.logFileName) : '',
    ].filter((candidate): candidate is string => Boolean(candidate));
}

export function resolveCleanupLogFile(
    candidates: string[],
    existingCandidates: string[],
): string {
    return candidates.find(candidate => existingCandidates.includes(candidate)) || candidates[0];
}
