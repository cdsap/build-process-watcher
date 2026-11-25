#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [binDir, sourceCommit] = process.argv.slice(2);
if (!binDir || !/^[a-f0-9]{40}$/.test(sourceCommit ?? '')) throw new Error('Usage: node scripts/verify-collector-comparison.mjs /native/bin <source-commit>');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bpw-action-compare-'));
const javaInfo = spawnSync('java', ['-XshowSettings:properties', '-version'], { cwd: repo, encoding: 'utf8' });
const javaHome = process.env.JAVA_HOME || javaInfo.stderr.match(/\bjava.home\s*=\s*(.+)/)?.[1].trim();
if (!javaHome) throw new Error('Cannot resolve a JDK for the isolated Action working directory');
const runs = new Map();
let failure;
const events = [];
const server = http.createServer(async (request, response) => {
  try {
    let body = '';
    for await (const data of request) body += data;
    const url = new URL(request.url, 'http://local');
    const parts = url.pathname.split('/');
    let run;
    if (url.pathname.startsWith('/auth/run/')) {
      const id = decodeURIComponent(parts.at(-1));
      run = runs.get(id);
      assert.ok(run, `Unexpected run ${id}`);
      run.auth++;
      if (url.searchParams.get('export_to_bigquery') === 'true') run.export = true;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ token: `${id}-${run.auth}`, expires_at: '2099-01-01T00:00:00Z' }));
      return;
    }
    if (url.pathname === '/healthz') { response.end('ok'); return; }
    if (url.pathname === '/ingest') {
      const payload = JSON.parse(body);
      run = runs.get(payload.run_id);
      assert.ok(run);
      if (run.outage) { response.writeHead(503); response.end('temporary outage'); return; }
      if (run.collector === 'daemonitor' && !run.rejected) {
        run.rejected = true;
        response.writeHead(401); response.end('expired'); return;
      }
      assert.equal(request.headers.authorization, `Bearer ${payload.run_id}-${run.auth}`);
      assert.equal(run.finished, false, 'An upload arrived after finish');
      if (payload.process_info) run.metadata++;
      const lines = payload.data.split('\n').filter(Boolean);
      if (payload.freshness) {
        if (lines.length !== 1) { response.writeHead(400); response.end('Invalid freshness metadata'); return; }
        const f = payload.freshness;
        assert.match(f.sample_id, /^[0-9-]+$/);
        assert.ok((run.collector === 'daemonitor' ? f.sequence > run.sequence : f.sequence >= run.sequence) && f.collected_at_unix_ms > 0);
        assert.ok(!run.sampleIds.has(f.sample_id));
        run.sequence = f.sequence;
        run.sampleIds.add(f.sample_id);
        run.freshnessSamples++;
      }
      for (const line of lines) {
        const fields = line.split('|').map(v => v.trim());
        assert.equal(fields.length, 14);
        assert.ok(fields.slice(3, 6).every(v => Number.isFinite(parseFloat(v))), 'Unknown heap sent to numeric parser');
        run.samples++;
        run.pids.add(fields[1]);
        if (fields[6] !== 'N/A') run.gcPids.add(fields[1]);
        if (fields[11] !== 'N/A') run.classPids.add(fields[1]);
      }
      response.setHeader('Content-Type', 'application/json');
      response.end('{}'); return;
    }
    if (url.pathname.startsWith('/finish/')) {
      const id = decodeURIComponent(parts.at(-1));
      run = runs.get(id);
      assert.ok(run && !run.outage && run.samples > 0);
      if (run.collector === 'daemonitor') {
        const progress = JSON.parse(fs.readFileSync(path.join(run.stateDir, 'progress.json'), 'utf8'));
        assert.equal(progress.offset, fs.statSync(path.join(run.stateDir, 'outbox.jsonl')).size);
        assert.ok(fs.existsSync(path.join(run.stateDir, 'done.json')), 'finish before worker drain');
      }
      run.finished = true;
      events.push({ run: id, exportRequested: run.export, samplesAtFinish: run.samples, metadataAtFinish: run.metadata });
      response.setHeader('Content-Type', 'application/json'); response.end('{}'); return;
    }
    response.writeHead(404); response.end('unknown endpoint');
  } catch (error) {
    failure = error;
    response.writeHead(500); response.end(String(error));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const backend = `http://127.0.0.1:${server.address().port}`;
function fileEnvironment(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const values = {};
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^([^=]+)<<(.+)$/);
    if (match) {
      const content = [];
      while (++i < lines.length && lines[i] !== match[2]) content.push(lines[i]);
      values[match[1]] = content.join('\n');
    }
  }
  return values;
}
async function node(entry, cwd, env, label) {
  const output = fs.openSync(path.join(cwd, label), 'w');
  const child = spawn(process.execPath, [entry], { cwd, env, stdio: ['ignore', output, output] });
  fs.closeSync(output);
  return await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code));
  });
}
const owned = [];
try {
  for (const [collector, outage] of [['shell', false], ['daemonitor', false], ['daemonitor', true]]) {
    const id = `${collector}${outage ? '-outage' : ''}`;
    const directory = path.join(root, id);
    const action = path.join(directory, 'action');
    const workspace = path.join(directory, 'workspace');
    for (const dir of [path.join(action, 'dist'), workspace, path.join(directory, 'runner')]) fs.mkdirSync(dir, { recursive: true });
    for (const file of ['index_with_backend.js', 'cleanup.js', 'daemonitor.js']) fs.copyFileSync(path.join(repo, 'dist', file), path.join(action, 'dist', file));
    fs.copyFileSync(path.join(repo, 'monitor_with_backend.sh'), path.join(action, 'monitor_with_backend.sh'));
    const files = Object.fromEntries(['GITHUB_ENV', 'GITHUB_STATE', 'GITHUB_OUTPUT', 'GITHUB_STEP_SUMMARY'].map(name => {
      const file = path.join(directory, name); fs.writeFileSync(file, ''); return [name, file];
    }));
    const env = { ...process.env, ...files, JAVA_HOME: javaHome, PATH: `${path.join(javaHome, 'bin')}${path.delimiter}${process.env.PATH}`, INPUT_COLLECTOR: collector,
      INPUT_DAEMONITOR_BIN_DIR: path.resolve(binDir), INPUT_DAEMONITOR_SOURCE_COMMIT: sourceCommit,
      INPUT_RUN_ID: id, INPUT_INTERVAL: '1', INPUT_FRESHNESS_DIAGNOSTICS: 'true', INPUT_REMOTE_MONITORING: 'true', INPUT_EXPORT_TO_BIGQUERY: 'true',
      INPUT_LOG_FILE: path.join(workspace, 'results.log'), INPUT_DEBUG: 'false', INPUT_DISABLE_SUMMARY_OUTPUT: 'true',
      BACKEND_URL: backend, FRONTEND_URL: backend, GITHUB_WORKSPACE: workspace, GITHUB_ACTION_PATH: action,
      RUNNER_TEMP: path.join(directory, 'runner'), GITHUB_ACTIONS: 'false' };
    delete env.ACTIONS_RUNTIME_TOKEN;
    delete env.GITHUB_TOKEN;
    const run = { collector, outage, auth: 0, samples: 0, metadata: 0, export: false, finished: false, directory, sequence: 0, sampleIds: new Set(), freshnessSamples: 0, pids: new Set(), gcPids: new Set(), classPids: new Set() };
    runs.set(id, run);
    assert.equal(await node(path.join(action, 'dist/index_with_backend.js'), action, env, 'main.log'), 0);
    const postEnv = { ...env, ...fileEnvironment(files.GITHUB_ENV),
      ...Object.fromEntries(Object.entries(fileEnvironment(files.GITHUB_STATE)).map(([k, v]) => [`STATE_${k}`, v])) };
    run.stateDir = postEnv.BPW_DAEMONITOR_STATE_DIR;
    const source = path.join(workspace, 'GradleDaemon.java');
    fs.writeFileSync(source, `public class GradleDaemon { public static void main(String[] args) throws Exception {
      byte[][] retained = new byte[24][]; long end=System.currentTimeMillis()+90000; int i=0;
      while(System.currentTimeMillis()<end) { retained[(i++)%24]=new byte[1024*1024]; Thread.sleep(40); }
    } }`);
    const kotlinSource = path.join(workspace, 'KotlinCompileDaemon.java');
    fs.writeFileSync(kotlinSource, 'public class KotlinCompileDaemon { public static void main(String[] args) throws Exception { GradleDaemon.main(args); } }');
    const compile = spawnSync('javac', [source, kotlinSource], { encoding: 'utf8' });
    assert.equal(compile.status, 0, compile.stderr);
    const workload = spawn('java', ['-Xms64m', '-Xmx160m', '-cp', workspace, 'GradleDaemon'], { stdio: 'ignore' });
    const kotlinWorkload = spawn('java', ['-Xms64m', '-Xmx160m', '-cp', workspace, 'KotlinCompileDaemon'], { stdio: 'ignore' });
    owned.push(workload, kotlinWorkload);
    try {
      await delay(outage ? 6000 : 26000);
      const exit = await node(path.join(action, 'dist/cleanup.js'), action, postEnv, 'post.log');
      if (outage) {
        assert.equal(exit, 1, fs.readFileSync(path.join(action, 'post.log'), 'utf8'));
        assert.equal(run.finished, false);
        const size = fs.statSync(path.join(run.stateDir, 'outbox.jsonl')).size;
        assert.ok(size > 0, 'Outage must leave durable uploads');
      } else {
        assert.equal(exit, 0, fs.readFileSync(path.join(action, 'post.log'), 'utf8'));
        assert.ok(run.finished && run.export && run.samples > 0 && run.metadata > 0);
        assert.equal(run.freshnessSamples, run.samples, 'Every stored sample must have freshness metadata');
        for (const child of [workload, kotlinWorkload]) {
          const pid = String(child.pid);
          assert.ok(run.pids.has(pid), `Missing fixture JVM ${pid}`);
          assert.ok(run.gcPids.has(pid), `Missing GC metrics for fixture JVM ${pid}`);
          assert.ok(run.classPids.has(pid), `Missing class metrics for fixture JVM ${pid}`);
        }
        if (collector === 'daemonitor') assert.ok(run.rejected && run.auth >= 3);
      }
      if (run.stateDir) {
        const status = JSON.parse(fs.readFileSync(path.join(run.stateDir, 'done.json'), 'utf8'));
        assert.ok(status.samples > 0);
        if (!outage) assert.equal(run.samples, status.samples, 'All captured samples must reach ingestion');
        const { pid } = JSON.parse(fs.readFileSync(path.join(run.stateDir, 'worker.json'), 'utf8'));
        try { process.kill(-pid, 0); throw new Error('Collector process group leaked'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
        assert.ok(!fs.existsSync(path.join(run.stateDir, 'core.sock')));
      }
      const report = JSON.parse(fs.readFileSync(path.join(workspace, `build_process_watcher-${id}.json`), 'utf8'));
      assert.ok(report.samples.length > 0);
      if (failure) throw failure;
      console.log(JSON.stringify({ variant: id, samples: run.samples, metadata: run.metadata, finished: run.finished, freshnessSamples: run.freshnessSamples, fixturePids: [workload.pid, kotlinWorkload.pid], exit }));
    } finally { workload.kill('SIGTERM'); kotlinWorkload.kill('SIGTERM'); }
  }
  const bad = path.join(root, 'invalid-native');
  fs.mkdirSync(bad);
  fs.copyFileSync(path.join(path.resolve(binDir), 'daemonitor-cli'), path.join(bad, 'daemonitor-cli'));
  fs.writeFileSync(path.join(bad, 'daemonitor-cored'), '#!/missing/bpw-test-interpreter\n', { mode: 0o755 });
  const failDir = path.join(root, 'startup-failure');
  fs.mkdirSync(failDir);
  for (const file of ['env', 'state', 'output']) fs.writeFileSync(path.join(failDir, file), '');
  const startTime = Date.now();
  const startupExit = await node(path.join(root, 'daemonitor', 'action/dist/index_with_backend.js'), failDir,
    { ...process.env, INPUT_COLLECTOR: 'daemonitor', INPUT_DAEMONITOR_BIN_DIR: bad,
      INPUT_DAEMONITOR_SOURCE_COMMIT: '', INPUT_REMOTE_MONITORING: 'false', INPUT_EXPORT_TO_BIGQUERY: 'false',
      INPUT_PREDICTION_MODE: 'disabled', INPUT_FRESHNESS_DIAGNOSTICS: 'false', INPUT_RUN_ID: 'startup-failure', INPUT_LOG_FILE: path.join(failDir, 'results.log'),
      RUNNER_TEMP: failDir, BACKEND_URL: backend, GITHUB_WORKSPACE: failDir,
      GITHUB_ENV: path.join(failDir, 'env'), GITHUB_STATE: path.join(failDir, 'state'), GITHUB_OUTPUT: path.join(failDir, 'output') }, 'main.log');
  assert.equal(startupExit, 1);
  assert.match(fs.readFileSync(path.join(failDir, 'main.log'), 'utf8'), /Daemonitor did not start/);
  assert.ok(Date.now() - startTime < 15000, 'Failed executable must not hang collector shutdown');
  console.log(JSON.stringify({ variant: 'invalid-native', exit: startupExit, startupFailureHandled: true }));
  fs.writeFileSync(path.join(root, 'verification.json'), JSON.stringify({ backend: 'local test server; no Firestore/BigQuery writes', events,
    startupFailureHandled: true,
    variants: [...runs.entries()].map(([id, r]) => ({ id, samples: r.samples, metadata: r.metadata, finished: r.finished, exportRequested: r.export, directory: r.directory })) }, null, 2));
  console.log(`Verified action main/post variants: ${root}`);
} finally {
  for (const child of owned) child.kill('SIGTERM');
  for (const run of runs.values()) {
    if (run.stateDir) fs.writeFileSync(path.join(run.stateDir, 'stop'), '');
    const pidFile = path.join(run.directory, 'action', 'monitor.pid');
    if (fs.existsSync(pidFile)) {
      try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGTERM'); } catch {}
    }
  }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
