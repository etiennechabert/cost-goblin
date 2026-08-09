/**
 * DIAGNOSTIC, not a test suite — boots against the developer's real local
 * data dirs and compares the query log of the first vs second Cost Overview
 * load to check the materialized base kicks in. Excluded from
 * `npx playwright test` (playwright.config.ts testMatch); run explicitly with:
 *   npx playwright test --config playwright.diag.config.ts e2e/diag/debug-query-count.diag.ts
 */
import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { join } from 'node:path';
import { homedir } from 'node:os';

const ROOT = join(import.meta.dirname, '..', '..');
const DESKTOP_DIR = join(ROOT, 'packages', 'desktop');

function launchApp(): Promise<ElectronApplication> {
  return _electron.launch({
    args: [join(DESKTOP_DIR, 'out', 'main', 'main.js')],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      COSTGOBLIN_DATA_DIR: join(homedir(), 'Library', 'Application Support', '@costgoblin', 'desktop', 'data'),
      COSTGOBLIN_CONFIG_DIR: join(homedir(), 'Library', 'Application Support', '@costgoblin', 'desktop', 'config'),
    },
  });
}

interface LogEntry {
  id: number;
  sql: string;
  status: string;
  durationMs: number | null;
  rowCount: number | null;
}

async function waitForAllComplete(page: Page, timeoutMs = 30_000): Promise<LogEntry[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const log: LogEntry[] = await page.evaluate(() => globalThis.costgoblinDebug.getQueryLog());
    const allDone = log.length > 0 && log.every(e => e.status === 'success' || e.status === 'error');
    if (allDone) return log;
    await page.waitForTimeout(300);
  }
  return page.evaluate(() => globalThis.costgoblinDebug.getQueryLog());
}

function printLog(log: LogEntry[]): void {
  for (const entry of log) {
    const status = entry.status === 'success' ? 'OK' : entry.status === 'error' ? 'ERR' : entry.status;
    const duration = entry.durationMs !== null ? `${String(entry.durationMs)}ms` : '...';
    const rows = entry.rowCount !== null ? `${String(entry.rowCount)}r` : '';
    const usesBase = entry.sql.includes('cost_base') ? ' [MAT]' : '';
    const sqlPreview = entry.sql.replace(/\s+/g, ' ').trim().slice(0, 100);
    console.log(`[${String(entry.id).padStart(2)}] ${status.padEnd(4)} ${duration.padStart(7)} ${rows.padStart(6)}${usesBase}  ${sqlPreview}`);
  }
}

test('materialized base: first vs second load', async () => {
  const app = await launchApp();
  const page = await app.firstWindow();
  await expect(page).toHaveTitle('CostGoblin');
  await expect(page.getByRole('heading', { name: 'Cost Overview' })).toBeVisible({ timeout: 10_000 });

  const firstLog = await waitForAllComplete(page);
  console.log(`\n=== FIRST LOAD: ${String(firstLog.length)} queries ===`);
  printLog(firstLog);

  // Wait extra for the warmup to complete (it runs on raw db, not through query log)
  await page.waitForTimeout(5000);

  // Check if cost_base table exists by running a query against it
  const tableExists = await page.evaluate(async () => {
    try {
      await globalThis.costgoblin.cancelPendingQueries();
      // If we can get the query log, the IPC works. Check materialized status.
      const result = await (window as Record<string, unknown>)['electron'];
      return 'cant-check-from-renderer';
    } catch {
      return 'error';
    }
  });
  console.log(`\nTable check: ${String(tableExists)}`);

  // Navigate away
  await page.getByRole('button', { name: 'Trends', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Cost Trends' })).toBeVisible({ timeout: 5000 });
  await page.waitForTimeout(2000);

  // Clear log and navigate back
  await page.evaluate(async () => { await globalThis.costgoblinDebug.clearLog(); });
  await page.getByRole('button', { name: 'Cost Overview', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Cost Overview' })).toBeVisible({ timeout: 5000 });

  const secondLog = await waitForAllComplete(page);
  console.log(`\n=== SECOND LOAD: ${String(secondLog.length)} queries ===`);
  printLog(secondLog);

  const matUsed = secondLog.some(e => e.sql.includes('cost_base'));
  console.log(`\nMaterialized base used: ${String(matUsed)}`);

  const firstMax = Math.max(0, ...firstLog.filter(e => e.durationMs !== null).map(e => e.durationMs ?? 0));
  const secondMax = Math.max(0, ...secondLog.filter(e => e.durationMs !== null).map(e => e.durationMs ?? 0));
  console.log(`First load max query:  ${String(firstMax)}ms`);
  console.log(`Second load max query: ${String(secondMax)}ms`);

  await app.close();
});
