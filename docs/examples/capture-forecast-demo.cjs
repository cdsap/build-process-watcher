// Run from the repository root: node docs/examples/capture-forecast-demo.cjs
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../..');
const media = path.join(root, 'docs/media');
const frames = fs.mkdtempSync(path.join(media, '.forecast-frames-'));
const allowed = new Set([
    'docs/examples/forecast-demo.html', 'docs/examples/forecast-demo.js',
    'docs/examples/process-forecasts.json', 'frontend/public/run-dashboard.css',
    'frontend/public/bpw-ui.css', 'frontend/public/playback-clock.js',
    'frontend/public/replay-controls.js', 'frontend/public/prediction-view.js',
]);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = http.createServer((req, res) => {
    const file = new URL(req.url, 'http://localhost').pathname.slice(1);
    if (!allowed.has(file)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', types[path.extname(file)]);
    fs.createReadStream(path.join(root, file)).pipe(res);
});

(async () => {
    let browser;
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, timezoneId: 'UTC', locale: 'en-US', reducedMotion: 'reduce' });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.address().port}/docs/examples/forecast-demo.html`);
        await page.locator('.forecast-chart').waitFor();
        const scrub = async seconds => {
            await page.locator('#forecast-replay-timeline').evaluate((input, seconds) => {
                input.value = String(seconds / 5);
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }, seconds);
        };
        // Crop before model diagnostics and synthetic error summaries. Keep the
        // visible demo label, real controls, legend, and complete current chart.
        const capture = async file => {
            const box = await page.locator('.process-forecast-charts').boundingBox();
            await page.screenshot({ path: file, clip: { x: 0, y: 0, width: 1280, height: Math.ceil(box.y + box.height + 12) } });
        };
        let index = 0;
        for (const [seconds, history, count] of [[40, 'latest', 1], [80, 'latest', 1], [80, 'recent', 3], [80, 'all', 4], [90, 'all', 4]]) {
            await scrub(seconds);
            await page.locator(`button[data-forecast-history-mode="${history}"]`).click();
            assert.equal(await page.locator('.forecast-trace').count(), count);
            await capture(path.join(frames, `${index++}.png`));
        }
        await scrub(80);
        await capture(path.join(media, 'forecast-replay.png'));
        await page.locator('#btn-forecast-replay-play').click();
        await page.locator('#btn-forecast-replay-pause').click();
        await page.locator('#btn-forecast-replay-reset').click();
        assert.equal(await page.locator('#forecast-replay-timeline').inputValue(), '0');
        await page.locator('#forecast-replay-speed').selectOption('30');
        await page.setViewportSize({ width: 390, height: 844 });
        await scrub(80);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
        await page.setViewportSize({ width: 390, height: 1800 });
        const mobileChart = await page.locator('.process-forecast-charts').boundingBox();
        await page.screenshot({ path: path.join(media, 'forecast-replay-mobile.png'), clip: { x: 0, y: 0, width: 390, height: Math.ceil(mobileChart.y + mobileChart.height + 12) } });
        assert.deepEqual(errors, []);
        execFileSync('ffmpeg', ['-y', '-framerate', '1/2', '-i', path.join(frames, '%d.png'), '-filter_complex', '[0:v]split[a][b];[a]palettegen[p];[b][p]paletteuse', '-loop', '0', path.join(media, 'forecast-replay.gif')], { stdio: 'ignore' });
        console.log('PASS: history 1/3/4, scrub, Play/Pause/Reset, speed, 390px layout, no page errors; media captured.');
    } finally {
        if (browser) await browser.close();
        server.close();
        fs.rmSync(frames, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
