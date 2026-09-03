/**
 * Resolve how to launch monitor_with_backend.sh.
 *
 * Windows cannot execute shebang .sh files via child_process.spawn (EFTYPE).
 * GitHub Actions Windows runners include Git Bash on PATH, so invoke via bash.
 */
export function resolveMonitorSpawnInvocation(
  scriptPath: string,
  scriptArgs: string[],
  platform: NodeJS.Platform = process.platform
): { command: string; args: string[] } {
  if (platform === 'win32') {
    return {
      command: 'bash',
      args: [scriptPath, ...scriptArgs],
    };
  }
  return {
    command: scriptPath,
    args: scriptArgs,
  };
}

export function shouldMakeScriptExecutable(
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform !== 'win32';
}
