const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  outputDir: '/tmp/bpw-playwright-test-results',
  use: {
    baseURL: 'http://127.0.0.1:4173',
  },
  webServer: {
    command: 'node tests/e2e/static-server.js',
    url: 'http://127.0.0.1:4173/compare.html',
    reuseExistingServer: true,
  },
});
