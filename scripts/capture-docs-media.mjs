#!/usr/bin/env node
/**
 * Deterministically captures lightweight PNGs and GIFs for the public homepage
 * and README from public-safe repository fixtures (frontend/public/demo-run.json).
 *
 * Usage:
 *   node scripts/capture-docs-media.mjs
 *
 * Environment overrides:
 *   CHROME_BIN - path to Chrome/Chromium executable
 *   FFMPEG_BIN - path to ffmpeg executable
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(REPO_ROOT, 'frontend', 'public');
const MEDIA_DIR = path.join(PUBLIC_DIR, 'media');
const DEMO_RUN_PATH = path.join(PUBLIC_DIR, 'demo-run.json');

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

const CHROME_BIN = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!CHROME_BIN) {
  console.error('Chrome/Chromium not found. Set CHROME_BIN to your browser binary.');
  process.exit(1);
}

const FFMPEG_BIN = process.env.FFMPEG_BIN || (fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg');
const CDP_PORT = 9362;
const HTTP_PORT = 18962;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
};

function expandDemoSamples(demo) {
  const fields = demo.sample_fields || [];
  return (demo.samples || []).map((row) => {
    if (!Array.isArray(row)) return row;
    const obj = {};
    fields.forEach((f, idx) => { obj[f] = row[idx]; });
    return obj;
  });
}

function buildCompareVariant(demo) {
  const copy = JSON.parse(JSON.stringify(demo));
  const fields = copy.sample_fields || [];
  const idxTs = fields.indexOf('Timestamp');
  const idxElapsed = fields.indexOf('ElapsedTime');
  const idxName = fields.indexOf('Name');
  const idxHeap = fields.indexOf('HeapUsed');
  const idxHeapCap = fields.indexOf('HeapCap');
  const idxRss = fields.indexOf('RSS');
  const idxGc = fields.indexOf('GCTime');
  const idxJit = fields.indexOf('JITCompiledMethods');
  const idxClasses = fields.indexOf('ClassesLoaded');

  const baseStart = copy.samples[0]?.[idxTs] || 1783046100172;
  copy.samples = copy.samples.map((row) => {
    const next = [...row];
    const isGradle = next[idxName] === 'GradleDaemon';
    const isKotlin = next[idxName] === 'KotlinCompileDaemon';
    const multMem = isGradle ? 1.24 : isKotlin ? 1.12 : 1.05;
    const multGc = isGradle ? 1.42 : 1.15;
    const elapsed = Math.round((next[idxElapsed] || 0) * 1.12);
    next[idxElapsed] = elapsed;
    next[idxTs] = baseStart + elapsed * 1000;
    if (idxHeap >= 0 && typeof next[idxHeap] === 'number') next[idxHeap] = Math.round(next[idxHeap] * multMem);
    if (idxHeapCap >= 0 && typeof next[idxHeapCap] === 'number') next[idxHeapCap] = Math.round(next[idxHeapCap] * 1.15);
    if (idxRss >= 0 && typeof next[idxRss] === 'number') next[idxRss] = Math.round(next[idxRss] * multMem);
    if (idxGc >= 0 && typeof next[idxGc] === 'number') next[idxGc] = Math.round(next[idxGc] * multGc);
    if (idxJit >= 0 && typeof next[idxJit] === 'number') next[idxJit] = Math.round(next[idxJit] * 1.08);
    if (idxClasses >= 0 && typeof next[idxClasses] === 'number') next[idxClasses] = Math.round(next[idxClasses] * 1.06);
    return next;
  });

  // Update GC flag in process_info & process_summary so Compare highlights a real GC config diff
  const swapFlags = (flags) => (flags || []).map((f) => {
    if (f === '-XX:+UseG1GC') return '-XX:+UseParallelGC';
    if (f === '-XX:MaxHeapSize=536870912') return '-XX:MaxHeapSize=1073741824';
    return f;
  });
  for (const info of Object.values(copy.process_info || {})) {
    info.vm_flags = swapFlags(info.vm_flags);
  }
  // Drop precomputed summary so Compare recomputes Peak RSS/Heap/GC deltas from modified samples + process_info
  delete copy.process_summary;
  return copy;
}

function buildMemoryPredictionRun(demo) {
  const copy = JSON.parse(JSON.stringify(demo));
  const samples = expandDemoSamples(demo);
  const byProc = new Map();
  for (const s of samples) {
    if (s.Name !== 'GradleDaemon' && s.Name !== 'KotlinCompileDaemon') continue;
    const key = `${s.PID}:${s.Name}`;
    if (!byProc.has(key)) byProc.set(key, []);
    byProc.get(key).push(s);
  }

  const forecasts = [];
  const horizons = [10, 30, 60];
  let seed = 17;
  const detNoise = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return ((seed % 1000) / 1000 - 0.5) * 2; // [-1, 1]
  };

  for (const [, rows] of byProc.entries()) {
    rows.sort((a, b) => a.Timestamp - b.Timestamp);
    const firstTs = rows[0].Timestamp;
    const lastTs = rows[rows.length - 1].Timestamp;
    const span = lastTs - firstTs;
    if (span < 90_000) continue;

    // Issue every ~90s across the demo run so the chart has 10-12 clean, readable issuances
    const cadenceMs = Math.max(60_000, Math.round(span / 12 / 1000) * 1000);
    for (let t = firstTs + 30_000; t <= lastTs - 20_000; t += cadenceMs) {
      const origin = rows.reduce((best, r) => (Math.abs(r.Timestamp - t) < Math.abs(best.Timestamp - t) ? r : best), rows[0]);
      for (const metric of ['heap', 'rss']) {
        const field = metric === 'heap' ? 'HeapUsed' : 'RSS';
        const points = horizons.map((h) => {
          const targetTs = origin.Timestamp + h * 1000;
          const actual = rows.reduce((best, r) => (Math.abs(r.Timestamp - targetTs) < Math.abs(best.Timestamp - targetTs) ? r : best), rows[rows.length - 1]);
          const baseVal = Number(actual[field] ?? origin[field] ?? 0);
          const jitter = Math.round(baseVal * (0.04 + h * 0.0008) * detNoise());
          return {
            target_at_ms: targetTs,
            value_mb: Math.max(20, Math.round(baseVal + jitter)),
          };
        });
        forecasts.push({
          process_name: origin.Name,
          pid: String(origin.PID),
          metric,
          created_at_ms: origin.Timestamp,
          method: 'tabfm',
          model_version: 'demo-tabfm',
          inference_latency_ms: 820 + Math.round(Math.abs(detNoise()) * 360),
          points,
        });
      }
    }
  }

  copy.run_id = 'demo-memory-predictions';
  copy.prediction_mode = 'predict';
  copy.prediction_target = 'memory';
  copy.prediction_throttle_s = 20;
  copy.process_forecasts = forecasts;
  return copy;
}

function buildClassPredictionRun(demo) {
  const copy = JSON.parse(JSON.stringify(demo));
  const samples = expandDemoSamples(demo);
  const byProc = new Map();
  for (const s of samples) {
    if (s.Name !== 'GradleDaemon' && s.Name !== 'KotlinCompileDaemon') continue;
    if (typeof s.ClassesLoaded !== 'number') continue;
    const key = `${s.PID}:${s.Name}`;
    if (!byProc.has(key)) byProc.set(key, []);
    byProc.get(key).push(s);
  }

  const activity = [];
  let seed = 42;
  const detNoise = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return ((seed % 1000) / 1000 - 0.5) * 2;
  };

  for (const [, rows] of byProc.entries()) {
    rows.sort((a, b) => a.Timestamp - b.Timestamp);
    const firstTs = rows[0].Timestamp;
    const lastTs = rows[rows.length - 1].Timestamp;
    // Focus on the active ramp window (first 600s where classes grow steadily)
    const activeEnd = Math.min(lastTs - 15_000, firstTs + 660_000);
    for (let t = firstTs + 60_000; t <= activeEnd; t += 60_000) {
      const origin = rows.reduce((best, r) => (Math.abs(r.Timestamp - t) < Math.abs(best.Timestamp - t) ? r : best), rows[0]);
      const targetTs = origin.Timestamp + 60_000;
      const targetRow = rows.reduce((best, r) => (Math.abs(r.Timestamp - targetTs) < Math.abs(best.Timestamp - targetTs) ? r : best), rows[rows.length - 1]);
      const actualDelta = Math.max(0, (targetRow.ClassesLoaded || 0) - (origin.ClassesLoaded || 0));
      const predDelta = Math.max(0, Math.round(actualDelta * (1 + 0.14 * detNoise()) + (actualDelta < 50 ? 45 : 0)));
      activity.push({
        process_name: origin.Name,
        pid: String(origin.PID),
        metric: 'classes_loaded',
        created_at_ms: origin.Timestamp,
        status: 'ready',
        method: 'tabfm',
        model_version: 'demo-tabfm-activity',
        inference_latency_ms: 910 + Math.round(Math.abs(detNoise()) * 320),
        origin_value_count: origin.ClassesLoaded,
        points: [
          {
            target_at_ms: targetTs,
            predicted_delta_count: predDelta,
            predicted_total_count: origin.ClassesLoaded + predDelta,
          },
        ],
      });
    }
  }

  // Keep only the first ~720s of samples so the class-loading ramp fills the chart clearly
  const minTs = samples[0]?.Timestamp || 0;
  const fields = copy.sample_fields || [];
  const idxTs = fields.indexOf('Timestamp');
  copy.samples = copy.samples.filter((row) => row[idxTs] <= minTs + 740_000);
  copy.run_id = 'demo-class-predictions';
  copy.prediction_mode = 'predict';
  copy.prediction_target = 'class_loading';
  copy.prediction_throttle_s = 20;
  copy.process_activity_forecasts = activity;
  return copy;
}

function buildCiSummaryHtml(demo) {
  const samples = expandDemoSamples(demo);
  const byProc = new Map();
  for (const s of samples) {
    const key = `${s.PID}-${s.Name}`;
    if (!byProc.has(key)) byProc.set(key, { name: s.Name, pid: s.PID, maxRss: 0, maxHeap: 0, maxGc: 0, maxClasses: 0, maxJit: 0, count: 0, rssSum: 0 });
    const stat = byProc.get(key);
    stat.maxRss = Math.max(stat.maxRss, s.RSS || 0);
    stat.maxHeap = Math.max(stat.maxHeap, s.HeapUsed || 0);
    stat.maxGc = Math.max(stat.maxGc, s.GCTime || 0);
    stat.maxClasses = Math.max(stat.maxClasses, s.ClassesLoaded || 0);
    stat.maxJit = Math.max(stat.maxJit, s.JITCompiledMethods || 0);
    stat.rssSum += (s.RSS || 0);
    stat.count += 1;
  }
  const topProcs = [...byProc.values()].sort((a, b) => b.maxRss - a.maxRss).slice(0, 4);

  // Build representative checkpoints
  const times = [...new Set(samples.map((s) => s.ElapsedTime))].sort((a, b) => a - b);
  const picks = [0.1, 0.45, 0.85].map((f) => times[Math.min(times.length - 1, Math.floor(times.length * f))]);
  const fmtElapsed = (sec) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };
  const checkpointCards = picks.map((sec) => {
    const at = samples.filter((s) => Math.abs(s.ElapsedTime - sec) <= 5);
    const dedup = new Map();
    for (const r of at) dedup.set(`${r.PID}-${r.Name}`, r);
    const list = [...dedup.values()].sort((a, b) => (b.RSS || 0) - (a.RSS || 0)).slice(0, 2);
    const totalRss = [...dedup.values()].reduce((acc, r) => acc + (r.RSS || 0), 0);
    return { label: fmtElapsed(sec), list, totalRss };
  });

  const rowsHtml = topProcs.map((p) => `
    <tr>
      <td><code>${p.pid}-${p.name}</code></td>
      <td>${p.maxRss} MB</td>
      <td>${Math.round(p.rssSum / Math.max(1, p.count))} MB</td>
      <td>${p.maxHeap} MB</td>
      <td>${(p.maxGc / 1000).toFixed(2)}s</td>
      <td>${p.maxJit.toLocaleString('en-US')}</td>
      <td>${p.maxClasses.toLocaleString('en-US')}</td>
    </tr>
  `).join('');

  const flowHtml = checkpointCards.map((cp, i) => `
    <div class="cp-group">
      <div class="cp-time">${cp.label}</div>
      <div class="cp-nodes">
        ${cp.list.map((r) => `<div class="cp-node"><strong>${r.Name}</strong><span>RSS ${r.RSS} MB · Heap ${r.HeapUsed} MB</span></div>`).join('')}
        <div class="cp-node agg"><strong>Aggregated RSS</strong><span>${cp.totalRss} MB</span></div>
      </div>
    </div>
    ${i < checkpointCards.length - 1 ? '<div class="cp-arrow">↓</div>' : ''}
  `).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #ffffff; color: #1f2328; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 20px; width: 1000px; }
  .gha-card { border: 1px solid #d0d7de; border-radius: 8px; overflow: hidden; background: #fff; }
  .gha-header { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; background: #f6f8fa; border-bottom: 1px solid #d0d7de; }
  .gha-title { font-size: 14px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
  .gha-badge { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: #dafbe1; color: #1a7f37; border: 1px solid rgba(26,127,55,0.2); }
  .gha-body { padding: 16px; display: grid; gap: 14px; }
  h2 { font-size: 16px; font-weight: 700; border-bottom: 1px solid #d8dee4; padding-bottom: 6px; }
  .flow-wrap { background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 6px; padding: 12px; display: grid; gap: 6px; }
  .cp-group { display: grid; grid-template-columns: 64px 1fr; align-items: center; gap: 10px; }
  .cp-time { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; font-weight: 700; color: #57606a; text-align: right; }
  .cp-nodes { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
  .cp-node { background: #fff; border: 1px solid #d0d7de; border-radius: 6px; padding: 7px 10px; font-size: 12px; }
  .cp-node strong { display: block; color: #1f2328; font-size: 12px; }
  .cp-node span { color: #57606a; font-size: 11px; }
  .cp-node.agg { background: #fff1ee; border-color: #f4b7ab; }
  .cp-node.agg strong { color: #a83725; }
  .cp-arrow { text-align: center; color: #8c959f; font-size: 13px; line-height: 1; padding-left: 64px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { padding: 7px 10px; border: 1px solid #d0d7de; text-align: left; }
  th { background: #f6f8fa; font-weight: 700; color: #1f2328; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; background: #f6f8fa; padding: 1px 4px; border-radius: 4px; }
  .artifacts { display: flex; flex-wrap: wrap; gap: 6px; font-size: 11.5px; color: #57606a; align-items: center; }
  .chip { background: #eef6f7; color: #087f8c; border: 1px solid rgba(8,127,140,0.22); border-radius: 999px; padding: 2px 8px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; font-weight: 600; }
</style>
</head>
<body>
  <div class="gha-card">
    <div class="gha-header">
      <div class="gha-title">GitHub Actions Job Summary · Build Process Watcher (Local Mode)</div>
      <span class="gha-badge">Artifacts only · No backend required</span>
    </div>
    <div class="gha-body">
      <h2>Process Memory &amp; Telemetry Checkpoints</h2>
      <div class="flow-wrap">${flowHtml}</div>
      <h2>Per-Process Statistics</h2>
      <table>
        <thead>
          <tr><th>Process</th><th>Peak RSS</th><th>Avg RSS</th><th>Peak Heap</th><th>GC Time</th><th>JIT Methods</th><th>Classes Loaded</th></tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      <div class="artifacts">
        <strong>Workflow artifacts:</strong>
        <span class="chip">build_process_watcher.json</span>
        <span class="chip">build_process_watcher.csv</span>
        <span class="chip">memory_usage.svg</span>
        <span class="chip">gc_time.svg</span>
        <span class="chip">jit_compilation.svg</span>
        <span class="chip">class_loading.svg</span>
      </div>
    </div>
  </div>
</body>
</html>`;
}

function startServer({ memoryPredRun, classPredRun, compareBRun, ciSummaryHtml }) {
  const server = http.createServer((req, res) => {
    const urlPath = (req.url || '/').split('?')[0];
    if (urlPath === '/api/runs/demo-memory-predictions') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(memoryPredRun));
      return;
    }
    if (urlPath === '/api/runs/demo-class-predictions') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(classPredRun));
      return;
    }
    if (urlPath === '/fixtures/compare-b.json') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(compareBRun));
      return;
    }
    if (urlPath === '/fixtures/ci-summary.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(ciSummaryHtml);
      return;
    }
    if (urlPath === '/config.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(`window.BUILD_PROCESS_WATCHER_CONFIG = { backendUrl: 'http://127.0.0.1:${HTTP_PORT}/api', frontendUrl: 'http://127.0.0.1:${HTTP_PORT}', predictiveReliability: false };`);
      return;
    }
    let filePath = path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath);
    if (urlPath.startsWith('/runs/') && !urlPath.endsWith('.html') && !urlPath.endsWith('.json')) {
      filePath = path.join(PUBLIC_DIR, 'runs/[runId].html');
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
  return new Promise((resolve) => server.listen(HTTP_PORT, '127.0.0.1', () => resolve(server)));
}

async function getWsUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(200);
  }
  throw new Error('Chrome CDP not ready');
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.text + ': ' + JSON.stringify(res.exceptionDetails.exception));
    }
    return res.result?.value;
  }
  async waitFor(expression, timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await this.eval(expression)) return;
      await sleep(150);
    }
    throw new Error(`Timed out waiting for: ${expression}`);
  }
  async screenshotClip(outPath, clip) {
    const shot = await this.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip,
    });
    fs.writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
  }
}

function encodeGif({ frameDir, outGif, width = 960, fps = 7, maxColors = 96, maxKb = 450 }) {
  const palette = path.join(frameDir, 'palette.png');
  const attempts = [
    { width, maxColors, bayerScale: 4 },
    { width: Math.min(width, 880), maxColors: 72, bayerScale: 3 },
    { width: Math.min(width, 820), maxColors: 56, bayerScale: 3 },
  ];
  for (const cfg of attempts) {
    const scale = `scale=${cfg.width}:-1:flags=lanczos`;
    execFileSync(FFMPEG_BIN, [
      '-y', '-framerate', String(fps), '-i', path.join(frameDir, 'frame_%04d.png'),
      '-vf', `${scale},palettegen=max_colors=${cfg.maxColors}:stats_mode=diff`,
      palette,
    ], { stdio: 'ignore' });
    execFileSync(FFMPEG_BIN, [
      '-y', '-framerate', String(fps), '-i', path.join(frameDir, 'frame_%04d.png'), '-i', palette,
      '-lavfi', `${scale} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=${cfg.bayerScale}:diff_mode=rectangle`,
      '-loop', '0',
      outGif,
    ], { stdio: 'ignore' });
    const kb = Math.round(fs.statSync(outGif).size / 1024);
    if (kb <= maxKb) return kb;
  }
  return Math.round(fs.statSync(outGif).size / 1024);
}

function optimizePng(inPath, outPath, targetWidth) {
  execFileSync(FFMPEG_BIN, [
    '-y', '-i', inPath,
    '-vf', `scale=${targetWidth}:-1:flags=lanczos`,
    '-compression_level', '9',
    outPath,
  ], { stdio: 'ignore' });
  return Math.round(fs.statSync(outPath).size / 1024);
}

function composeTwoUpPng(leftPath, rightPath, outPath, totalWidth = 1200, targetHeight = 680) {
  const half = Math.floor((totalWidth - 16) / 2);
  execFileSync(FFMPEG_BIN, [
    '-y', '-i', leftPath, '-i', rightPath,
    '-filter_complex',
    `[0:v]scale=${half}:-1:flags=lanczos,pad=${half}:max(ih\\,${targetHeight}):0:0:color=0xffffff[l];` +
    `[1:v]scale=${half}:-1:flags=lanczos,pad=${half}:max(ih\\,${targetHeight}):0:0:color=0xffffff[r];` +
    `[l]crop=${half}:${targetHeight}:0:0[lc];[r]crop=${half}:${targetHeight}:0:0[rc];` +
    `color=c=0xf5f6f1:s=16x${targetHeight}:d=1[gap];` +
    `[lc][gap][rc]hstack=inputs=3`,
    '-frames:v', '1',
    '-compression_level', '9',
    outPath,
  ], { stdio: 'ignore' });
  return Math.round(fs.statSync(outPath).size / 1024);
}

async function main() {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bpw-docs-media-'));
  const chromeProfile = path.join(tmpRoot, 'chrome-profile');

  const demo = JSON.parse(fs.readFileSync(DEMO_RUN_PATH, 'utf8'));
  const compareBRun = buildCompareVariant(demo);
  const memoryPredRun = buildMemoryPredictionRun(demo);
  const classPredRun = buildClassPredictionRun(demo);
  const ciSummaryHtml = buildCiSummaryHtml(demo);

  const server = await startServer({ memoryPredRun, classPredRun, compareBRun, ciSummaryHtml });
  const chrome = spawn(CHROME_BIN, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${chromeProfile}`,
    'about:blank',
  ], { stdio: 'ignore' });

  const results = [];

  try {
    const ws = new WebSocket(await getWsUrl());
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const cdp = new CDP(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1400, deviceScaleFactor: 2, mobile: false });

    // ------------------------------------------------------------------
    // 1. run-memory-replay.gif (Classic Run Dashboard Memory panel)
    // ------------------------------------------------------------------
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/runs/demo.html` });
    await cdp.waitFor(`!!(document.getElementById('rss-replay-timeline') && document.getElementById('chart')?.data?.length)`);
    await cdp.eval(`(() => {
      localStorage.removeItem('bpwViewMode');
      localStorage.setItem('bpwLayoutMode', 'classic');
      window.BpwExperimentLayout?.setViewMode?.('classic');
      window.scrollTo(0, 0);
    })()`);
    await sleep(500);

    {
      const frameDir = path.join(tmpRoot, 'run-memory');
      fs.mkdirSync(frameDir, { recursive: true });
      const maxMs = await cdp.eval(`Number(document.getElementById('rss-replay-timeline').max)`);
      const rect = await cdp.eval(`(() => {
        const el = document.getElementById('section-memory');
        const r = el.getBoundingClientRect();
        return { x: Math.max(0, r.x - 8), y: Math.max(0, r.y - 8), width: Math.ceil(r.width + 16), height: Math.ceil(r.height + 16) };
      })()`);
      const steps = 32;
      let idx = 0;
      for (let i = 0; i <= steps; i++) {
        const targetMs = Math.round((maxMs * i) / steps);
        await cdp.eval(`(async () => {
          const tl = document.getElementById('rss-replay-timeline');
          tl.value = String(${targetMs});
          tl.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise(r => setTimeout(r, 85));
        })()`);
        await cdp.screenshotClip(path.join(frameDir, `frame_${String(idx++).padStart(4, '0')}.png`), { ...rect, scale: 1.5 });
      }
      const last = path.join(frameDir, `frame_${String(idx - 1).padStart(4, '0')}.png`);
      for (let h = 0; h < 8; h++) fs.copyFileSync(last, path.join(frameDir, `frame_${String(idx++).padStart(4, '0')}.png`));
      const kb = encodeGif({ frameDir, outGif: path.join(MEDIA_DIR, 'run-memory-replay.gif'), width: 960, fps: 7, maxColors: 96, maxKb: 400 });
      results.push({ file: 'run-memory-replay.gif', kb });
    }

    // ------------------------------------------------------------------
    // 2. run-metrics-overview.png (GC Time + Process Info & VM Flags 2-up)
    // ------------------------------------------------------------------
    {
      // Expand first JVM details disclosure so real VM flags are visible
      await cdp.eval(`(() => {
        const det = document.querySelector('#section-process-info details, #process-info-section details, .process-info-card details, details');
        if (det) det.open = true;
      })()`);
      await sleep(200);
      const gcRect = await cdp.eval(`(() => {
        const gc = document.getElementById('section-gc');
        const r = gc.getBoundingClientRect();
        return { x: Math.max(0, r.left - 8), y: Math.max(0, r.top + window.scrollY - 8), width: Math.ceil(r.width + 16), height: Math.min(780, Math.ceil(r.height + 16)) };
      })()`);
      const procRect = await cdp.eval(`(() => {
        const proc = document.getElementById('section-process-info')
          || document.getElementById('process-info-section')
          || document.querySelector('[data-bpw-panel="process-info"]')
          || document.querySelector('.process-info-section, .process-info-card')
          || document.getElementById('section-jit');
        const r = proc.getBoundingClientRect();
        return { x: Math.max(0, r.left - 8), y: Math.max(0, r.top + window.scrollY - 8), width: Math.ceil(r.width + 16), height: Math.min(900, Math.ceil(r.height + 16)) };
      })()`);
      const gcRaw = path.join(tmpRoot, 'gc-raw.png');
      const procRaw = path.join(tmpRoot, 'proc-raw.png');
      await cdp.screenshotClip(gcRaw, { ...gcRect, scale: 1.5 });
      await cdp.screenshotClip(procRaw, { ...procRect, scale: 1.5 });
      const kb = composeTwoUpPng(gcRaw, procRaw, path.join(MEDIA_DIR, 'run-metrics-overview.png'), 1200, 440);
      results.push({ file: 'run-metrics-overview.png', kb });
    }

    // ------------------------------------------------------------------
    // 3. studio-and-story.png (Studio overlay + Build Story side-by-side)
    // ------------------------------------------------------------------
    {
      // Studio mode
      await cdp.eval(`(() => {
        window.BpwExperimentLayout?.setViewMode?.('studio');
        window.scrollTo(0, 0);
      })()`);
      await sleep(700);
      const studioRect = await cdp.eval(`(() => {
        const el = document.querySelector('.bpw-studio-card') || document.getElementById('bpw-chart-studio') || document.querySelector('.bpw-experiment-stage');
        const r = el.getBoundingClientRect();
        return { x: Math.max(0, r.left - 8), y: Math.max(0, r.top + window.scrollY - 8), width: Math.ceil(r.width + 16), height: Math.min(820, Math.ceil(r.height + 16)) };
      })()`);
      const studioRaw = path.join(tmpRoot, 'studio-raw.png');
      await cdp.screenshotClip(studioRaw, { ...studioRect, scale: 1.5 });

      // Story mode
      await cdp.eval(`(() => {
        window.BpwExperimentLayout?.setViewMode?.('story');
        window.scrollTo(0, 0);
      })()`);
      await sleep(700);
      const storyRect = await cdp.eval(`(() => {
        const el = document.querySelector('.bpw-story-root') || document.getElementById('bpw-build-story') || document.querySelector('.bpw-experiment-stage');
        const r = el.getBoundingClientRect();
        return { x: Math.max(0, r.left - 8), y: Math.max(0, r.top + window.scrollY - 8), width: Math.ceil(r.width + 16), height: Math.min(820, Math.ceil(r.height + 16)) };
      })()`);
      const storyRaw = path.join(tmpRoot, 'story-raw.png');
      await cdp.screenshotClip(storyRaw, { ...storyRect, scale: 1.5 });

      const kb = composeTwoUpPng(studioRaw, storyRaw, path.join(MEDIA_DIR, 'studio-and-story.png'), 1200, 440);
      results.push({ file: 'studio-and-story.png', kb });
    }

    // ------------------------------------------------------------------
    // 4. replay-offline.gif (/replay.html)
    // ------------------------------------------------------------------
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/replay.html` });
    await cdp.waitFor(`!!document.getElementById('btn-replay-demo')`);
    await cdp.eval(`(() => {
      localStorage.removeItem('bpwViewMode');
      localStorage.setItem('bpwLayoutMode', 'classic');
      document.getElementById('btn-replay-demo').click();
    })()`);
    await cdp.waitFor(`!!(document.getElementById('single-replay-timeline') && document.querySelector('#replay-section .js-plotly-plot'))`);
    await sleep(700);

    {
      const frameDir = path.join(tmpRoot, 'replay');
      fs.mkdirSync(frameDir, { recursive: true });
      const maxVal = await cdp.eval(`Number(document.getElementById('single-replay-timeline').max)`);
      const rect = await cdp.eval(`(() => {
        const sec = document.getElementById('replay-section');
        const container = document.querySelector('.container') || sec;
        const sR = sec.getBoundingClientRect();
        const cR = container.getBoundingClientRect();
        const plot = document.querySelector('#replay-section .js-plotly-plot');
        const pR = plot ? plot.getBoundingClientRect() : sR;
        const top = Math.max(0, sR.top + window.scrollY - 8);
        const bottom = Math.max(top + 720, Math.min(top + 860, pR.bottom + window.scrollY + 24));
        return { x: Math.max(0, cR.left + 16), y: top, width: Math.min(1248, Math.ceil(cR.width - 32)), height: Math.ceil(bottom - top) };
      })()`);
      const steps = 24;
      let idx = 0;
      for (let i = 0; i <= steps; i++) {
        const val = Math.round((maxVal * i) / steps);
        await cdp.eval(`(async () => {
          const tl = document.getElementById('single-replay-timeline');
          tl.value = String(${val});
          tl.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise(r => setTimeout(r, 85));
        })()`);
        await cdp.screenshotClip(path.join(frameDir, `frame_${String(idx++).padStart(4, '0')}.png`), { ...rect, scale: 1.5 });
      }
      const last = path.join(frameDir, `frame_${String(idx - 1).padStart(4, '0')}.png`);
      for (let h = 0; h < 7; h++) fs.copyFileSync(last, path.join(frameDir, `frame_${String(idx++).padStart(4, '0')}.png`));
      const kb = encodeGif({ frameDir, outGif: path.join(MEDIA_DIR, 'replay-offline.gif'), width: 960, fps: 7, maxColors: 96, maxKb: 400 });
      results.push({ file: 'replay-offline.gif', kb });
    }

    // ------------------------------------------------------------------
    // 5. compare-runs.gif (/compare.html with Run A vs Run B)
    // ------------------------------------------------------------------
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/compare.html` });
    await cdp.waitFor(`!!document.getElementById('compare-a-input')`);
    await cdp.eval(`(async () => {
      const [textA, textB] = await Promise.all([
        fetch('/demo-run.json').then(r => r.text()),
        fetch('/fixtures/compare-b.json').then(r => r.text()),
      ]);
      const inject = (inputId, name, text) => {
        const dt = new DataTransfer();
        dt.items.add(new File([text], name, { type: 'application/json' }));
        const input = document.getElementById(inputId);
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };
      inject('compare-a-input', 'baseline-g1gc.json', textA);
      inject('compare-b-input', 'branch-parallelgc.json', textB);
    })()`);
    await cdp.waitFor(`!!(document.querySelector('#compare-section .js-plotly-plot') && document.getElementById('compare-view-mode'))`);
    await sleep(700);

    {
      const frameDir = path.join(tmpRoot, 'compare');
      fs.mkdirSync(frameDir, { recursive: true });
      const rect = await cdp.eval(`(() => {
        const sec = document.getElementById('compare-section');
        const r = sec.getBoundingClientRect();
        return { x: Math.max(0, r.left - 8), y: Math.max(0, r.top + window.scrollY - 8), width: Math.ceil(r.width + 16), height: 870 };
      })()`);
      let idx = 0;

      // Ensure Side-by-Side mode first
      await cdp.eval(`(async () => {
        const sel = document.getElementById('compare-view-mode');
        if (sel && sel.value !== 'side-by-side') {
          sel.value = 'side-by-side';
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          await new Promise(r => setTimeout(r, 350));
        }
      })()`);

      const maxVal = await cdp.eval(`Number(document.querySelector('#compare-section input[type="range"]')?.max || 100)`);
      const steps = 16;
      for (let i = 0; i <= steps; i++) {
        const val = Math.round((maxVal * i) / steps);
        await cdp.eval(`(async () => {
          const tl = document.querySelector('#compare-section input[type="range"]');
          if (tl) {
            tl.value = String(${val});
            tl.dispatchEvent(new Event('input', { bubbles: true }));
          }
          await new Promise(r => setTimeout(r, 95));
        })()`);
        await cdp.screenshotClip(path.join(frameDir, `frame_${String(idx++).padStart(4, '0')}.png`), { ...rect, scale: 1.5 });
      }
      // Hold final Side-by-Side frame
      const sbsLast = path.join(frameDir, `frame_${String(idx - 1).padStart(4, '0')}.png`);
      for (let h = 0; h < 6; h++) fs.copyFileSync(sbsLast, path.join(frameDir, `frame_${String(idx++).padStart(4, '0')}.png`));

      // Switch to Split View and hold
      const switched = await cdp.eval(`(async () => {
        const sel = document.getElementById('compare-view-mode');
        if (!sel) return false;
        const opt = Array.from(sel.options).find(o => o.value !== 'side-by-side');
        if (!opt) return false;
        sel.value = opt.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => setTimeout(r, 450));
        return true;
      })()`);
      if (switched) {
        const splitFrame = path.join(frameDir, `frame_${String(idx++).padStart(4, '0')}.png`);
        await cdp.screenshotClip(splitFrame, { ...rect, scale: 1.5 });
        for (let h = 0; h < 9; h++) fs.copyFileSync(splitFrame, path.join(frameDir, `frame_${String(idx++).padStart(4, '0')}.png`));
      }

      const kb = encodeGif({ frameDir, outGif: path.join(MEDIA_DIR, 'compare-runs.gif'), width: 960, fps: 6, maxColors: 96, maxKb: 450 });
      results.push({ file: 'compare-runs.gif', kb });
    }

    // ------------------------------------------------------------------
    // 6. predictions-memory.gif (Predictions tab, Memory, All issuances)
    // ------------------------------------------------------------------
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/runs/demo-memory-predictions` });
    await cdp.waitFor(`!!document.querySelector('[data-bpw-view-mode="predictions"]')`);
    await cdp.eval(`(() => {
      window.BpwExperimentLayout?.setViewMode?.('predictions');
      window.scrollTo(0, 0);
    })()`);
    await cdp.waitFor(`!!document.getElementById('forecast-replay-timeline')`);
    await cdp.eval(`(() => {
      const allBtn = document.querySelector('button[data-forecast-history-mode="all"]');
      if (allBtn) allBtn.click();
    })()`);
    await sleep(500);

    {
      const frameDir = path.join(tmpRoot, 'pred-memory');
      fs.mkdirSync(frameDir, { recursive: true });
      const maxVal = await cdp.eval(`Number(document.getElementById('forecast-replay-timeline').max)`);
      const rect = await cdp.eval(`(() => {
        const panel = document.getElementById('section-prediction') || document.querySelector('.prediction-panel') || document.querySelector('.process-forecast-charts')?.closest('section');
        const r = panel.getBoundingClientRect();
        return { x: Math.max(0, r.left - 8), y: Math.max(0, r.top + window.scrollY - 8), width: Math.ceil(r.width + 16), height: Math.min(760, Math.ceil(r.height + 16)) };
      })()`);
      const steps = 22;
      let idx = 0;
      for (let i = 1; i <= steps; i++) {
        const val = Math.round((maxVal * i) / steps);
        await cdp.eval(`(async () => {
          const tl = document.getElementById('forecast-replay-timeline');
          tl.value = String(${val});
          tl.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise(r => setTimeout(r, 95));
        })()`);
        await cdp.screenshotClip(path.join(frameDir, `frame_${String(idx++).padStart(4, '0')}.png`), { ...rect, scale: 1.5 });
      }
      const last = path.join(frameDir, `frame_${String(idx - 1).padStart(4, '0')}.png`);
      for (let h = 0; h < 8; h++) fs.copyFileSync(last, path.join(frameDir, `frame_${String(idx++).padStart(4, '0')}.png`));
      const kb = encodeGif({ frameDir, outGif: path.join(MEDIA_DIR, 'predictions-memory.gif'), width: 960, fps: 6, maxColors: 96, maxKb: 400 });
      results.push({ file: 'predictions-memory.gif', kb });
    }

    // ------------------------------------------------------------------
    // 7. predictions-classes.png (Predictions tab, Class Loading, All)
    // ------------------------------------------------------------------
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/runs/demo-class-predictions` });
    await cdp.waitFor(`!!document.querySelector('[data-bpw-view-mode="predictions"]')`);
    await cdp.eval(`(() => {
      window.BpwExperimentLayout?.setViewMode?.('predictions');
      window.scrollTo(0, 0);
    })()`);
    await cdp.waitFor(`!!document.getElementById('forecast-replay-timeline')`);
    await cdp.eval(`(async () => {
      const allBtn = document.querySelector('button[data-forecast-history-mode="all"]');
      if (allBtn) allBtn.click();
      const tl = document.getElementById('forecast-replay-timeline');
      const minVal = Number(tl.min || 0);
      const maxVal = Number(tl.max || 100);
      tl.value = String(Math.round(minVal + (maxVal - minVal) * 0.88));
      tl.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 450));
    })()`);
    {
      const rect = await cdp.eval(`(() => {
        const panel = document.getElementById('section-prediction') || document.querySelector('.prediction-panel') || document.querySelector('.forecast-chart')?.closest('section');
        const r = panel.getBoundingClientRect();
        return { x: Math.max(0, r.left - 8), y: Math.max(0, r.top + window.scrollY - 8), width: Math.ceil(r.width + 16), height: Math.min(720, Math.ceil(r.height + 16)) };
      })()`);
      const rawPath = path.join(tmpRoot, 'pred-classes-raw.png');
      await cdp.screenshotClip(rawPath, { ...rect, scale: 1.5 });
      const kb = optimizePng(rawPath, path.join(MEDIA_DIR, 'predictions-classes.png'), 1100);
      results.push({ file: 'predictions-classes.png', kb });
    }

    // ------------------------------------------------------------------
    // 8. ci-summary.png (Local Mode GitHub Actions Summary)
    // ------------------------------------------------------------------
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1040, height: 900, deviceScaleFactor: 2, mobile: false });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/fixtures/ci-summary.html` });
    await cdp.waitFor(`!!document.querySelector('.gha-card')`);
    await sleep(250);
    {
      const rect = await cdp.eval(`(() => {
        const el = document.querySelector('.gha-card');
        const r = el.getBoundingClientRect();
        return { x: Math.max(0, r.left - 12), y: Math.max(0, r.top - 12), width: Math.ceil(r.width + 24), height: Math.ceil(r.height + 24) };
      })()`);
      const rawPath = path.join(tmpRoot, 'ci-summary-raw.png');
      await cdp.screenshotClip(rawPath, { ...rect, scale: 1.5 });
      const kb = optimizePng(rawPath, path.join(MEDIA_DIR, 'ci-summary.png'), 1000);
      results.push({ file: 'ci-summary.png', kb });
    }

    console.log('Captured media assets in frontend/public/media/:');
    for (const r of results) {
      console.log(`  - ${r.file}: ${r.kb} KB`);
    }
    ws.close();
  } finally {
    chrome.kill('SIGTERM');
    server.close();
    await sleep(350);
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
