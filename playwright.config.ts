import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  use: {
    baseURL: 'http://127.0.0.1:4173',
  },
  webServer: {
    command: 'python3 -m http.server 4173 --directory frontend/public',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
  },
});
