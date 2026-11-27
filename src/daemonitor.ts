import * as fs from 'fs';
import { DaemonitorConfig, runDaemonitor } from './lib/daemonitor';

const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) as DaemonitorConfig;
runDaemonitor(config).catch(error => { console.error(error); process.exitCode = 1; });
