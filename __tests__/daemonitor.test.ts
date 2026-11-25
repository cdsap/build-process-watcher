import { resolveCollector, encodeSnapshot, vmFlags, BackendTransport, flushOutbox, DaemonitorConfig } from '../src/lib/daemonitor';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const sample = (extra = {}) => ({ pid: 42, start_time_ms: 1000, sampled_at_ms: 6000,
  type: 'GRADLE_DAEMON', resident_bytes: 106430464, heap_available: true,
  heap_used_mb: 25, heap_committed_mb: 80, max_heap_mb: 512,
  young_gc_time_seconds: .125, full_gc_time_seconds: .25, total_gc_time_seconds: 9,
  jit: { compiled_count: 20, failed_count: 0, invalid_count: 1, compilation_time_seconds: .015 },
  classes: { loaded: 200, loaded_total: 220, unloaded_total: 20, time_seconds: .03 }, ...extra });

describe('collector selection', () => {
  it('retains the shell default and rejects typos or missing native binaries', () => {
    expect(resolveCollector('', '')).toEqual({ kind: 'shell' });
    expect(resolveCollector('shell', '/does/not/exist')).toEqual({ kind: 'shell' });
    expect(() => resolveCollector('deamonitor', '')).toThrow(/collector/);
    expect(() => resolveCollector('daemonitor', '')).toThrow(/daemonitor_bin_dir/);
    expect(() => resolveCollector('daemonitor', '/does/not/exist')).toThrow();
  });
});

describe('Daemonitor delivery', () => {
  let directory: string;
  let config: DaemonitorConfig;
  const originalFetch = global.fetch;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bpw-delivery-'));
    config = { stateDir: directory, binDir: '', logFile: '', runId: 'comparison-daemonitor', interval: 2,
      backendUrl: 'https://backend.example', exportToBigquery: true, predictionMode: 'forecast', predictionTarget: 'class_loading', predictionThrottleS: 30, freshnessDiagnostics: false };
  });
  afterEach(() => { global.fetch = originalFetch; fs.rmSync(directory, { recursive: true, force: true }); });
  it('refreshes a rejected token and retains the run export settings and payload', async () => {
    const replies = [new Response(JSON.stringify({ token: 'first' })), new Response('', { status: 401 }),
      new Response(JSON.stringify({ token: 'second' })), new Response('{}')];
    const fetcher = jest.fn(async () => replies.shift()!);
    global.fetch = fetcher as unknown as typeof fetch;
    const payload = { run_id: config.runId, data: 'sample' };
    await new BackendTransport(config).send(payload);
    const calls = fetcher.mock.calls as unknown as Array<[URL | string, RequestInit]>;
    expect(String(calls[0][0])).toContain('export_to_bigquery=true');
    expect(String(calls[2][0])).toContain('prediction_mode=forecast');
    expect(String(calls[2][0])).toContain('prediction_target=class_loading');
    expect(String(calls[2][0])).toContain('prediction_throttle_s=30');
    expect(calls[3][1].headers).toEqual(expect.objectContaining({ Authorization: 'Bearer second' }));
    expect(JSON.parse(calls[3][1].body as string)).toEqual(payload);
  });
  it('keeps an unacknowledged item durable and replays it before later samples', async () => {
    const payloads = [{ run_id: config.runId, data: 'one' }, { run_id: config.runId, data: 'two' }];
    const spool = path.join(directory, 'outbox.jsonl');
    fs.writeFileSync(spool, payloads.map(p => JSON.stringify(p) + '\n').join(''));
    const transport = new BackendTransport(config);
    const send = jest.spyOn(transport, 'send').mockResolvedValueOnce().mockRejectedValueOnce(new Error('offline'));
    expect(await flushOutbox(config, 1000, transport)).toBe(false);
    const acknowledged = JSON.parse(fs.readFileSync(path.join(directory, 'progress.json'), 'utf8')).offset;
    expect(acknowledged).toBe(Buffer.byteLength(JSON.stringify(payloads[0]) + '\n'));
    send.mockResolvedValue(undefined);
    expect(await flushOutbox(config, 1000, transport)).toBe(true);
    expect(send.mock.calls.map(c => c[0])).toEqual([payloads[0], payloads[1], payloads[1]]);
    expect(JSON.parse(fs.readFileSync(path.join(directory, 'progress.json'), 'utf8')).offset).toBe(fs.statSync(spool).size);
  });
  it('never acknowledges a partial final spool line', async () => {
    fs.writeFileSync(path.join(directory, 'outbox.jsonl'), '{"run_id":');
    const transport = new BackendTransport(config);
    const send = jest.spyOn(transport, 'send').mockResolvedValue(undefined);
    expect(await flushOutbox(config, 1000, transport)).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('Daemonitor BPW mapping', () => {
  it('preserves the legacy units, own RSS, loaded gauge, and young plus full GC', () => {
    const result = encodeSnapshot({ processes: [sample()] }, 1000, new Map());
    expect(result.lines).toEqual([
      '00:00:05 | 42 | GradleDaemon | 25.0MB | 80.0MB | 101.5MB | 0.375s | 20 | 0 | 1 | 0.015 | 200 | 20 | 0.03',
    ]);
  });
  it('retains unavailable samples only in raw capture, without inventing numeric heap', () => {
    const result = encodeSnapshot({ processes: [sample({ heap_available: false, heap_used_mb: null })] }, 1000, new Map());
    expect(result.lines).toEqual([]);
    expect(result.incomplete).toBe(1);
  });
  it('does not merge reused PIDs or duplicate observations', () => {
    const seen = new Map();
    expect(encodeSnapshot({ processes: [sample()] }, 1000, seen).lines).toHaveLength(1);
    expect(encodeSnapshot({ processes: [sample()] }, 1000, seen).lines).toHaveLength(0);
    expect(() => encodeSnapshot({ processes: [sample({ start_time_ms: 2000, sampled_at_ms: 7000 })] }, 1000, seen)).toThrow(/PID reuse/);
  });
  it('does not include wrappers/Bazel or pre-run samples', () => {
    expect(encodeSnapshot({ processes: [sample({ type: 'BAZEL_SERVER' }), sample({ sampled_at_ms: 900 })] }, 1000, new Map()).lines).toEqual([]);
  });
  it('projects safe effective flag values without losing large integer precision', () => {
    expect(vmFlags({ availability: 'available', flags: {
      UseG1GC: { type: 'bool', value: 'true' }, UseZGC: { type: 'bool', value: 'false' },
      MaxHeapSize: { type: 'uint64_t', value: '18446744073709551615' },
      SecretPath: { type: 'ccstr', value: '/private/path' },
    } })).toEqual(['-XX:+UseG1GC', '-XX:-UseZGC', '-XX:MaxHeapSize=18446744073709551615']);
    expect(vmFlags({ availability: 'unavailable', flags: {} })).toEqual([]);
  });
});
