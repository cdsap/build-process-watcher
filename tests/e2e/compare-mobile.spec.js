const path = require('path');
const { test, expect } = require('@playwright/test');

test('populated compare page stays usable without document overflow on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('https://cdn.plot.ly/**', route => route.fulfill({
    contentType: 'text/javascript',
    body: `window.Plotly = {
      react(target, data) {
        const chart = typeof target === 'string' ? document.getElementById(target) : target;
        chart.data = data;
        chart.on = function () {};
        chart.innerHTML = '<div class="svg-container" style="width:100%;height:100%"></div>';
        return Promise.resolve(chart);
      },
      restyle() { return Promise.resolve(); }
    };`,
  }));

  await page.goto('/compare.html');
  const fixtures = name => path.join(__dirname, 'fixtures', name);
  await page.locator('#compare-a-input').setInputFiles(fixtures('run-a.json'));
  await page.locator('#compare-b-input').setInputFiles(fixtures('run-b.json'));

  await expect(page.getByRole('heading', { name: 'Process Comparison' })).toBeVisible();
  await expect(page.locator('#compare-rss .svg-container')).toBeVisible();

  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    chartWidth: document.querySelector('#compare-rss').getBoundingClientRect().width,
    chartContainerWidth: document.querySelector('#compare-rss').parentElement.getBoundingClientRect().width,
  }));
  expect(dimensions.scrollWidth).toBe(dimensions.clientWidth);
  expect(dimensions.chartWidth).toBeLessThanOrEqual(dimensions.chartContainerWidth);
  expect(dimensions.chartWidth).toBeLessThanOrEqual(390);

  const processGrid = page.locator('.compare-process-grid').first();
  await expect(processGrid).toHaveCSS('overflow-x', 'auto');
  expect(await processGrid.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);

  await page.locator('#btn-compare-replay-play').click();
  await expect(page.locator('#compare-replay-meta')).toContainText('Frame 2 / 2');
  await page.locator('#btn-compare-replay-reset').click();
  await expect(page.locator('#compare-replay-meta')).toContainText('Frame 1 / 2');
});
