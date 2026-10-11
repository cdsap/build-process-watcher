import * as fs from 'fs';

export type RunIdentitySource = 'environment' | 'backup-file' | 'debug-log' | 'github-run';

export interface RunIdentityResolution {
  runId?: string;
  source?: RunIdentitySource;
}

export interface RunIdentityCandidates {
  environmentRunId?: string;
  backupFiles?: string[];
  debugLogFile?: string;
  githubRunId?: string;
  readFile?: (file: string) => string;
}

const VALID_GITHUB_RUN_ID = /^(run-|build-)\d+$/;

function readFileOrUndefined(file: string, readFile: (file: string) => string): string | undefined {
  try {
    return readFile(file).trim();
  } catch {
    return undefined;
  }
}

function extractRunIdFromDebugLog(contents: string): string | undefined {
  const match = contents.match(/Run ID:\s*(run-\d+)/i) ||
    contents.match(/run_id[":\s]+(run-\d+)/i) ||
    contents.match(/Run ID:\s*(build-\d+)/i);
  return match?.[1];
}

export function resolveRunIdentity(candidates: RunIdentityCandidates): RunIdentityResolution {
  if (candidates.environmentRunId) {
    return { runId: candidates.environmentRunId, source: 'environment' };
  }

  const readFile = candidates.readFile || (file => fs.readFileSync(file, 'utf8'));
  for (const file of candidates.backupFiles || []) {
    const runId = readFileOrUndefined(file, readFile);
    if (runId) {
      return { runId, source: 'backup-file' };
    }
  }

  if (candidates.debugLogFile) {
    const contents = readFileOrUndefined(candidates.debugLogFile, readFile);
    const runId = contents ? extractRunIdFromDebugLog(contents) : undefined;
    if (runId) {
      return { runId, source: 'debug-log' };
    }
  }

  if (candidates.githubRunId && VALID_GITHUB_RUN_ID.test(candidates.githubRunId)) {
    return { runId: candidates.githubRunId, source: 'github-run' };
  }

  return {};
}
