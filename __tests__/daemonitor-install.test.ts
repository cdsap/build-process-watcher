import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getExecOutput } from '@actions/exec';
import { installDaemonitor } from '../src/lib/daemonitor_install';

jest.mock('@actions/exec', () => ({ getExecOutput: jest.fn() }));
jest.mock('@actions/core', () => ({ info: jest.fn() }));

const execute = getExecOutput as jest.MockedFunction<typeof getExecOutput>;
const result = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' });

describe('automatic Daemonitor installation', () => {
  let prefix: string;
  beforeEach(() => {
    execute.mockReset();
    prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'bpw-brew-test-'));
    fs.mkdirSync(path.join(prefix, 'bin'));
    for (const name of ['daemonitor-cli', 'daemonitor-cored']) {
      fs.writeFileSync(path.join(prefix, 'bin', name), '', { mode: 0o755 });
    }
  });
  afterEach(() => fs.rmSync(prefix, { recursive: true, force: true }));

  it('installs the formula and returns its matching CLI/core directory', async () => {
    execute.mockResolvedValueOnce(result()).mockResolvedValueOnce(result(prefix + '\n')).mockResolvedValueOnce(result('1.3.3\n'));
    await expect(installDaemonitor()).resolves.toBe(path.join(prefix, 'bin'));
    expect(execute.mock.calls[0][1]).toEqual(['install', 'cdsap/tap/daemonitor-cli']);
    expect(execute.mock.calls[1][1]).toEqual(['--prefix', 'cdsap/tap/daemonitor-cli']);
    expect(execute.mock.calls[2].slice(0, 2)).toEqual([path.join(prefix, 'bin', 'daemonitor-cli'), ['--version']]);
  });
  it('accepts later compatible 1.x releases', async () => {
    execute.mockResolvedValueOnce(result()).mockResolvedValueOnce(result(prefix)).mockResolvedValueOnce(result('1.4.0'));
    await expect(installDaemonitor()).resolves.toBe(path.join(prefix, 'bin'));
  });
  it.each(['1.0.7', '1.3.2', '2.0.0', 'dev', ''])('rejects unsupported CLI version %s', async version => {
    execute.mockResolvedValueOnce(result()).mockResolvedValueOnce(result(prefix)).mockResolvedValueOnce(result(version));
    await expect(installDaemonitor()).rejects.toThrow(/1\.3\.3/);
  });
  it('fails before starting collection if the package is incomplete', async () => {
    fs.unlinkSync(path.join(prefix, 'bin', 'daemonitor-cored'));
    execute.mockResolvedValueOnce(result()).mockResolvedValueOnce(result(prefix));
    await expect(installDaemonitor()).rejects.toThrow();
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it('reports installation failure instead of falling back to shell', async () => {
    execute.mockRejectedValueOnce(new Error('Homebrew unavailable'));
    await expect(installDaemonitor()).rejects.toThrow(/Homebrew unavailable/);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
