import * as path from 'path';

export interface CleanupLogFileResolutionInputs {
    logFileName: string;
    actionDir: string;
    workspaceDir?: string;
    runnerTempRoot?: string;
    runId?: string;
    exists: (filePath: string) => boolean;
}

export function resolveCleanupLogFile(inputs: CleanupLogFileResolutionInputs): string {
    const candidates = resolveCleanupLogFileCandidates(inputs);
    return candidates.find(candidate => inputs.exists(candidate)) || candidates[0];
}

function resolveCleanupLogFileCandidates(inputs: CleanupLogFileResolutionInputs): string[] {
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
