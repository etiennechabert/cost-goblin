import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['html'], ['list']] : 'list',
  fullyParallel: false,
  workers: 1,
  webServer: {
    command: 'npm run build --workspace=packages/desktop',
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
    reuseExistingServer: !process.env.CI,
  },
});
