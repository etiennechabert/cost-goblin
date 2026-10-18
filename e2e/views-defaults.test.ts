import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { join } from 'node:path';
import { mkdtempSync, readdirSync, copyFileSync, statSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  launchAppWithCoverage,
  finishCoverage,
  FIXTURE_CONFIG_DIR,
  screenshot,
  assertNoReactCrash,
  waitForQuerySettle,
  clickNavButton,
  navigateTo,
  ensureViewMode,
  openDashboardsDropdown,
  selectDatePreset,
} from './helpers.js';

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

/** A throwaway copy of the active config dir without its views.yaml.
 *  Dimensions + data come from the active config, so widgets still populate. */
function configDirWithoutViews(): string {
  const srcConfig = process.env['COSTGOBLIN_CONFIG_DIR'] ?? FIXTURE_CONFIG_DIR;
  const tmpConfig = mkdtempSync(join(tmpdir(), 'cg-seed-config-'));
  for (const entry of readdirSync(srcConfig)) {
    if (entry === 'views.yaml') continue;
    const p = join(srcConfig, entry);
    if (statSync(p).isFile()) copyFileSync(p, join(tmpConfig, entry));
  }
  return tmpConfig;
}

test.describe('default dashboards', () => {
  test.describe.configure({ timeout: 180_000 });
  let seedConfig = '';

  test.beforeAll(async () => {
    // Force the app to seed the full default set: with no views.yaml,
    // views:get-config writes SEED_VIEWS_CONFIG.
    seedConfig = configDirWithoutViews();
    ({ app, page } = await launchAppWithCoverage({ configDir: seedConfig }));
    await waitForQuerySettle(page);

    // Synthetic fixtures sit in early 2026; widen the range so the dashboards
    // have data to render. Harmless against real data. Best-effort — the
    // structural assertions below don't depend on data being present.
    await selectDatePreset(page, 'Last 365 days').catch(() => { /* picker may be absent */ });
    await waitForQuerySettle(page);
  });

  test.afterAll(async () => {
    await finishCoverage(app, page, 'views-defaults');
    if (seedConfig !== '') rmSync(seedConfig, { recursive: true, force: true });
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

/** A hand-edited views.yaml: a custom dashboard beside the built-in one. */
function customViewsYaml(topN: string): string {
  return `views:
  - id: overview
    name: Cost Overview
    builtIn: true
    rows:
      - widgets:
          - id: overview-summary
            type: summary
            size: small
            metric: total
  - id: team-costs
    name: Team costs
    rows:
      - widgets:
          - id: team-top
            type: topNBar
            size: large
            groupBy: service
            topN: ${topN}
`;
}
// The quoted topN is a string, which the views validator rejects.
const BROKEN_VIEWS_YAML = customViewsYaml('"5"');
const FIXED_VIEWS_YAML = customViewsYaml('5');
const VALIDATION_ERROR = 'views[1].rows[0].widgets[0].topN must be a number';

// views:get-config used to answer any load failure by seeding: a hand edit
// like this one cost the user every custom dashboard in the file.
test.describe('a views.yaml that fails to load', () => {
  let brokenApp: ElectronApplication | undefined;
  let brokenPage: Page | undefined;
  let srcConfig = '';
  let viewsPath = '';

  function launched(): { app: ElectronApplication; page: Page } {
    if (brokenApp === undefined || brokenPage === undefined) throw new Error('app not launched');
    return { app: brokenApp, page: brokenPage };
  }

  function loadError(p: Page): ReturnType<Page['getByRole']> {
    return p.getByRole('alert').filter({ hasText: "Couldn't load your dashboards" });
  }

  test.beforeAll(async () => {
    // A launch of its own: the broken file has to be in place before boot.
    srcConfig = configDirWithoutViews();
    writeFileSync(join(srcConfig, 'views.yaml'), BROKEN_VIEWS_YAML);
    ({ app: brokenApp, page: brokenPage } = await launchAppWithCoverage({ configDir: srcConfig }));
    // The app runs on its own copy of the config dir.
    const configDir = await brokenApp.evaluate(() => process.env['COSTGOBLIN_CONFIG_DIR'] ?? '');
    viewsPath = join(configDir, 'views.yaml');
  });

  test.afterAll(async () => {
    await finishCoverage(brokenApp, brokenPage, 'views-defaults-invalid');
    if (srcConfig !== '') rmSync(srcConfig, { recursive: true, force: true });
  });

  test('the dashboard says why and leaves views.yaml as it is', async () => {
    const { page: p } = launched();
    await expect(loadError(p)).toBeVisible({ timeout: 15_000 });
    await expect(loadError(p)).toContainText(VALIDATION_ERROR);
    // The seed's Cost Overview stands in meanwhile.
    await expect(p.getByRole('heading', { name: 'Cost Overview', exact: true })).toBeVisible();
    expect(readFileSync(viewsPath, 'utf-8')).toBe(BROKEN_VIEWS_YAML);
  });

  test('the Views editor shows the error and offers nothing that would save over the file', async () => {
    const { page: p } = launched();
    await navigateTo(p, 'Views', 'Views');
    await expect(loadError(p)).toContainText(VALIDATION_ERROR);
    await expect(p.getByRole('button', { name: '+ New view' })).toBeDisabled();
    await expect(p.getByRole('button', { name: 'Reset built-ins' })).toBeDisabled();
    // The settings rail has an "Import" tab of its own (it carries data-tab).
    await expect(
      p.getByRole('button', { name: 'Import', exact: true }).and(p.locator('button:not([data-tab])')),
    ).toBeDisabled();
    expect(readFileSync(viewsPath, 'utf-8')).toBe(BROKEN_VIEWS_YAML);
  });

  test('exporting the configuration names views.yaml instead of leaving the dashboards out', async () => {
    const { app: a, page: p } = launched();
    // The bundle is built before the save dialog opens, so the export should
    // fail first. If it doesn't, the stub cancels rather than leaving a
    // native dialog up.
    await a.evaluate(({ dialog }) => {
      Reflect.set(dialog, 'showSaveDialog', () => Promise.resolve({ canceled: true, filePath: '' }));
    });
    await navigateTo(p, 'Share', 'Share configuration');
    await p.getByRole('button', { name: 'Export…' }).click();
    await expect(p.getByText(`Couldn't load views.yaml for the configuration bundle: ${VALIDATION_ERROR}`)).toBeVisible();
  });

  // Last: it rewrites views.yaml.
  test('once views.yaml is fixed, Retry brings the custom dashboards back', async () => {
    const { page: p } = launched();
    await ensureViewMode(p);
    await expect(loadError(p)).toBeVisible();

    writeFileSync(viewsPath, FIXED_VIEWS_YAML);
    await loadError(p).getByRole('button', { name: 'Retry' }).click();

    await expect(loadError(p)).toHaveCount(0);
    await openDashboardsDropdown(p);
    await expect(p.getByRole('menuitem', { name: /Team costs/ })).toBeVisible();
    await p.keyboard.press('Escape');
    expect(readFileSync(viewsPath, 'utf-8')).toBe(FIXED_VIEWS_YAML);
  });
});
