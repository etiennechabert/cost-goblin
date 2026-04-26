import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { join } from 'node:path';
import { homedir } from 'node:os';

const ROOT = join(import.meta.dirname, '..');
const DESKTOP_DIR = join(ROOT, 'packages', 'desktop');

test('run EXPLAIN ANALYZE on Cost Overview queries', async () => {
  const app = await _electron.launch({
    args: [join(DESKTOP_DIR, 'out', 'main', 'main.js')],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      COSTGOBLIN_DATA_DIR: join(homedir(), 'Library', 'Application Support', '@costgoblin', 'desktop', 'data'),
      COSTGOBLIN_CONFIG_DIR: join(homedir(), 'Library', 'Application Support', '@costgoblin', 'desktop', 'config'),
    },
  });
  const page = await app.firstWindow();
  await expect(page).toHaveTitle('CostGoblin');
  await expect(page.getByRole('heading', { name: 'Cost Overview' })).toBeVisible({ timeout: 10_000 });

  // Wait for all queries to complete
  await page.waitForTimeout(8000);

  const log: { id: number; sql: string; status: string; durationMs: number | null; rowCount: number | null }[] =
    await page.evaluate(() => globalThis.costgoblinDebug.getQueryLog());

  const completed = log.filter(e => e.status === 'success');
  console.log(`\n${String(completed.length)} completed queries. Running EXPLAIN ANALYZE on the first 3...\n`);

  // Pick representative queries: shortest SQL (simple), longest duration, and the table data query
  const sorted = [...completed].sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0));
  const picks = sorted.slice(0, 3);

  for (const entry of picks) {
    const preview = entry.sql.replace(/\s+/g, ' ').trim().slice(0, 100);
    console.log(`\n${'='.repeat(80)}`);
    console.log(`Query #${String(entry.id)} — ${String(entry.durationMs)}ms — ${String(entry.rowCount)} rows`);
    console.log(`SQL: ${preview}...`);
    console.log(`${'='.repeat(80)}`);

    const explain: string = await page.evaluate(
      (qid) => globalThis.costgoblinDebug.runExplain(qid),
      entry.id,
    );
    console.log(explain);
  }

  await app.close();
});
