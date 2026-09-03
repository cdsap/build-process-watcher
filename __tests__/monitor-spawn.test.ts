import {
  resolveMonitorSpawnInvocation,
  shouldMakeScriptExecutable,
} from '../src/monitor_spawn';

describe('resolveMonitorSpawnInvocation', () => {
  it('spawns the shell script directly on unix platforms', () => {
    expect(
      resolveMonitorSpawnInvocation(
        '/actions/monitor_with_backend.sh',
        ['5', 'https://backend.example', 'run-1'],
        'linux'
      )
    ).toEqual({
      command: '/actions/monitor_with_backend.sh',
      args: ['5', 'https://backend.example', 'run-1'],
    });

    expect(
      resolveMonitorSpawnInvocation(
        '/actions/monitor_with_backend.sh',
        ['5'],
        'darwin'
      )
    ).toEqual({
      command: '/actions/monitor_with_backend.sh',
      args: ['5'],
    });
  });

  it('invokes bash with the script path on Windows to avoid spawn EFTYPE', () => {
    const scriptPath =
      'D:\\a\\_actions\\cdsap\\build-process-watcher\\v0.6.2\\monitor_with_backend.sh';

    expect(
      resolveMonitorSpawnInvocation(scriptPath, ['5', 'https://backend.example', 'run-1'], 'win32')
    ).toEqual({
      command: 'bash',
      args: [scriptPath, '5', 'https://backend.example', 'run-1'],
    });
  });
});

describe('shouldMakeScriptExecutable', () => {
  it('skips chmod on Windows where bash launches the script', () => {
    expect(shouldMakeScriptExecutable('win32')).toBe(false);
    expect(shouldMakeScriptExecutable('linux')).toBe(true);
    expect(shouldMakeScriptExecutable('darwin')).toBe(true);
  });
});
