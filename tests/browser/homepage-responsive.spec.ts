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

  const tableRegion = page.locator('.table-card');
  const tableWidths = await tableRegion.evaluate(element => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(tableWidths.scrollWidth).toBeGreaterThan(tableWidths.clientWidth);
});
