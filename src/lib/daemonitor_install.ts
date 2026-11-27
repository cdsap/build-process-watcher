import * as fs from 'fs';
import * as path from 'path';
import * as core from '@actions/core';
import { getExecOutput } from '@actions/exec';

export async function installDaemonitor(): Promise<string> {
    // Homebrew is preinstalled on GitHub-hosted runners but Ubuntu omits it from PATH.
    const brew = [...(process.env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, 'brew')),
        '/home/linuxbrew/.linuxbrew/bin/brew', '/opt/homebrew/bin/brew', '/usr/local/bin/brew']
        .find(file => fs.existsSync(file)) || 'brew';
    core.info('Installing Daemonitor CLI with Homebrew');
    try {
        await getExecOutput(brew, ['install', 'cdsap/tap/daemonitor-cli']);
    } catch (error) {
        throw new Error(`Daemonitor installation failed. Homebrew must be available on the runner, or set daemonitor_bin_dir. ${error instanceof Error ? error.message : error}`);
    }
    const prefix = await getExecOutput(brew, ['--prefix', 'cdsap/tap/daemonitor-cli'], { silent: true });
    if (!prefix.stdout.trim()) throw new Error('Homebrew returned an empty Daemonitor installation prefix');
    const binDir = path.join(prefix.stdout.trim(), 'bin');
    for (const name of ['daemonitor-cli', 'daemonitor-cored']) {
        fs.accessSync(path.join(binDir, name), fs.constants.X_OK);
    }
    const output = await getExecOutput(path.join(binDir, 'daemonitor-cli'), ['--version'], { silent: true });
    const version = output.stdout.trim();
    const match = /^1\.(\d+)\.(\d+)$/.exec(version);
    if (!match || Number(match[1]) < 3 || (Number(match[1]) === 3 && Number(match[2]) < 3)) {
        throw new Error('Daemonitor CLI 1.3.3 or later within 1.x is required. Update the Homebrew tap and upgrade daemonitor-cli.');
    }
    core.info(`Using Daemonitor CLI ${version} from ${binDir}`);
    return binDir;
}
