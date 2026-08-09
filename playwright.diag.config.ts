import { defineConfig } from '@playwright/test';

/**
 * Harness for the diagnostics in e2e/diag/ — perf benchmarks and query-log
 * dumps that drive the developer's real local data and produce reports rather
 * than assertions. Kept out of the default config's glob on purpose; run one
 * explicitly:
 *   npx playwright test --config playwright.diag.config.ts e2e/diag/perf.diag.ts
 */
export default defineConfig({
  testDir: './e2e/diag',
  testMatch: '*.diag.ts',
  timeout: 300_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: 'list',
  workers: 1,
});
