import { MetricMeasurements } from './log_samples';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import { createHash } from 'crypto';
import { spawn, ChildProcess, execFileSync } from 'child_process';
import { createInterface } from 'readline';

export const DAEMONITOR_HEADER = 'Elapsed_Time | PID | Name | Heap_Used_MB | Heap_Capacity_MB | RSS_MB | GC_Time_S | JIT_Compiled | JIT_Failed | JIT_Invalid | JIT_Time_S | Classes_Loaded | Classes_Unloaded | Class_Time_S';
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const numeric = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const metricTime = (value: unknown): value is number => numeric(value) && Number.isSafeInteger(value) && value > 0;
const names: Record<string, string> = { GRADLE_DAEMON: 'GradleDaemon', KOTLIN_DAEMON: 'KotlinCompileDaemon',
    GRADLE_WORKER: 'GradleWorkerMain', TEST_WORKER: 'GradleWorkerMain', UNKNOWN_GRADLE_WORKER: 'GradleWorkerMain' };

export function resolveCollector(value: string, binDir: string): { kind: 'shell' } | { kind: 'daemonitor'; binDir: string } {
    if (!value || value === 'shell') return { kind: 'shell' };
    if (value !== 'daemonitor') throw new Error('collector must be shell or daemonitor');
    if (!binDir) throw new Error('daemonitor_bin_dir is required for collector=daemonitor');
    if (process.platform === 'win32') throw new Error('The Daemonitor BPW collector currently supports Linux and macOS');
    const absolute = path.resolve(binDir);
    for (const file of ['daemonitor-cli', 'daemonitor-cored']) fs.accessSync(path.join(absolute, file), fs.constants.X_OK);
    return { kind: 'daemonitor', binDir: absolute };
}

export interface NativeProcess {
    jvm_sampled_at_ms?: { jit?: number; classes?: number } | null;
    pid: number; start_time_ms: number; sampled_at_ms: number; type: string;
    resident_bytes?: number | null; rss_memory_mb?: number | null;
    heap_available?: boolean; heap_used_mb?: number | null; heap_committed_mb?: number | null;
    young_gc_time_seconds?: number | null; full_gc_time_seconds?: number | null;
    jit?: { compiled_count?: number | null; failed_count?: number | null; invalid_count?: number | null; compilation_time_seconds?: number | null } | null;
    classes?: { loaded?: number | null; unloaded_total?: number | null; time_seconds?: number | null } | null;
}
export interface NativeSnapshot { processes: NativeProcess[] | null; [key: string]: unknown }
export function encodeSnapshot(snapshot: NativeSnapshot, startedAtMs: number, seen: Map<number, { start: number; at: number }>) {
    const lines: string[] = [];
    const measurements: MetricMeasurements[] = [];
    let incomplete = 0;
    if (snapshot.processes === null) return { lines, incomplete, measurements };
    if (!Array.isArray(snapshot.processes)) throw new Error('Invalid Daemonitor snapshot');
    for (const p of snapshot.processes) {
        const name = names[p.type];
        if (!name) continue;
        if (![p.pid, p.start_time_ms, p.sampled_at_ms].every(v => Number.isSafeInteger(v) && v > 0)) throw new Error('Invalid Daemonitor process identity');
        if (p.sampled_at_ms < startedAtMs) continue;
        const previous = seen.get(p.pid);
        if (previous && previous.start !== p.start_time_ms) throw new Error(`PID reuse cannot be represented in the BPW artifact: ${p.pid}`);
        if (previous && p.sampled_at_ms <= previous.at) continue;
        seen.set(p.pid, { start: p.start_time_ms, at: p.sampled_at_ms });
        const rss = numeric(p.resident_bytes) ? p.resident_bytes / 1048576 : p.rss_memory_mb;
        // The current backend requires numeric heap. Keep pending/unavailable rows in raw capture only.
        if (!p.heap_available || ![p.heap_used_mb, p.heap_committed_mb, rss].every(numeric)) { incomplete++; continue; }
        const seconds = Math.floor((p.sampled_at_ms - startedAtMs) / 1000);
        const elapsed = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(v => String(v).padStart(2, '0')).join(':');
        const mem = (v: unknown) => numeric(v) ? `${v.toFixed(1)}MB` : 'N/A';
        const opt = (v: unknown) => numeric(v) ? String(v) : 'N/A';
        const gc = numeric(p.young_gc_time_seconds) && numeric(p.full_gc_time_seconds)
            ? `${(p.young_gc_time_seconds + p.full_gc_time_seconds).toFixed(3)}s` : 'N/A';
        lines.push([elapsed, p.pid, name, mem(p.heap_used_mb), mem(p.heap_committed_mb), mem(rss), gc,
            opt(p.jit?.compiled_count), opt(p.jit?.failed_count), opt(p.jit?.invalid_count), opt(p.jit?.compilation_time_seconds),
            opt(p.classes?.loaded), opt(p.classes?.unloaded_total), opt(p.classes?.time_seconds)].join(' | '));
        const times = p.jvm_sampled_at_ms;
        measurements.push({ process_start_time_ms: p.start_time_ms,
            ...(metricTime(times?.jit) ? { jit_sampled_at_ms: times.jit } : {}),
            ...(metricTime(times?.classes) ? { classes_sampled_at_ms: times.classes } : {}) });
    }
    return { lines, incomplete, measurements };
}

export interface MetricRequest {
    run_id: string;
    data: string;
    metric_measurements?: MetricMeasurements;
    freshness?: { sample_id: string; sequence: number; collected_at_unix_ms: number };
}
export function metricRequests(runId: string, lines: string[], freshness?: {
    startedAtMs: number; collectedAtMs: number; sequence: number;
}, measurements?: MetricMeasurements[]): MetricRequest[] {
    if (!lines.length) return [];
    if (measurements && measurements.length !== lines.length) throw new Error('Metric measurement count must match sample count');
    if (!freshness && !measurements) return [{ run_id: runId, data: lines.join('\n') }];
    // The backend accepts freshness metadata for exactly one sample per request.
    return lines.map((data, index) => {
        const sequence = (freshness?.sequence ?? 0) + index + 1;
        return { run_id: runId, data,
            ...(measurements ? { metric_measurements: measurements[index] } : {}),
            ...(freshness ? { freshness: { sample_id: `${freshness.startedAtMs}-${sequence}`,
                sequence, collected_at_unix_ms: freshness.collectedAtMs } } : {}) };
    });
}

export interface FlagMetadata { availability: string; flags: Record<string, { type: string; value: string }>; [key: string]: unknown }
export function vmFlags(metadata: FlagMetadata): string[] {
    if (metadata.availability !== 'available') return [];
    return Object.entries(metadata.flags).flatMap(([name, flag]) => {
        if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) return [];
        if (flag.type === 'bool' && ['true', 'false'].includes(flag.value)) return [`-XX:${flag.value === 'true' ? '+' : '-'}${name}`];
        if (flag.type !== 'bool' && flag.type !== 'ccstr' && /^[+-]?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(flag.value)) return [`-XX:${name}=${flag.value}`];
        return [];
    });
}

export interface DaemonitorConfig {
    stateDir: string; binDir: string; logFile: string; runId: string; interval: number;
    backendUrl: string; exportToBigquery: boolean; predictionMode: string; predictionTarget: string; predictionThrottleS: number; freshnessDiagnostics: boolean; sourceCommit?: string;
}
const read = <T>(file: string): T => JSON.parse(fs.readFileSync(file, 'utf8'));
function write(file: string, value: unknown): void {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
}
export function daemonitorArtifacts(config: DaemonitorConfig): string[] {
    return ['collector.json', 'raw.jsonl', 'metadata.jsonl', 'outbox.jsonl', 'progress.json', 'done.json', 'monitor.log'].map(p => path.join(config.stateDir, p));
}
export function nativeRequest<T>(socketPath: string, route: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const request = http.get({ socketPath, path: route, timeout: 5000 }, response => {
            let body = '';
            response.on('data', data => { body += data; if (body.length > 2 * 1024 * 1024) request.destroy(new Error('Daemonitor response too large')); });
            response.on('error', reject);
            response.on('end', () => {
                try { if (response.statusCode !== 200) throw new Error(`Daemonitor HTTP ${response.statusCode}`); resolve(JSON.parse(body)); }
                catch (error) { reject(error); }
            });
        });
        request.on('timeout', () => request.destroy(new Error('Daemonitor request timed out')));
        request.on('error', reject);
    });
}

export class BackendTransport {
    private token = '';
    constructor(private config: DaemonitorConfig) {}
    private async authenticate(): Promise<void> {
        const url = new URL(`${this.config.backendUrl.replace(/\/$/, '')}/auth/run/${encodeURIComponent(this.config.runId)}`);
        if (this.config.exportToBigquery) url.searchParams.set('export_to_bigquery', 'true');
        if (this.config.predictionMode !== 'disabled') url.searchParams.set('prediction_mode', this.config.predictionMode);
        if (this.config.predictionTarget !== 'memory') url.searchParams.set('prediction_target', this.config.predictionTarget);
        url.searchParams.set('prediction_throttle_s', String(this.config.predictionThrottleS));
        const response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error(`Run authentication HTTP ${response.status}`);
        const auth = await response.json() as { token?: string };
        if (!auth.token) throw new Error('Run authentication returned no token');
        this.token = auth.token;
    }
    async send(payload: unknown): Promise<void> {
        for (let attempt = 0; attempt < 2; attempt++) {
            if (!this.token) await this.authenticate();
            const response = await fetch(`${this.config.backendUrl.replace(/\/$/, '')}/ingest`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
                body: JSON.stringify(payload), signal: AbortSignal.timeout(5000),
            });
            if (response.ok) return;
            if (response.status === 401 && attempt === 0) { this.token = ''; continue; }
            throw new Error(`Metric ingest HTTP ${response.status}`);
        }
    }
}

function outboxLine(file: string, offset: number): { payload: unknown; next: number } | undefined {
    if (!fs.existsSync(file) || fs.statSync(file).size <= offset) return;
    const fd = fs.openSync(file, 'r');
    try {
        const chunks: Buffer[] = [];
        let position = offset;
        while (true) {
            const buffer = Buffer.alloc(65536);
            const size = fs.readSync(fd, buffer, 0, buffer.length, position);
            if (!size) return; // A partial final line is never acknowledged.
            const newline = buffer.subarray(0, size).indexOf(10);
            chunks.push(buffer.subarray(0, newline < 0 ? size : newline));
            if (newline >= 0) return { payload: JSON.parse(Buffer.concat(chunks).toString('utf8')), next: position + newline + 1 };
            position += size;
        }
    } finally { fs.closeSync(fd); }
}
export async function flushOutbox(config: DaemonitorConfig, timeoutMs = 15000, transport = new BackendTransport(config)): Promise<boolean> {
    if (!config.backendUrl) return true;
    const progress = path.join(config.stateDir, 'progress.json');
    const file = path.join(config.stateDir, 'outbox.jsonl');
    const previous = fs.existsSync(progress) ? read<{ offset: number; last_error?: string }>(progress) : { offset: 0 };
    let offset = previous.offset;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const item = outboxLine(file, offset);
        if (!item) return !fs.existsSync(file) || fs.statSync(file).size === offset;
        try { await transport.send(item.payload); }
        catch (error) {
            const message = error instanceof Error ? error.message : 'Metric upload failed';
            if (previous.offset !== offset || previous.last_error !== message) {
                console.error(`Daemonitor upload failed at outbox byte ${offset}: ${message}`);
            }
            write(progress, { offset, last_error: message });
            return false;
        }
        offset = item.next;
        write(progress, { offset });
    }
    return !fs.existsSync(file) || fs.statSync(file).size === offset;
}

export async function startDaemonitor(config: Omit<DaemonitorConfig, 'stateDir'>, entry: string): Promise<string> {
    if (!numeric(config.interval) || config.interval <= 0) throw new Error('interval must be positive');
    const binaryHashes = Object.fromEntries(['daemonitor-cli', 'daemonitor-cored'].map(name => [name,
        createHash('sha256').update(fs.readFileSync(path.join(config.binDir, name))).digest('hex')]));
    if (config.sourceCommit) {
        const info = read<{ source_commit: string; binary_sha256: Record<string, string> }>(path.join(config.binDir, 'build-info.json'));
        if (!/^[a-f0-9]{40}$/.test(config.sourceCommit) || info.source_commit !== config.sourceCommit ||
            !Object.entries(binaryHashes).every(([name, hash]) => info.binary_sha256[name] === hash)) throw new Error('Daemonitor source commit / binary hashes do not match build-info.json');
    }
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpw-dm-'));
    fs.chmodSync(stateDir, 0o700);
    const full = { ...config, logFile: path.resolve(config.logFile), stateDir };
    write(path.join(stateDir, 'config.json'), full);
    write(path.join(stateDir, 'collector.json'), { collector: 'daemonitor', sourceCommit: config.sourceCommit ?? null, binaryHashes,
        heap: 'complete used/committed heap including survivor spaces', gc: 'young plus full seconds', jvmProbeBudget: '5s' });
    const log = fs.openSync(path.join(stateDir, 'monitor.log'), 'a', 0o600);
    const child = spawn(process.execPath, [entry, path.join(stateDir, 'config.json')], { detached: true, stdio: ['ignore', log, log] });
    fs.closeSync(log);
    let spawnError: Error | undefined;
    child.on('error', error => { spawnError = error; });
    write(path.join(stateDir, 'worker.json'), { pid: child.pid });
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        if (spawnError || child.exitCode !== null || fs.existsSync(path.join(stateDir, 'done.json'))) break;
        if (fs.existsSync(path.join(stateDir, 'ready.json'))) { child.unref(); return stateDir; }
        await pause(100);
    }
    fs.writeFileSync(path.join(stateDir, 'stop'), '');
    child.unref();
    await stopDaemonitor(stateDir);
    throw new Error(`Daemonitor did not start: ${spawnError?.message ?? fs.readFileSync(path.join(stateDir, 'monitor.log'), 'utf8').slice(-1500)}`);
}

export async function stopDaemonitor(stateDir: string): Promise<{ config: DaemonitorConfig; complete: boolean; error?: string }> {
    const config = read<DaemonitorConfig>(path.join(stateDir, 'config.json'));
    fs.writeFileSync(path.join(stateDir, 'stop'), '');
    const deadline = Date.now() + 25000;
    const done = path.join(stateDir, 'done.json');
    while (!fs.existsSync(done) && Date.now() < deadline) {
        const worker = read<{ pid?: number }>(path.join(stateDir, 'worker.json'));
        try { if (!worker.pid) break; process.kill(worker.pid, 0); } catch { break; }
        await pause(100);
    }
    if (!fs.existsSync(done)) {
        const { pid } = read<{ pid?: number }>(path.join(stateDir, 'worker.json'));
        if (pid) {
            // The unique config argument prevents signalling a different process after PID reuse.
            try {
                const command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
                if (command.includes(path.join(stateDir, 'config.json'))) process.kill(-pid, 'SIGKILL');
            } catch { /* An already exited worker needs no signal. */ }
            if (fs.existsSync(path.join(stateDir, 'ready.json'))) {
                const ready = read<{ corePid?: number }>(path.join(stateDir, 'ready.json'));
                try {
                    if (ready.corePid) {
                        const command = execFileSync('ps', ['-o', 'command=', '-p', String(ready.corePid)], { encoding: 'utf8' });
                        const group = execFileSync('ps', ['-o', 'pgid=', '-p', String(ready.corePid)], { encoding: 'utf8' }).trim();
                        if (command.includes(path.join(stateDir, 'core.sock')) && group === String(pid)) process.kill(-pid, 'SIGKILL');
                    }
                } catch { /* An orphaned core may have already exited. */ }
            }
        }
    }
    const complete = await flushOutbox(config);
    const status = fs.existsSync(done) ? read<{ error?: string }>(done) : { error: 'Collector did not shut down cleanly' };
    return { config, complete, error: status.error };
}

async function terminate(child: ChildProcess | undefined): Promise<void> {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 3000);
    await exited;
    clearTimeout(timer);
}

export async function runDaemonitor(config: DaemonitorConfig): Promise<void> {
    const socket = path.join(config.stateDir, 'core.sock');
    const database = path.join(config.stateDir, 'watcher.db');
    let stopped = false;
    let failure: string | undefined;
    let coreProcess: ChildProcess | undefined, watcher: ChildProcess | undefined;
    let uploading: Promise<boolean> | undefined;
    let incomplete = 0, samples = 0, sequence = 0;
    const metadata = new Map<string, number>();
    const seen = new Map<number, { start: number; at: number }>();
    const transport = new BackendTransport(config);
    const spool = (payload: unknown) => { if (config.backendUrl) fs.appendFileSync(path.join(config.stateDir, 'outbox.jsonl'), JSON.stringify(payload) + '\n'); };
    const pump = () => {
        if (!uploading && config.backendUrl) uploading = flushOutbox(config, 5000, transport).finally(() => { uploading = undefined; });
    };
    process.on('SIGTERM', () => { stopped = true; });
    process.on('SIGINT', () => { stopped = true; });
    fs.mkdirSync(path.dirname(config.logFile), { recursive: true });
    fs.writeFileSync(config.logFile, `Session started: ${new Date().toISOString()}\n${DAEMONITOR_HEADER}\n`);
    fs.writeFileSync(config.logFile.replace(/\.log$/, '') + '.process_info', '');
    fs.writeFileSync(config.logFile + '.measurements.jsonl', '');
    const startedAt = Date.now();
    try {
        coreProcess = spawn(path.join(config.binDir, 'daemonitor-cored'), ['-socket', socket, '-db', database,
            '-interval', `${config.interval}s`, '-jvm-probe-budget', '5s', '-gradle-user-home', process.env.GRADLE_USER_HOME || path.join(os.homedir(), '.gradle')], { stdio: ['ignore', 'inherit', 'inherit'] });
        coreProcess.on('error', error => { failure = error.message; stopped = true; });
        let healthy = false;
        const deadline = Date.now() + 10000;
        while (!stopped && Date.now() < deadline) {
            try {
                const h = await nativeRequest<{ pid: number; db_path: string }>(socket, '/v1/health');
                if (h.pid !== coreProcess.pid || h.db_path !== database) throw new Error('Unexpected Daemonitor core ownership');
                healthy = true; break;
            } catch { if (coreProcess.exitCode !== null) break; await pause(100); }
        }
        if (!healthy) throw new Error('Daemonitor core health check failed');
        watcher = spawn(path.join(config.binDir, 'daemonitor-cli'), ['ps', '--watch', '--format', 'jsonl', '--poll-interval', `${config.interval}s`,
            '--socket', socket, '--no-autostart'], { stdio: ['ignore', 'pipe', 'inherit'] });
        watcher.on('error', error => { failure = error.message; stopped = true; });
        const lines = createInterface({ input: watcher.stdout! });
        const reader = (async () => {
            for await (const line of lines) {
                const snapshot = JSON.parse(line) as NativeSnapshot;
                snapshot.processes = snapshot.processes?.filter(p => names[p.type]) ?? [];
                const raw = { sampled_at_ms: snapshot.sampled_at_ms, processes: snapshot.processes.map(p => {
                    const { command_line, working_directory, project_path, ...metrics } = p as NativeProcess & Record<string, unknown>;
                    return metrics;
                }) };
                fs.appendFileSync(path.join(config.stateDir, 'raw.jsonl'), JSON.stringify(raw) + '\n');
                const encoded = encodeSnapshot(snapshot, startedAt, seen);
                if (!fs.existsSync(path.join(config.stateDir, 'ready.json'))) {
                    write(path.join(config.stateDir, 'ready.json'), { pid: process.pid, corePid: coreProcess!.pid, startedAt });
                }
                incomplete += encoded.incomplete;
                samples += encoded.lines.length;
                if (encoded.lines.length) {
                    fs.appendFileSync(config.logFile, encoded.lines.join('\n') + '\n');
                    const requests = metricRequests(config.runId, encoded.lines, config.freshnessDiagnostics
                        ? { startedAtMs: startedAt, collectedAtMs: Date.now(), sequence } : undefined, encoded.measurements);
                    for (const request of requests) {
                        fs.appendFileSync(config.logFile + '.measurements.jsonl', JSON.stringify({ data: request.data, metric_measurements: request.metric_measurements }) + '\n');
                        spool(request);
                    }
                    sequence += requests.length;
                }
                for (const p of snapshot.processes ?? []) {
                    const identity = `${p.pid}:${p.start_time_ms}`;
                    if (!p.heap_available || Date.now() < (metadata.get(identity) ?? 0)) continue;
                    metadata.set(identity, Date.now() + 10000);
                    try {
                        const flags = await nativeRequest<FlagMetadata>(socket, `/v1/processes/jvm-flags?pid=${p.pid}&start_time_ms=${p.start_time_ms}`);
                        fs.appendFileSync(path.join(config.stateDir, 'metadata.jsonl'), JSON.stringify(flags) + '\n');
                        if (flags.availability !== 'available') continue;
                        metadata.set(identity, Infinity);
                        const values = vmFlags(flags);
                        fs.appendFileSync(config.logFile.replace(/\.log$/, '') + '.process_info', `${p.pid}\t${names[p.type]}\t${JSON.stringify(values)}\n`);
                        spool({ run_id: config.runId, data: '', process_info: { pid: String(p.pid), name: names[p.type], vm_flags: values } });
                    } catch (error) { console.error(`VM flags unavailable: ${String(error)}`); }
                }
                pump();
            }
        })().catch(error => { failure = String(error); stopped = true; });
        while (!stopped && !fs.existsSync(path.join(config.stateDir, 'stop'))) {
            if (watcher.exitCode !== null || coreProcess.exitCode !== null) { failure = 'Daemonitor exited during collection'; break; }
            pump();
            await pause(250);
        }
        await terminate(watcher);
        await reader;
    } catch (error) { failure = String(error); }
    finally {
        await terminate(watcher);
        await terminate(coreProcess);
        if (uploading) await uploading;
        const uploaded = await flushOutbox(config, 10000, transport);
        write(path.join(config.stateDir, 'done.json'), { collector: 'daemonitor', samples, incomplete, uploaded, error: failure, finishedAt: Date.now() });
        console.log(JSON.stringify({ samples, incomplete, uploaded, error: failure }));
    }
}
