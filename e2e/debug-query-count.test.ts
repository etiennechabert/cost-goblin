import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { join } from 'node:path';
import { homedir } from 'node:os';

const ROOT = join(import.meta.dirname, '..');
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

test('capture Cost Overview query log', async () => {
  const app = await launchApp();
  const page = await app.firstWindow();
  await expect(page).toHaveTitle('CostGoblin');

  // Wait for Cost Overview to fully load
  await expect(page.getByRole('heading', { name: 'Cost Overview' })).toBeVisible({ timeout: 10_000 });

  // Wait for queries to settle — no more "Loading" text
  try {
    await expect(page.getByText('Loading', { exact: false }).first()).toBeHidden({ timeout: 15_000 });
  } catch { /* may never appear */ }
  await page.waitForTimeout(3000);

  // Read the query log from the debug API
  const log = await page.evaluate(() => globalThis.costgoblinDebug.getQueryLog());

  console.log(`\n=== TOTAL QUERIES: ${String(log.length)} ===\n`);

  for (const entry of log) {
    const status = entry.status === 'success' ? 'OK' : entry.status === 'error' ? 'ERR' : entry.status;
    const duration = entry.durationMs !== null ? `${String(entry.durationMs)}ms` : '...';
    const rows = entry.rowCount !== null ? `${String(entry.rowCount)}r` : '';
    const sqlPreview = entry.sql.replace(/\s+/g, ' ').trim().slice(0, 120);
    console.log(`[${String(entry.id).padStart(2)}] ${status.padEnd(7)} ${duration.padStart(8)} ${rows.padStart(6)}  ${sqlPreview}`);
  }

  console.log(`\n=== BREAKDOWN ===`);
  const bySqlPrefix = new Map<string, number>();
  for (const entry of log) {
    const prefix = entry.sql.replace(/\s+/g, ' ').trim().slice(0, 60);
    bySqlPrefix.set(prefix, (bySqlPrefix.get(prefix) ?? 0) + 1);
  }
  for (const [prefix, count] of [...bySqlPrefix.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(2)}x  ${prefix}`);
  }

  await app.close();
});
