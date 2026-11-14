import * as fs from 'fs';
import * as path from 'path';

export function existingArtifactPaths(candidates: string[]): string[] {
    return candidates
        .map(candidate => path.resolve(candidate))
        .filter(candidate => fs.existsSync(candidate));
}

/**
 * Resolve monitor debug logs written by monitor_with_backend.sh.
 * Prefer the directory of LOG_FILE (where the monitor now writes them),
 * then fall back to action checkout roots used by older runs.
 */
export function resolveMonitorDebugLogPaths(options: {
    logFile?: string | null;
    actionPath?: string | null;
    actionBundleDir?: string | null;
    cwd?: string | null;
}): { backendDebugLog: string | null; scriptDebugLog: string | null } {
    const dirs: string[] = [];
    const pushDir = (value?: string | null) => {
        if (!value) return;
        const resolved = path.resolve(value);
        if (!dirs.includes(resolved)) dirs.push(resolved);
    };

    if (options.logFile) pushDir(path.dirname(path.resolve(options.logFile)));
    pushDir(options.actionPath || undefined);
    if (options.actionPath) pushDir(path.join(options.actionPath, '..'));
    if (options.actionBundleDir) {
        pushDir(options.actionBundleDir);
        pushDir(path.join(options.actionBundleDir, '..'));
    }
    pushDir(options.cwd || undefined);

    let backendDebugLog: string | null = null;
    let scriptDebugLog: string | null = null;
    for (const dir of dirs) {
        const backend = path.join(dir, 'backend_debug.log');
        const script = path.join(dir, 'script_debug.log');
        if (!backendDebugLog && fs.existsSync(backend)) backendDebugLog = backend;
        if (!scriptDebugLog && fs.existsSync(script)) scriptDebugLog = script;
        if (backendDebugLog && scriptDebugLog) break;
    }
    return { backendDebugLog, scriptDebugLog };
}

export function artifactSummary(name: string, files: string[]): string {
    const charts = files
        .filter(file => path.extname(file) === '.svg')
        .map(file => `\`${path.basename(file)}\``);
    const chartDetails = charts.length > 0 ? ` Charts: ${charts.join(', ')}.` : '';

    return `> Archived ${files.length} result files in artifact \`${name}\`.${chartDetails}`;
}
