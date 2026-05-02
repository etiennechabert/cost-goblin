import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';

const ROOT = join(import.meta.dirname, '..');
const DESKTOP_DIR = join(ROOT, 'packages', 'desktop');
const REPORT_DIR = join(tmpdir(), 'costgoblin-perf');
mkdirSync(REPORT_DIR, { recursive: true });

const SETTLE_TIMEOUT = 60_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface QueryLogEntry {
  readonly id: number;
  readonly sql: string;
  readonly paramCount: number;
  readonly status: 'queued' | 'running' | 'success' | 'error';
  readonly startedAt: number;
  readonly durationMs: number | null;
  readonly rowCount: number | null;
  readonly error: string | null;
}

interface QueryReport {
  readonly view: string;
  readonly queryId: number;
  readonly sql: string;
  readonly paramCount: number;
  readonly durationMs: number;
  readonly rowCount: number;
  readonly explainPlan: string;
}

interface ViewReport {
  readonly view: string;
  readonly totalQueries: number;
  readonly totalDurationMs: number;
  readonly queries: QueryReport[];
}

interface FullReport {
  readonly timestamp: string;
  readonly views: ViewReport[];
  readonly allQueriesSorted: QueryReport[];
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const viewReports: ViewReport[] = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function launchApp(): Promise<ElectronApplication> {
  return _electron.launch({
    args: [join(DESKTOP_DIR, 'out', 'main', 'main.js')],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      COSTGOBLIN_PERF_MODE: '1',
      COSTGOBLIN_DATA_DIR: join(homedir(), 'Library', 'Application Support', '@costgoblin', 'desktop', 'data'),
      COSTGOBLIN_CONFIG_DIR: join(homedir(), 'Library', 'Application Support', '@costgoblin', 'desktop', 'config'),
    },
  });
}

async function waitForAllQueriesComplete(page: Page): Promise<QueryLogEntry[]> {
  const deadline = Date.now() + SETTLE_TIMEOUT;
  let stableCount = 0;
  let lastLen = -1;
  while (Date.now() < deadline) {
    const log: QueryLogEntry[] = await page.evaluate(() =>
      globalThis.costgoblinDebug.getQueryLog(),
    );
    const allDone = log.every(e => e.status === 'success' || e.status === 'error');
    if (allDone && log.length > 0) return log;
    // If no queries appeared yet, wait a bit then give up after a few stable checks
    if (log.length === 0) {
      stableCount++;
      if (stableCount > 10) return []; // no queries triggered for this view
    } else if (log.length !== lastLen) {
      stableCount = 0;
    }
    lastLen = log.length;
    await page.waitForTimeout(500);
  }
  return page.evaluate(() => globalThis.costgoblinDebug.getQueryLog());
}

async function clearQueryLog(page: Page): Promise<void> {
  await page.evaluate(() => globalThis.costgoblinDebug.clearLog());
}

const MAX_EXPLAINS_PER_VIEW = 5;

async function collectViewQueries(page: Page, viewName: string): Promise<ViewReport> {
  const log = await waitForAllQueriesComplete(page);
  const completedQueries = log.filter(e => e.status === 'success' && e.durationMs !== null);
  // Also capture still-running queries (with estimated duration)
  const runningQueries = log.filter(e => e.status === 'running' || e.status === 'queued');

  // Sort completed by duration desc so we can run EXPLAIN only on the slowest
  completedQueries.sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0));

  const queries: QueryReport[] = [];

  for (let i = 0; i < completedQueries.length; i++) {
    const entry = completedQueries[i];
    if (entry === undefined) continue;

    let explainPlan = '';
    // Only run EXPLAIN on the top N slowest queries to save time
    if (i < MAX_EXPLAINS_PER_VIEW) {
      try {
        explainPlan = await page.evaluate(
          (qid) => globalThis.costgoblinDebug.runExplain(qid),
          entry.id,
        );
      } catch {
        explainPlan = 'EXPLAIN failed';
      }
    }

    queries.push({
      view: viewName,
      queryId: entry.id,
      sql: entry.sql,
      paramCount: entry.paramCount,
      durationMs: entry.durationMs ?? 0,
      rowCount: entry.rowCount ?? 0,
      explainPlan,
    });
  }

  // Record still-running queries with estimated time so far
  for (const entry of runningQueries) {
    const elapsed = Date.now() - entry.startedAt;
    queries.push({
      view: viewName,
      queryId: entry.id,
      sql: entry.sql,
      paramCount: entry.paramCount,
      durationMs: elapsed,
      rowCount: -1,
      explainPlan: `(query still ${entry.status} after ${String(elapsed)}ms)`,
    });
  }

  queries.sort((a, b) => b.durationMs - a.durationMs);

  const totalDurationMs = queries.reduce((sum, q) => sum + q.durationMs, 0);

  return {
    view: viewName,
    totalQueries: queries.length,
    totalDurationMs,
    queries,
  };
}

async function navigateAndCollect(
  page: Page,
  buttonName: string,
  headingName: string,
  viewName: string,
): Promise<void> {
  await clearQueryLog(page);
  await page.getByRole('button', { name: buttonName, exact: true }).first().click();
  await expect(page.getByRole('heading', { name: headingName })).toBeVisible({ timeout: 10_000 });
  // Wait for loading to finish
  try {
    await expect(page.getByText('Loading', { exact: false }).first()).toBeHidden({ timeout: SETTLE_TIMEOUT });
  } catch {
    // might never appear
  }
  await page.waitForTimeout(1000);

  const report = await collectViewQueries(page, viewName);
  viewReports.push(report);
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

function buildFullReport(): FullReport {
  const allQueries = viewReports.flatMap(vr => vr.queries);
  allQueries.sort((a, b) => b.durationMs - a.durationMs);

  return {
    timestamp: new Date().toISOString(),
    views: viewReports,
    allQueriesSorted: allQueries,
  };
}

function writeReports(report: FullReport): void {
  writeFileSync(join(REPORT_DIR, 'query-report.json'), JSON.stringify(report, null, 2));

  const lines: string[] = [];
  lines.push('# CostGoblin Query Performance Report');
  lines.push('');
  lines.push(`Generated: ${report.timestamp}`);
  lines.push('');

  // Summary table
  lines.push('## View Summary');
  lines.push('');
  lines.push('| View | Queries | Total Duration (ms) | Slowest Query (ms) |');
  lines.push('|------|---------|--------------------|--------------------|');
  for (const vr of report.views) {
    const slowest = vr.queries[0]?.durationMs ?? 0;
    lines.push(`| ${vr.view} | ${String(vr.totalQueries)} | ${String(vr.totalDurationMs)} | ${String(slowest)} |`);
  }
  lines.push('');

  // Top 20 slowest queries
  lines.push('## Top 20 Slowest Queries');
  lines.push('');
  const top20 = report.allQueriesSorted.slice(0, 20);
  for (let i = 0; i < top20.length; i++) {
    const q = top20[i];
    if (q === undefined) continue;
    lines.push(`### ${String(i + 1)}. ${q.view} (${String(q.durationMs)}ms, ${String(q.rowCount)} rows)`);
    lines.push('');
    lines.push('```sql');
    lines.push(q.sql.trim());
    lines.push('```');
    lines.push('');
    lines.push('<details><summary>EXPLAIN ANALYZE</summary>');
    lines.push('');
    lines.push('```');
    lines.push(q.explainPlan);
    lines.push('```');
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  // Per-view detail
  lines.push('## Per-View Query Detail');
  lines.push('');
  for (const vr of report.views) {
    lines.push(`### ${vr.view}`);
    lines.push('');
    lines.push(`Total: ${String(vr.totalQueries)} queries, ${String(vr.totalDurationMs)}ms`);
    lines.push('');
    if (vr.queries.length > 0) {
      lines.push('| # | Duration (ms) | Rows | Params | SQL Preview |');
      lines.push('|---|---------------|------|--------|-------------|');
      for (let i = 0; i < vr.queries.length; i++) {
        const q = vr.queries[i];
        if (q === undefined) continue;
        const sqlPreview = q.sql.replace(/\s+/g, ' ').trim().slice(0, 80);
        lines.push(`| ${String(i + 1)} | ${String(q.durationMs)} | ${String(q.rowCount)} | ${String(q.paramCount)} | ${sqlPreview} |`);
      }
      lines.push('');
    }
  }

  const md = lines.join('\n');
  writeFileSync(join(REPORT_DIR, 'query-report.md'), md);

  process.stdout.write('\n');
  process.stdout.write(md);
  process.stdout.write('\n');
  process.stdout.write(`\nQuery report:  ${REPORT_DIR}/query-report.md\n`);
  process.stdout.write(`Raw JSON:      ${REPORT_DIR}/query-report.json\n\n`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Query Performance Diagnostics', () => {
  test.setTimeout(300_000);

  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    app = await launchApp();
    page = await app.firstWindow();
    await expect(page).toHaveTitle('CostGoblin');
    // App opens on Cost Overview by default -- wait for it to fully load
    await expect(page.getByRole('heading', { name: 'Cost Overview' })).toBeVisible({ timeout: 15_000 });
    // Wait for loading indicators to clear
    try {
      await expect(page.getByText('Loading', { exact: false }).first()).toBeHidden({ timeout: 60_000 });
    } catch { /* */ }
    // Wait for the materialized base warmup to complete in the background.
    // This is critical -- without it, subsequent views will read raw Parquet.
    await page.waitForTimeout(10_000);
  });

  test.afterAll(async () => {
    const report = buildFullReport();
    writeReports(report);
    await app.close();
  });

  test('Cost Overview', async () => {
    // The app opens on Cost Overview -- wait for all initial queries to settle
    // instead of navigating. The query log already contains the startup queries.
    try {
      await expect(page.getByText('Loading', { exact: false }).first()).toBeHidden({ timeout: SETTLE_TIMEOUT });
    } catch { /* */ }
    await page.waitForTimeout(1000);
    const report = await collectViewQueries(page, 'Cost Overview');
    viewReports.push(report);
  });

  test('Trends', async () => {
    await clearQueryLog(page);
    await page.getByRole('button', { name: 'Trends', exact: true }).first().click();
    await expect(page.getByRole('heading', { name: 'Cost Trends' })).toBeVisible({ timeout: 10_000 });
    // Trends reads double the data (current + previous period). The query can
    // genuinely take minutes from raw Parquet since it needs the previous period
    // which falls outside the materialized base. Wait up to 3 minutes.
    try {
      await expect(page.getByText('Loading', { exact: false }).first()).toBeHidden({ timeout: 180_000 });
    } catch { /* timed out waiting for loading to finish */ }
    await page.waitForTimeout(2000);
    const report = await collectViewQueries(page, 'Trends');
    viewReports.push(report);
  });

  test('Missing Tags', async () => {
    await navigateAndCollect(page, 'Missing Tags', 'Missing Tags', 'Missing Tags');
  });

  test('Savings', async () => {
    await navigateAndCollect(page, 'Savings', 'Savings Opportunities', 'Savings');
  });

  test('Explorer', async () => {
    await navigateAndCollect(page, 'Explorer', 'Explorer', 'Explorer');
  });

  test('Entity Detail', async () => {
    // First navigate to Trends so we can click an entity
    await page.getByRole('button', { name: 'Trends', exact: true }).first().click();
    await expect(page.getByRole('heading', { name: 'Cost Trends' })).toBeVisible({ timeout: 10_000 });
    try {
      await expect(page.getByText('Loading', { exact: false }).first()).toBeHidden({ timeout: SETTLE_TIMEOUT });
    } catch { /* */ }
    await page.waitForTimeout(500);

    const entityLink = page.locator('table button.text-accent').first();
    const visible = await entityLink.isVisible().catch(() => false);
    if (!visible) {
      viewReports.push({
        view: 'Entity Detail',
        totalQueries: 0,
        totalDurationMs: 0,
        queries: [],
      });
      return;
    }

    await clearQueryLog(page);
    await entityLink.click();
    await expect(page.getByRole('button', { name: '← Back' })).toBeVisible({ timeout: 10_000 });
    try {
      await expect(page.getByText('Loading', { exact: false }).first()).toBeHidden({ timeout: SETTLE_TIMEOUT });
    } catch { /* */ }
    await page.waitForTimeout(500);

    const report = await collectViewQueries(page, 'Entity Detail');
    viewReports.push(report);

    // Go back
    await page.getByRole('button', { name: '← Back' }).click();
    await page.waitForTimeout(300);
  });

  test('Cost Scope', async () => {
    await clearQueryLog(page);
    await page.getByRole('button', { name: 'Cost Scope', exact: true }).first().click();
    await expect(page.getByRole('heading', { name: 'Cost Scope' })).toBeVisible({ timeout: 10_000 });
    // Cost Scope has its own preview loading mechanism
    await page.waitForTimeout(400);
    const marker = page.getByTestId('preview-loading');
    try {
      await expect(marker).toBeHidden({ timeout: SETTLE_TIMEOUT });
    } catch { /* */ }
    await page.waitForTimeout(500);

    const report = await collectViewQueries(page, 'Cost Scope');
    viewReports.push(report);
  });

  test('Dimensions', async () => {
    await navigateAndCollect(page, 'Dimensions', 'Dimensions', 'Dimensions');
  });

  test('Views Editor', async () => {
    await navigateAndCollect(page, 'Views', 'Views', 'Views Editor');
  });

  test('Data Management', async () => {
    await navigateAndCollect(page, 'Sync', 'Data Management', 'Data Management');
  });

  test('Custom Views', async () => {
    // Look for nav buttons that might be custom views (not the standard nav items)
    const standardViews = new Set([
      'Cost Overview', 'Trends', 'Missing Tags', 'Savings', 'Explorer',
      'Cost Scope', 'Dimensions', 'Views', 'Sync',
    ]);

    const navButtons = page.locator('nav button');
    const count = await navButtons.count();
    for (let i = 0; i < count; i++) {
      const btn = navButtons.nth(i);
      const name = await btn.textContent().catch(() => '');
      if (name === null || name.trim().length === 0) continue;
      const trimmed = name.trim();
      if (standardViews.has(trimmed)) continue;
      // Skip UI-only buttons like theme toggle, etc.
      if (trimmed.length < 2) continue;

      await clearQueryLog(page);
      await btn.click();
      try {
        await expect(page.getByText('Loading', { exact: false }).first()).toBeHidden({ timeout: SETTLE_TIMEOUT });
      } catch { /* */ }
      await page.waitForTimeout(500);

      const report = await collectViewQueries(page, `Custom: ${trimmed}`);
      if (report.totalQueries > 0) {
        viewReports.push(report);
      }
    }

    // Mark test as passed even if no custom views found
    expect(true).toBe(true);
  });
});
