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
  test(`activity replay preserves issuance history and count units at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await page.setContent('<main id="activity"></main><link rel="stylesheet" href="/bpw-ui.css">');
    await page.addScriptTag({ url: '/prediction-view.js' });
    await page.evaluate(data => {
      window.activityTestController = window.BpwPredictionView.bindProcessForecastView(document.getElementById('activity'), { data });
    }, fixture());
    await expect(page.getByRole('heading', { name: /Class-loading activity/ })).toBeVisible();
    await expect(page.locator('svg line[stroke-dasharray]')).toHaveCount(1);
    await page.getByLabel('Class-loading issuance history', { exact: true }).selectOption('all');
    await expect(page.locator('svg line[stroke-dasharray]')).toHaveCount(4);
    const slider = page.getByLabel('Class-loading replay timeline');
    await slider.fill('1700000055000'); await slider.dispatchEvent('change');
    await expect(page.locator('svg line[stroke-dasharray]')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('Predicted additional classes');
    await slider.fill('1700000060000'); await slider.dispatchEvent('change');
    await expect(page.locator('body')).toContainText('Observed increase: Pending');
    await slider.fill('1700000180000'); await slider.dispatchEvent('change');
    await expect(page.locator('body')).toContainText('Observed increase: 1200');
    await expect(page.locator('body')).not.toContainText('MB');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: 'Play / pause' }).click();
    await page.getByRole('button', { name: 'Play / pause' }).click();
    await page.evaluate(() => window.activityTestController.stop());
  });
}

test('uploaded class-loading JSON appears in Replay and follows its main clock', async ({ page }) => {
  // This test exercises the count panel; memory Plotly rendering is covered elsewhere.
  await page.route('https://cdn.plot.ly/**', route => route.fulfill({ contentType: 'text/javascript', body: `window.Plotly={react(target,data){const node=typeof target==='string'?document.getElementById(target):target;node.data=data;node.on=()=>{};return Promise.resolve(node);},restyle(){return Promise.resolve();},relayout(){return Promise.resolve();}};` }));
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
