const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const runPage = fs.readFileSync(
  path.join(__dirname, '../../frontend/public/runs/[runId].html'),
  'utf8',
);

function contentTypeFor(pathname) {
  if (pathname.endsWith('.css')) return 'text/css';
  if (pathname.endsWith('.js')) return 'text/javascript';
  if (pathname.endsWith('.json')) return 'application/json';
  if (pathname.endsWith('.svg')) return 'image/svg+xml';
  return 'text/plain';
}

async function serveRunPage(page) {
  await page.route('https://cdn.plot.ly/**', route => route.fulfill({
    contentType: 'text/javascript',
    body: '',
  }));
  await page.route('https://frontend.test/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.startsWith('/runs/')) {
      return route.fulfill({ contentType: 'text/html', body: runPage });
    }
    const assetPath = path.join(__dirname, '../../frontend/public', pathname.replace(/^\//, ''));
    if (fs.existsSync(assetPath) && fs.statSync(assetPath).isFile()) {
      return route.fulfill({
        contentType: contentTypeFor(pathname),
        body: fs.readFileSync(assetPath, 'utf8'),
      });
    }
    return route.fulfill({ contentType: 'text/javascript', body: '' });
  });
}

function isBackendRunRequest(url, runId) {
  const parsed = new URL(url);
  // CI rewrites config.js to test-backend.example.com before a second browser run.
  // Match any backend host, but never the frontend page URL itself.
  return parsed.hostname !== 'frontend.test'
    && parsed.pathname.replace(/\/$/, '') === `/runs/${runId}`;
}

test('shows actions and user-oriented copy for a missing run', async ({ page }) => {
  await serveRunPage(page);
  await page.route(
    (url) => isBackendRunRequest(url, 'frontend-qa-missing-run'),
    (route) => route.fulfill({ status: 404 }),
  );

  await page.goto('https://frontend.test/runs/frontend-qa-missing-run');

  await expect(page.getByRole('heading', { name: 'Run Unavailable' })).toBeVisible();
  await expect(page.getByText(/link may be incorrect, or the run may have expired/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to Home' })).toBeVisible();
  await expect(page.locator('#content')).not.toContainText('Failed to fetch');
});

test('distinguishes a server failure from a missing run', async ({ page }) => {
  await serveRunPage(page);
  await page.route(
    (url) => isBackendRunRequest(url, 'frontend-qa-server-error'),
    (route) => route.fulfill({ status: 503 }),
  );

  await page.goto('https://frontend.test/runs/frontend-qa-server-error');

  await expect(page.getByRole('heading', { name: 'Run Temporarily Unavailable' })).toBeVisible();
  await expect(page.getByText(/service could not load this run right now/i)).toBeVisible();
});

test('distinguishes a connectivity failure and retries the request', async ({ page }) => {
  await serveRunPage(page);
  let attempts = 0;
  await page.route((url) => isBackendRunRequest(url, 'frontend-qa-offline-run'), async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await route.abort('failed');
    } else {
      await route.fulfill({ status: 404 });
    }
  });

  await page.goto('https://frontend.test/runs/frontend-qa-offline-run');

  await expect(page.getByRole('heading', { name: 'Unable to Connect' })).toBeVisible();
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByRole('heading', { name: 'Run Unavailable' })).toBeVisible();
  expect(attempts).toBe(2);
});
