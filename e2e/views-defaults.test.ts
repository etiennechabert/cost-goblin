import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { join } from 'node:path';
import { mkdtempSync, readdirSync, copyFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  launchApp,
  closeApp,
  FIXTURE_CONFIG_DIR,
  startCoverage,
  stopAndCollectCoverage,
  screenshot,
  assertNoReactCrash,
  waitForQuerySettle,
  clickNavButton,
  openDashboardsDropdown,
  selectDatePreset,
  writeCoverage,
} from './helpers.js';

const allCoverage: unknown[] = [];

let app: ElectronApplication;
let page: Page;

// One default dashboard per widget type, exactly as seeded by
// SEED_VIEWS_CONFIG. Keep in sync with packages/core/src/types/seed-views.ts.
const DEFAULT_VIEWS = [
  'Cost Overview',
  'Trend lines',
  'Stacked over time',
  'Top N',
  'Distribution',
  'Treemap',
  'Heatmap',
  'Movers',
  'Line items',
  'Cost drivers',
  'Price vs volume',
  'Budget pacing',
  'Concentration',
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function slug(s: string): string {
  return s.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
}

test.describe('default dashboards', () => {
  test.describe.configure({ timeout: 180_000 });

  test.beforeAll(async () => {
    // Force the app to seed the full default set: copy the active config dir
    // but omit views.yaml, so views:get-config falls back to
    // SEED_VIEWS_CONFIG instead of an existing file. Dimensions + data come
    // from the active config, so widgets still populate.
    const srcConfig = process.env['COSTGOBLIN_CONFIG_DIR'] ?? FIXTURE_CONFIG_DIR;
    const tmpConfig = mkdtempSync(join(tmpdir(), 'cg-seed-config-'));
    for (const entry of readdirSync(srcConfig)) {
      if (entry === 'views.yaml') continue;
      const p = join(srcConfig, entry);
      if (statSync(p).isFile()) copyFileSync(p, join(tmpConfig, entry));
    }

    app = await launchApp({ configDir: tmpConfig });
    page = await app.firstWindow();
    await expect(page).toHaveTitle('CostGoblin');
    await startCoverage(page);
    await waitForQuerySettle(page);

    // Synthetic fixtures sit in early 2026; widen the range so the dashboards
    // have data to render. Harmless against real data. Best-effort — the
    // structural assertions below don't depend on data being present.
    await selectDatePreset(page, 'Last 365 days').catch(() => { /* picker may be absent */ });
    await waitForQuerySettle(page);
  });

  test.afterAll(async () => {
    await stopAndCollectCoverage(page, allCoverage);
    await closeApp(app);
    writeCoverage('views-defaults', allCoverage);
  });

  test('the Dashboards menu lists every default dashboard', async () => {
    await openDashboardsDropdown(page);
    for (const name of DEFAULT_VIEWS) {
      await expect(
        page.getByRole('menuitem', { name: new RegExp(escapeRe(name)) }).first(),
      ).toBeVisible();
    }
    await page.keyboard.press('Escape');
  });

  for (const name of DEFAULT_VIEWS) {
    test(`"${name}" renders without errors`, async () => {
      await clickNavButton(page, name);
      await expect(page.getByRole('heading', { name, exact: true })).toBeVisible({ timeout: 10_000 });
      await waitForQuerySettle(page);
      // The React error boundary must not have fired and no widget may have
      // surfaced a query error on this dashboard.
      await assertNoReactCrash(page);
      await expect(page.getByText('Query failed', { exact: false })).toHaveCount(0);
      await screenshot(page, `view-${slug(name)}`);
    });
  }
});
