import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { join } from 'node:path';
import { mkdtempSync, readdirSync, copyFileSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import {
  launchAppWithCoverage,
  finishCoverage,
  FIXTURE_CONFIG_DIR,
  ROOT,
  screenshot,
  assertNoReactCrash,
  waitForQuerySettle,
  clickNavButton,
  navigateTo,
  ensureViewMode,
  openDashboardsSidebar,
  selectDatePreset,
  expectVisibleData,
} from './helpers.js';

let app: ElectronApplication;
let page: Page;

// The built-in dashboards, exactly as seeded by SEED_VIEWS_CONFIG. Keep in
// sync with packages/core/src/types/seed-views.ts.
const DEFAULT_VIEWS = [
  'Cost Overview',
  'What changed',
  'Spend pacing',
  'Where the money goes',
];

function slug(s: string): string {
  return s.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
}

/** A throwaway copy of the active config dir, without the files in `skip`.
 *  Dimensions + data come from the active config, so widgets still populate. */
function copyOfConfigDir(skip: readonly string[] = []): string {
  const srcConfig = process.env['COSTGOBLIN_CONFIG_DIR'] ?? FIXTURE_CONFIG_DIR;
  const tmpConfig = mkdtempSync(join(tmpdir(), 'cg-seed-config-'));
  for (const entry of readdirSync(srcConfig)) {
    if (skip.includes(entry)) continue;
    const p = join(srcConfig, entry);
    if (statSync(p).isFile()) copyFileSync(p, join(tmpConfig, entry));
  }
  return tmpConfig;
}

function configDirWithoutViews(): string {
  return copyOfConfigDir(['views.yaml']);
}

test.describe('default dashboards', () => {
  test.describe.configure({ timeout: 180_000 });
  let tmpConfig = '';

  test.beforeAll(async () => {
    // Start from the views.yaml v0.7.0-v0.8.x seeded (the retired per-widget
    // dashboards), with one of them edited, so the launch runs the views
    // migration end to end. (A missing views.yaml, seeded from scratch, is
    // what the gcp-provider suite's fixture config exercises.)
    tmpConfig = configDirWithoutViews();
    const seeded = readFileSync(join(ROOT, 'packages', 'core', 'src', '__fixtures__', 'views', 'seeded-v0.7.0.yaml'), 'utf-8');
    writeFileSync(join(tmpConfig, 'views.yaml'), seeded.replace('name: Top N\n', 'name: Top spenders\n'));

    // The starred default is a dashboard the migration drops.
    ({ app, page } = await launchAppWithCoverage({
      configDir: tmpConfig,
      stateFiles: { 'ui-preferences.json': JSON.stringify({ defaultViewId: 'pacing' }) },
    }));
    await waitForQuerySettle(page);

    // Synthetic fixtures sit in early 2026; widen the range so the dashboards
    // have data to render. Harmless against real data. Best-effort — the
    // structural assertions below don't depend on data being present.
    await selectDatePreset(page, 'Last 365 days').catch(() => { /* picker may be absent */ });
    await waitForQuerySettle(page);
  });

  test.afterAll(async () => {
    await finishCoverage(app, page, 'views-defaults');
    if (tmpConfig !== '') rmSync(tmpConfig, { recursive: true, force: true });
  });

  test('a starred default the migration dropped opens the Cost Overview', async () => {
    await expect(page.getByRole('heading', { name: 'Cost Overview', exact: true })).toBeVisible();
    const sidebar = await openDashboardsSidebar(page);
    await expect(sidebar.getByRole('button', { name: 'Cost Overview', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(sidebar.getByRole('button', { name: 'Cost Overview is the default dashboard' })).toBeVisible();
  });

  test('the Dashboards sidebar lists the default dashboards and keeps the edited one', async () => {
    const sidebar = await openDashboardsSidebar(page);
    // Untouched retired dashboards are gone; the edited one stays as the user's own.
    await expect(sidebar.getByRole('listitem')).toHaveText([...DEFAULT_VIEWS, 'Top spenders']);
    for (const name of DEFAULT_VIEWS) {
      await expect(sidebar.getByRole('button', { name, exact: true })).toBeVisible();
    }
  });

  test('writes the migrated dashboards back to views.yaml', async () => {
    const configDir = await app.evaluate(() => process.env['COSTGOBLIN_CONFIG_DIR'] ?? '');
    const written: unknown = parseYaml(readFileSync(join(configDir, 'views.yaml'), 'utf-8'));
    expect(written).toMatchObject({
      views: [
        { id: 'overview', builtIn: true },
        { id: 'what-changed', builtIn: true },
        { id: 'spend-pacing', builtIn: true },
        { id: 'where-the-money-goes', builtIn: true },
        { id: 'top-n', name: 'Top spenders' },
      ],
    });
    // …and the edited one is no longer built-in, so the user can delete it.
    expect(written).toMatchObject({ views: [{}, {}, {}, {}, expect.not.objectContaining({ builtIn: true })] });
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
    const sidebar = await openDashboardsSidebar(p);
    await expect(sidebar.getByRole('button', { name: 'Team costs', exact: true })).toBeVisible();
    expect(readFileSync(viewsPath, 'utf-8')).toBe(FIXED_VIEWS_YAML);
  });
});

/** A hand-edited cost-scope.yaml: a rule excluding one account's costs. */
function customCostScopeYaml(values: string): string {
  return `costMetric: effective
rules:
  - id: user:analytics
    name: Data Analytics account
    enabled: true
    builtIn: false
    conditions:
      - dimensionId: account
        values: ${values}
`;
}
// A bare value where the validator wants a list.
const BROKEN_COST_SCOPE_YAML = customCostScopeYaml('Data Analytics');
const FIXED_COST_SCOPE_YAML = customCostScopeYaml('[Data Analytics]');
const COST_SCOPE_ERROR = 'costScope.rules[0].conditions[0].values must be an array';

// Every query used to answer a broken cost-scope.yaml by dropping it, so the
// dashboards showed totals without the user's rules, and the Cost Scope page
// could save the defaults over the file.
test.describe('a cost-scope.yaml that fails to load', () => {
  let scopeApp: ElectronApplication | undefined;
  let scopePage: Page | undefined;
  let srcConfig = '';
  let costScopePath = '';

  function launched(): { app: ElectronApplication; page: Page } {
    if (scopeApp === undefined || scopePage === undefined) throw new Error('app not launched');
    return { app: scopeApp, page: scopePage };
  }

  function loadError(p: Page): ReturnType<Page['getByRole']> {
    return p.getByRole('alert').filter({ hasText: "Couldn't load your cost scope" });
  }

  test.beforeAll(async () => {
    // A launch of its own: the broken file has to be in place before boot.
    srcConfig = copyOfConfigDir();
    writeFileSync(join(srcConfig, 'cost-scope.yaml'), BROKEN_COST_SCOPE_YAML);
    ({ app: scopeApp, page: scopePage } = await launchAppWithCoverage({ configDir: srcConfig }));
    // The app runs on its own copy of the config dir.
    const configDir = await scopeApp.evaluate(() => process.env['COSTGOBLIN_CONFIG_DIR'] ?? '');
    costScopePath = join(configDir, 'cost-scope.yaml');
  });

  test.afterAll(async () => {
    await finishCoverage(scopeApp, scopePage, 'views-defaults-cost-scope');
    if (srcConfig !== '') rmSync(srcConfig, { recursive: true, force: true });
  });

  test('the dashboard says why, and shows no total without the rules', async () => {
    const { page: p } = launched();
    await expect(loadError(p)).toBeVisible({ timeout: 15_000 });
    await expect(loadError(p)).toContainText(COST_SCOPE_ERROR);
    await waitForQuerySettle(p);
    // The summary's query failed: a placeholder, not an unscoped total.
    const summary = p.locator('[data-widget-id="overview-summary"]');
    await expect(summary).toContainText('—');
    await expect(summary).not.toContainText('$');
    expect(readFileSync(costScopePath, 'utf-8')).toBe(BROKEN_COST_SCOPE_YAML);
  });

  test('the Cost Scope page shows the error and offers nothing that would save over the file', async () => {
    const { page: p } = launched();
    await clickNavButton(p, 'Cost Scope');
    await expect(p.getByRole('heading', { name: 'Cost Scope', exact: true })).toBeVisible();
    await expect(loadError(p)).toContainText(COST_SCOPE_ERROR);
    await expect(p.getByRole('button', { name: 'Add rule' })).toHaveCount(0);
    await expect(p.getByRole('button', { name: 'Save' })).toHaveCount(0);
    await expect(p.locator('input[name="costMetric"]')).toHaveCount(0);
    expect(readFileSync(costScopePath, 'utf-8')).toBe(BROKEN_COST_SCOPE_YAML);
  });

  test('exporting the configuration names cost-scope.yaml instead of leaving the scope out', async () => {
    const { app: a, page: p } = launched();
    // The bundle is built before the save dialog opens, so the export should
    // fail first. If it doesn't, the stub cancels rather than leaving a
    // native dialog up.
    await a.evaluate(({ dialog }) => {
      Reflect.set(dialog, 'showSaveDialog', () => Promise.resolve({ canceled: true, filePath: '' }));
    });
    await navigateTo(p, 'Share', 'Share configuration');
    await p.getByRole('button', { name: 'Export…' }).click();
    await expect(p.getByText(`Couldn't load cost-scope.yaml for the configuration bundle: ${COST_SCOPE_ERROR}`)).toBeVisible();
  });

  // Last: it rewrites cost-scope.yaml.
  test('once cost-scope.yaml is fixed, Retry brings the costs back', async () => {
    const { page: p } = launched();
    await ensureViewMode(p);
    await expect(loadError(p)).toBeVisible();

    writeFileSync(costScopePath, FIXED_COST_SCOPE_YAML);
    await loadError(p).getByRole('button', { name: 'Retry' }).click();

    await expect(loadError(p)).toHaveCount(0);
    await waitForQuerySettle(p);
    await expectVisibleData(p);
    expect(readFileSync(costScopePath, 'utf-8')).toBe(FIXED_COST_SCOPE_YAML);
  });
});
