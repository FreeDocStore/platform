import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  timeout: 30_000,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:4319', headless: true, ignoreHTTPSErrors: true },
  webServer: { command: 'node tests/browser/server.mjs', url: 'http://127.0.0.1:4319/_fixture', reuseExistingServer: false },
});
