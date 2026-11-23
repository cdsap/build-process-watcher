const { test, expect } = require('@playwright/test');

function fixture() {
  const start = 1700000000000;
  return {
    prediction_mode: 'tabpfn', prediction_target: 'class_loading', finished: true,
    samples: Array.from({ length: 37 }, (_, i) => ({ Name: 'GradleDaemon', PID: '1', Timestamp: start + i * 5000, ElapsedTime: i * 5, ClassesLoaded: 24000 + i * 100, HeapUsed: 128, RSS: 256 })),
    process_activity_forecasts: [60, 80, 100, 120].map(t => ({ process_name: 'GradleDaemon', pid: '1', metric: 'classes_loaded', created_at_ms: start + t * 1000, origin_value_count: 24000 + t * 20, status: 'ready', method: 'tabpfn', model_version: 'synthetic-ui-test', points: [{ target_at_ms: start + (t + 60) * 1000, predicted_delta_count: 1200, predicted_total_count: 25200 + t * 20 }] })),
  };
}

for (const width of [390, 1280]) {
  test(`activity replay preserves issuance history and count units at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await page.setContent('<main id="activity"></main><link rel="stylesheet" href="/bpw-ui.css">');
    await page.addScriptTag({ url: '/prediction-view.js' });
    await page.evaluate(data => {
      window.activityTestController = window.BpwPredictionView.bindProcessForecastView(document.getElementById('activity'), { data });
    }, fixture());
    await expect(page.getByRole('heading', { name: /Class-loading activity/ })).toBeVisible();
    await expect(page.locator('svg .forecast-trace-issuance')).toHaveCount(1);
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await expect(page.locator('svg .forecast-trace-issuance')).toHaveCount(4);
    const slider = page.getByLabel('Class-loading replay timeline');
    await slider.fill('1700000055000'); await slider.dispatchEvent('change');
    await expect(page.locator('svg .forecast-trace-issuance')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('Predicted additional classes');
    await slider.fill('1700000060000'); await slider.dispatchEvent('change');
    await expect(page.locator('body')).toContainText('Observed increase: Pending');
    await slider.fill('1700000180000'); await slider.dispatchEvent('change');
    await expect(page.locator('body')).toContainText('Observed increase: 1200');
    await expect(page.locator('body')).not.toContainText('MB');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator('.forecast-chart-legend')).toBeVisible();
    await expect(page.locator('svg .chart-grid').first()).toBeAttached();
    await page.screenshot({path: testInfo.outputPath(`class-loading-style-${width}.png`), fullPage: true});
    await page.getByRole('button', { name: 'Last 3', exact: true }).click();
    await expect(page.locator('svg .forecast-trace-issuance')).toHaveCount(3);
    await page.getByRole('button', { name: 'Live', exact: true }).click();
    expect(await page.evaluate(() => window.activityTestController.getMode())).toBe('live');
    await page.getByRole('button', { name: 'Replay', exact: true }).click();
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await page.getByRole('button', { name: 'Reset', exact: true }).click();
    await expect(page.locator('svg .forecast-trace-issuance')).toHaveCount(0);
    await page.getByLabel('Prediction replay speed').selectOption('30');
    await page.evaluate(() => window.activityTestController.stop());
  });
}

test('uploaded class-loading JSON appears in Replay and follows its main clock', async ({ page }) => {
  // This test exercises the count panel; memory Plotly rendering is covered elsewhere.
  await page.route('https://cdn.plot.ly/**', route => route.fulfill({ contentType: 'text/javascript', body: `window.Plotly={Plots:{resize(){}},react(target,data){const node=typeof target==='string'?document.getElementById(target):target;node.data=data;node.on=()=>{};return Promise.resolve(node);},restyle(){return Promise.resolve();},relayout(){return Promise.resolve();}};` }));
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/replay.html');
  await page.locator('#replay-input').setInputFiles({ name: 'synthetic-activity.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture())) });
  await expect(page.getByRole('heading', { name: /Class-loading activity/ })).toBeVisible();
  await page.locator('#btn-single-reset').click();
  await expect(page.locator('.activity-panel')).not.toContainText('Predicted additional classes');
  expect(errors).toEqual([]);
  await page.locator('#replay-input').setInputFiles({ name: 'legacy-memory.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ samples: fixture().samples })) });
  await expect(page.locator('.activity-panel')).toHaveCount(0);
});


test('finished run dashboard binds activity controls to the loaded run on first render', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('https://cdn.plot.ly/**', route => route.fulfill({ contentType: 'text/javascript', body: `window.Plotly={Plots:{resize(){}},newPlot(target,data){return this.react(target,data);},react(target,data){const node=typeof target==='string'?document.getElementById(target):target;node.data=data;node.on=()=>{};return Promise.resolve(node);},restyle(){return Promise.resolve();},relayout(){return Promise.resolve();}};` }));
  await page.route('**/config.js', route => route.fulfill({ contentType: 'text/javascript', body: "window.BUILD_PROCESS_WATCHER_CONFIG={backendUrl:'http://127.0.0.1:4173'};" }));
  await page.route('http://127.0.0.1:4173/runs/activity-first-load', route => route.fulfill({ json: fixture() }));
  await page.route('http://127.0.0.1:4173/runs/activity-first-load-page', async route => {
    const fs = require('fs');
    await route.fulfill({ contentType: 'text/html', body: fs.readFileSync('frontend/public/runs/[runId].html', 'utf8').replace("mode: 'live'", "mode: 'live', runId: 'activity-first-load'") });
  });
  await page.goto('/runs/activity-first-load-page');
  await page.locator('[data-bpw-view-mode="predictions"]').first().click();
  await expect(page.getByRole('table', { name: 'Class-loading issuance results' })).toBeVisible();
  const slider = page.getByLabel('Class-loading replay timeline');
  await slider.fill('1700000055000'); await slider.dispatchEvent('change');
  await expect(page.getByRole('table', { name: 'Class-loading issuance results' })).toHaveCount(0);
  await expect(page.locator('svg .forecast-trace-issuance')).toHaveCount(0);
  await slider.fill('1700000180000'); await slider.dispatchEvent('change');
  await expect(page.getByRole('table', { name: 'Class-loading issuance results' })).toContainText('1200');
  expect(errors).toEqual([]);
});
