import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 } });

test('homepage stays within a 390px mobile viewport', async ({ page }) => {
  await page.goto('/');

  const documentWidth = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(documentWidth.scrollWidth).toBe(documentWidth.clientWidth);

  const horizontalBounds = await page
    .locator('.snippet-card, .table-card, .home-nav, .hero-actions')
    .evaluateAll(elements => elements.map(element => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right };
    }));
  for (const bounds of horizontalBounds) {
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(documentWidth.clientWidth);
  }

  for (const tableRegion of await page.locator('.table-card').all()) {
    const tableWidths = await tableRegion.evaluate(element => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(tableWidths.scrollWidth).toBeGreaterThan(tableWidths.clientWidth);
  }
});

for (const width of [390, 1280]) {
  test(`prediction choices and snippets remain keyboard accessible at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    const modeLink = page.getByRole('link', { name: 'Choose a prediction mode' });
    await modeLink.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#prediction$/);
    const prediction = page.locator('#prediction');
    await expect(prediction.getByRole('heading', { name: 'Choose a timeline forecast request.' })).toBeInViewport();
    await expect(prediction.locator('tbody tr')).toHaveCount(5);
    await expect(prediction).toContainText('Selecting the input does not start the VM');
    const region = prediction.getByRole('region', { name: 'Prediction modes', exact: false });
    await region.focus();
    await expect(region).toBeFocused();
    if (width === 390) {
      await page.keyboard.press('ArrowRight');
      await expect.poll(() => region.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
    }
    await page.keyboard.press('Tab');
    await expect(prediction.getByRole('link', { name: 'cadence guide' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(prediction.locator('pre')).toBeFocused();
    await expect(prediction.locator('pre')).toContainText("prediction_throttle_s: '20'");

    const sizes = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth,
    }));
    expect(sizes.page).toBe(sizes.viewport);
    for (const snippet of await page.locator('pre').all()) {
      await expect(snippet).toHaveAttribute('tabindex', '0');
    }
  });
}
