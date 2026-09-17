import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI === 'true'
    ? [['line'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  webServer: {
    command: 'DATA_FILE=.data/browser-state.json PORT=4173 HOST=127.0.0.1 NODE_ENV=test npm run server',
    url: 'http://127.0.0.1:4173/api/health',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
