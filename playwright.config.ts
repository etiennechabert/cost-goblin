import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // Only top-level *.test.ts files are real suites. Diagnostics live in
  // e2e/diag/*.diag.ts and run via playwright.diag.config.ts.
  testMatch: '*.test.ts',
  // Fixture parquet is generated, not committed — build it before any suite.
  globalSetup: './e2e/global-setup.ts',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  retries: 0,
  reporter: 'list',
  workers: 1,
});
