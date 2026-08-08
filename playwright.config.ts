import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // Only top-level *.test.ts files are real suites. Diagnostics live in
  // e2e/diag/*.diag.ts and run via playwright.diag.config.ts.
  testMatch: '*.test.ts',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  retries: 0,
  reporter: 'list',
  workers: 1,
});
