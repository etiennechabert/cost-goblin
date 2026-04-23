import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';

const ROOT = join(import.meta.dirname, '..');
const DESKTOP_DIR = join(ROOT, 'packages', 'desktop');
const REPORT_DIR = join(tmpdir(), 'costgoblin-perf');
mkdirSync(REPORT_DIR, { recursive: true });

const LOAD_TIMEOUT = 30_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface IpcTiming {
  channel: string;
  durationMs: number;
  timestamp: string;
}

interface RenderTiming {
  id: string;
  phase: string;
  actualDuration: number;
  baseDuration: number;
  startTime: number;
  commitTime: number;
}

interface PerfResult {
  name: string;
  wallClockMs: number;
  ipcCalls: number;
  ipcTotalMs: number;
  ipcTimings: IpcTiming[];
  reactRenders: number;
  reactTotalMs: number;
  reactTimings: RenderTiming[];
  heapBeforeMB: number;
  heapAfterMB: number;
  heapDeltaMB: number;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const results: PerfResult[] = [];
const cpuProfiles: { label: string; path: string }[] = [];

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

async function waitForQuerySettle(page: Page): Promise<void> {
  try {
    await expect(page.getByText('Loading', { exact: false }).first()).toBeHidden({ timeout: LOAD_TIMEOUT });
  } catch {
    // Loading text might never have appeared
  }
  await page.waitForTimeout(300);
}

async function waitForCostScopePreview(page: Page): Promise<void> {
  await page.waitForTimeout(400);
  const marker = page.getByTestId('preview-loading');
  try {
    await expect(marker).toBeHidden({ timeout: LOAD_TIMEOUT });
  } catch { /* may have finished */ }
  await page.waitForTimeout(200);
}

function heapMB(bytes: number): number {
  return Math.round(bytes / 1024 / 1024 * 10) / 10;
}

async function getHeap(page: Page): Promise<number> {
  return page.evaluate(() => {
    const perf = performance as any;
    return perf.memory ? perf.memory.usedJSHeapSize : 0;
  });
}

async function measure(
  page: Page,
  name: string,
  action: () => Promise<void>,
): Promise<void> {
  // Clear accumulators
  await page.evaluate(() => {
    if (window.costgoblinPerf) window.costgoblinPerf.clearIpcTimings();
    if (window.__PERF_REACT__) window.__PERF_REACT__.length = 0;
  });

  const heapBefore = await getHeap(page);
  const start = Date.now();

  await action();

  const wallClockMs = Date.now() - start;
  const heapAfter = await getHeap(page);

  const ipcTimings: IpcTiming[] = await page.evaluate(() =>
    window.costgoblinPerf ? window.costgoblinPerf.getIpcTimings() : [],
  );
  const reactTimings: RenderTiming[] = await page.evaluate(() =>
    window.__PERF_REACT__ ? [...window.__PERF_REACT__] : [],
  );

  results.push({
    name,
    wallClockMs,
    ipcCalls: ipcTimings.length,
    ipcTotalMs: Math.round(ipcTimings.reduce((s, t) => s + t.durationMs, 0) * 100) / 100,
    ipcTimings,
    reactRenders: reactTimings.length,
    reactTotalMs: Math.round(reactTimings.reduce((s, t) => s + t.actualDuration, 0) * 100) / 100,
    reactTimings,
    heapBeforeMB: heapMB(heapBefore),
    heapAfterMB: heapMB(heapAfter),
    heapDeltaMB: heapMB(heapAfter - heapBefore),
  });
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function writeReport(): void {
  // JSON (full detail)
  writeFileSync(join(REPORT_DIR, 'results.json'), JSON.stringify({ results, cpuProfiles }, null, 2));

  // Markdown summary
  const lines: string[] = [];
  lines.push('# CostGoblin Performance Report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('| Scenario | TTI (ms) | IPC calls | IPC total (ms) | Renders | Render (ms) | Heap Δ (MB) |');
  lines.push('|----------|----------|-----------|----------------|---------|-------------|-------------|');
  for (const r of results) {
    lines.push(
      `| ${r.name} | ${String(r.wallClockMs)} | ${String(r.ipcCalls)} | ${String(r.ipcTotalMs)} | ${String(r.reactRenders)} | ${String(r.reactTotalMs)} | ${r.heapDeltaMB >= 0 ? '+' : ''}${String(r.heapDeltaMB)} |`,
    );
  }
  lines.push('');

  // IPC breakdown per scenario (top 5 slowest channels)
  lines.push('## IPC Breakdown (top 5 slowest per scenario)');
  lines.push('');
  for (const r of results) {
    if (r.ipcTimings.length === 0) continue;
    lines.push(`### ${r.name}`);
    lines.push('');
    lines.push('| Channel | Duration (ms) |');
    lines.push('|---------|---------------|');
    const sorted = [...r.ipcTimings].sort((a, b) => b.durationMs - a.durationMs);
    for (const t of sorted.slice(0, 5)) {
      lines.push(`| ${t.channel} | ${String(t.durationMs)} |`);
    }
    lines.push('');
  }

  // CPU profiles
  if (cpuProfiles.length > 0) {
    lines.push('## CPU Profiles');
    lines.push('');
    lines.push('Load these `.cpuprofile` files in Chrome DevTools → Performance tab:');
    lines.push('');
    for (const p of cpuProfiles) {
      lines.push(`- **${p.label}**: \`${p.path}\``);
    }
    lines.push('');
  }

  const md = lines.join('\n');
  writeFileSync(join(REPORT_DIR, 'report.md'), md);

  // Print summary to stdout
  process.stdout.write('\n');
  process.stdout.write(md);
  process.stdout.write('\n');
  process.stdout.write(`\nFull report: ${REPORT_DIR}/report.md\n`);
  process.stdout.write(`Raw data:    ${REPORT_DIR}/results.json\n\n`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Performance Benchmarks', () => {
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    app = await launchApp();
    page = await app.firstWindow();
    await expect(page).toHaveTitle('CostGoblin');
    await waitForQuerySettle(page);
  });

  test.afterAll(async () => {
    writeReport();
    await app.close();
  });

  // -------------------------------------------------------------------------
  // Cost Overview
  // -------------------------------------------------------------------------
  test.describe('Cost Overview', () => {
    test.beforeAll(async () => {
      await page.evaluate(() => window.costgoblinPerf?.startCpuProfile());
    });

    test.afterAll(async () => {
      const result: any = await page.evaluate(() =>
        window.costgoblinPerf?.stopCpuProfile('cost-overview'),
      );
      if (result?.path) cpuProfiles.push({ label: 'Cost Overview', path: result.path });
    });

    test('baseline', async () => {
      await measure(page, 'Cost Overview → baseline', async () => {
        await page.getByRole('button', { name: 'Cost Overview', exact: true }).click();
        await waitForQuerySettle(page);
      });
    });

    test('switch to 90 days', async () => {
      await measure(page, 'Cost Overview → 90 days', async () => {
        await page.getByRole('button', { name: '90 days' }).first().click();
        await waitForQuerySettle(page);
      });
    });

    test('switch to 365 days', async () => {
      await measure(page, 'Cost Overview → 365 days', async () => {
        await page.getByRole('button', { name: '365 days' }).first().click();
        await waitForQuerySettle(page);
      });
    });

    test('apply filter', async () => {
      await measure(page, 'Cost Overview → apply filter', async () => {
        const chip = page.getByRole('button', { name: 'Account', exact: true });
        if (!await chip.isVisible().catch(() => false)) return;
        await chip.click();
        const dropdown = page.locator('.absolute.left-0.top-full');
        await expect(dropdown).toBeVisible({ timeout: 5000 });
        try {
          await expect(page.getByText('Loading…')).toBeHidden({ timeout: 10_000 });
        } catch { /* */ }
        const items = dropdown.locator('button');
        if (await items.count() > 0) {
          await items.first().click();
          await waitForQuerySettle(page);
        }
      });
    });

    test('clear filter', async () => {
      const clearAll = page.getByRole('button', { name: 'Clear all' });
      if (!await clearAll.isVisible().catch(() => false)) return;
      await measure(page, 'Cost Overview → clear filter', async () => {
        await clearAll.click();
        await waitForQuerySettle(page);
      });
    });

    test('switch histogram tab', async () => {
      await measure(page, 'Cost Overview → histogram Products', async () => {
        await page.getByRole('button', { name: 'Products' }).click();
        await waitForQuerySettle(page);
      });
    });

    test('restore 30 days', async () => {
      await page.getByRole('button', { name: 'Groups' }).click();
      await page.getByRole('button', { name: '30 days' }).first().click();
      await waitForQuerySettle(page);
    });
  });

  // -------------------------------------------------------------------------
  // Cost Trends
  // -------------------------------------------------------------------------
  test.describe('Cost Trends', () => {
    test.beforeAll(async () => {
      await page.evaluate(() => window.costgoblinPerf?.startCpuProfile());
    });

    test.afterAll(async () => {
      const result: any = await page.evaluate(() =>
        window.costgoblinPerf?.stopCpuProfile('trends'),
      );
      if (result?.path) cpuProfiles.push({ label: 'Trends', path: result.path });
    });

    test('baseline', async () => {
      await measure(page, 'Trends → baseline', async () => {
        await page.getByRole('button', { name: 'Trends' }).click();
        await expect(page.getByRole('heading', { name: 'Cost Trends' })).toBeVisible();
        await waitForQuerySettle(page);
      });
    });

    test('switch dimension', async () => {
      const dimBtns = page.locator('.rounded-lg.border.bg-bg-tertiary\\/30 button');
      const count = await dimBtns.count();
      if (count <= 1) return;
      await measure(page, 'Trends → switch dimension', async () => {
        await dimBtns.nth(1).click();
        await waitForQuerySettle(page);
      });
      // restore
      await dimBtns.first().click();
      await waitForQuerySettle(page);
    });

    test('toggle to savings', async () => {
      const toggleContainer = page.locator('.flex.items-center.gap-1.rounded-lg.border').nth(1);
      const savingsBtn = toggleContainer.getByRole('button', { name: 'savings' });
      if (!await savingsBtn.isVisible().catch(() => false)) return;
      await measure(page, 'Trends → toggle savings', async () => {
        await savingsBtn.click();
        await waitForQuerySettle(page);
      });
      // restore
      const increasesBtn = toggleContainer.getByRole('button', { name: 'increases' });
      await increasesBtn.click();
      await waitForQuerySettle(page);
    });

    test('change thresholds', async () => {
      const inputs = page.locator('input[type="number"]');
      if (await inputs.count() < 2) return;
      await measure(page, 'Trends → high thresholds', async () => {
        await inputs.first().fill('1000');
        await inputs.nth(1).fill('50');
        await waitForQuerySettle(page);
      });
      // restore
      await inputs.first().fill('10');
      await inputs.nth(1).fill('1');
      await waitForQuerySettle(page);
    });
  });

  // -------------------------------------------------------------------------
  // Missing Tags
  // -------------------------------------------------------------------------
  test.describe('Missing Tags', () => {
    test.beforeAll(async () => {
      await page.evaluate(() => window.costgoblinPerf?.startCpuProfile());
    });

    test.afterAll(async () => {
      const result: any = await page.evaluate(() =>
        window.costgoblinPerf?.stopCpuProfile('missing-tags'),
      );
      if (result?.path) cpuProfiles.push({ label: 'Missing Tags', path: result.path });
    });

    test('baseline', async () => {
      await measure(page, 'Missing Tags → baseline', async () => {
        await page.getByRole('button', { name: 'Missing Tags' }).click();
        await expect(page.getByRole('heading', { name: 'Missing Tags' })).toBeVisible();
        await waitForQuerySettle(page);
      });
    });

    test('switch tag tab', async () => {
      const tabContainer = page.locator('.rounded-lg.border.bg-bg-tertiary\\/30');
      const tabs = tabContainer.first().locator('button');
      if (await tabs.count() <= 1) return;
      await measure(page, 'Missing Tags → switch tab', async () => {
        await tabs.nth(1).click();
        await waitForQuerySettle(page);
      });
      await tabs.first().click();
      await waitForQuerySettle(page);
    });

    test('change min cost', async () => {
      const input = page.locator('input[type="number"]');
      if (!await input.isVisible().catch(() => false)) return;
      await measure(page, 'Missing Tags → min cost 0', async () => {
        await input.fill('0');
        await waitForQuerySettle(page);
      });
      await input.fill('50');
      await waitForQuerySettle(page);
    });
  });

  // -------------------------------------------------------------------------
  // Savings
  // -------------------------------------------------------------------------
  test.describe('Savings', () => {
    test('baseline', async () => {
      await measure(page, 'Savings → baseline', async () => {
        await page.getByRole('button', { name: 'Savings' }).click();
        await expect(page.getByRole('heading', { name: 'Savings Opportunities' })).toBeVisible();
        await waitForQuerySettle(page);
      });
    });

    test('filter by action type', async () => {
      const pills = page.locator('button.rounded-full');
      if (await pills.count() <= 1) return;
      await measure(page, 'Savings → filter action type', async () => {
        await pills.nth(1).click();
      });
      await pills.first().click();
    });

    test('sort by column', async () => {
      const th = page.locator('th').filter({ hasText: 'Savings/mo' }).first();
      if (!await th.isVisible().catch(() => false)) return;
      await measure(page, 'Savings → sort column', async () => {
        await th.click();
        await page.waitForTimeout(200);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Explorer
  // -------------------------------------------------------------------------
  test.describe('Explorer', () => {
    test.beforeAll(async () => {
      await page.evaluate(() => window.costgoblinPerf?.startCpuProfile());
    });

    test.afterAll(async () => {
      const result: any = await page.evaluate(() =>
        window.costgoblinPerf?.stopCpuProfile('explorer'),
      );
      if (result?.path) cpuProfiles.push({ label: 'Explorer', path: result.path });
    });

    test('baseline', async () => {
      await measure(page, 'Explorer → baseline', async () => {
        await page.getByRole('button', { name: 'Explorer' }).click();
        await waitForQuerySettle(page);
      });
    });

    test('apply filter', async () => {
      const chip = page.getByRole('button', { name: 'Account', exact: true });
      if (!await chip.isVisible().catch(() => false)) return;
      await measure(page, 'Explorer → apply filter', async () => {
        await chip.click();
        const dropdown = page.locator('.absolute.left-0.top-full');
        await expect(dropdown).toBeVisible({ timeout: 5000 });
        try {
          await expect(page.getByText('Loading…')).toBeHidden({ timeout: 10_000 });
        } catch { /* */ }
        // Skip disabled buttons (e.g. "Clear") — only click enabled value buttons
        const items = dropdown.locator('button:not([disabled])');
        if (await items.count() > 0) {
          await items.first().click();
          await waitForQuerySettle(page);
        }
      });
    });

    test('clear filter', async () => {
      // Explorer uses "Clear all" or individual clear buttons
      const clearAll = page.getByRole('button', { name: /Clear all/ });
      if (!await clearAll.isVisible().catch(() => false)) return;
      await measure(page, 'Explorer → clear filter', async () => {
        await clearAll.click();
        await waitForQuerySettle(page);
      });
    });

    test('sort column', async () => {
      const th = page.locator('th').filter({ hasText: 'Cost' }).first();
      if (!await th.isVisible().catch(() => false)) return;
      await measure(page, 'Explorer → sort column', async () => {
        await th.click();
        await waitForQuerySettle(page);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Entity Detail (via Trends)
  // -------------------------------------------------------------------------
  test.describe('Entity Detail', () => {
    let reached = false;

    test('navigate via trends', async () => {
      await page.getByRole('button', { name: 'Trends' }).click();
      await expect(page.getByRole('heading', { name: 'Cost Trends' })).toBeVisible();
      await waitForQuerySettle(page);

      const entityLink = page.locator('table button.text-accent').first();
      if (!await entityLink.isVisible().catch(() => false)) return;

      await measure(page, 'Entity Detail → navigate', async () => {
        await entityLink.click();
        await expect(page.getByRole('button', { name: '← Back' })).toBeVisible({ timeout: 5000 });
        await waitForQuerySettle(page);
      });
      reached = true;
    });

    test('switch histogram dimension', async () => {
      if (!reached) return;
      const accountTab = page.getByRole('button', { name: 'account' });
      if (!await accountTab.isVisible().catch(() => false)) return;
      await measure(page, 'Entity Detail → histogram account', async () => {
        await accountTab.click();
        await waitForQuerySettle(page);
      });
    });

    test('change date range', async () => {
      if (!reached) return;
      await measure(page, 'Entity Detail → 90 days', async () => {
        await page.getByRole('button', { name: '90 days' }).first().click();
        await waitForQuerySettle(page);
      });
    });

    test('back to overview', async () => {
      if (!reached) return;
      await page.getByRole('button', { name: '← Back' }).click();
      await waitForQuerySettle(page);
    });
  });

  // -------------------------------------------------------------------------
  // Cost Scope
  // -------------------------------------------------------------------------
  test.describe('Cost Scope', () => {
    test.beforeAll(async () => {
      await page.evaluate(() => window.costgoblinPerf?.startCpuProfile());
    });

    test.afterAll(async () => {
      const result: any = await page.evaluate(() =>
        window.costgoblinPerf?.stopCpuProfile('cost-scope'),
      );
      if (result?.path) cpuProfiles.push({ label: 'Cost Scope', path: result.path });
    });

    test('baseline', async () => {
      await measure(page, 'Cost Scope → baseline', async () => {
        await page.getByRole('button', { name: 'Cost Scope' }).click();
        await expect(page.getByRole('heading', { name: 'Cost Scope' })).toBeVisible();
        await waitForCostScopePreview(page);
      });
    });

    test('toggle rule', async () => {
      const toggle = page.getByRole('switch').first();
      if (!await toggle.isVisible().catch(() => false)) return;
      await measure(page, 'Cost Scope → toggle rule', async () => {
        await toggle.click();
        await waitForCostScopePreview(page);
      });
      // revert: toggle back and cancel if the button is visible
      await toggle.click();
      const cancelBtn = page.getByRole('button', { name: 'Cancel' });
      if (await cancelBtn.isVisible().catch(() => false)) {
        await cancelBtn.click();
      }
      await waitForCostScopePreview(page);
    });

    test('switch metric', async () => {
      const amortizedRadio = page.locator('input[type="radio"][value="amortized"]');
      if (!await amortizedRadio.isVisible().catch(() => false)) return;
      await measure(page, 'Cost Scope → switch to amortized', async () => {
        await amortizedRadio.click();
        await waitForCostScopePreview(page);
      });
      // revert
      const unblendedRadio = page.locator('input[type="radio"][value="unblended"]');
      await unblendedRadio.click();
      const cancelBtn2 = page.getByRole('button', { name: 'Cancel' });
      if (await cancelBtn2.isVisible().catch(() => false)) {
        await cancelBtn2.click();
      }
      await waitForCostScopePreview(page);
    });
  });

  // -------------------------------------------------------------------------
  // Dimensions
  // -------------------------------------------------------------------------
  test.describe('Dimensions', () => {
    test('baseline', async () => {
      await measure(page, 'Dimensions → baseline', async () => {
        await page.getByRole('button', { name: 'Dimensions' }).click();
        await expect(page.getByRole('heading', { name: 'Dimensions', exact: true })).toBeVisible();
        await waitForQuerySettle(page);
      });
    });

    test('open editor', async () => {
      const editBtn = page.locator('button').filter({ hasText: 'Edit →' }).first();
      if (!await editBtn.isVisible().catch(() => false)) return;
      await measure(page, 'Dimensions → open editor', async () => {
        await editBtn.click();
        await expect(page.getByText('Concept')).toBeVisible();
      });
      await page.getByRole('button', { name: 'Cancel' }).click();
    });
  });

  // -------------------------------------------------------------------------
  // Views Editor
  // -------------------------------------------------------------------------
  test.describe('Views Editor', () => {
    test('baseline', async () => {
      await measure(page, 'Views Editor → baseline', async () => {
        await page.getByRole('button', { name: 'Views' }).click();
        await expect(page.getByRole('heading', { name: 'Views', exact: true })).toBeVisible();
        await waitForQuerySettle(page);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Data Management (Sync)
  // -------------------------------------------------------------------------
  test.describe('Data Management', () => {
    test('baseline', async () => {
      await measure(page, 'Data Management → baseline', async () => {
        await page.getByRole('button', { name: 'Sync' }).click();
        await expect(page.getByRole('heading', { name: 'Data Management' })).toBeVisible();
        await waitForQuerySettle(page);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Rapid navigation stress test
  // -------------------------------------------------------------------------
  test.describe('Navigation stress', () => {
    test('rapid switching', async () => {
      await measure(page, 'Rapid navigation (9 switches)', async () => {
        const views = ['Cost Overview', 'Trends', 'Missing Tags', 'Savings', 'Explorer', 'Cost Scope', 'Dimensions', 'Sync', 'Cost Overview'];
        for (const v of views) {
          await page.getByRole('button', { name: v, exact: true }).first().click();
        }
        await waitForQuerySettle(page);
      });
    });
  });
});
