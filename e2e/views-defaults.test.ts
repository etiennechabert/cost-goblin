import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { join } from 'node:path';
import { mkdtempSync, readdirSync, copyFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
  openDashboardsDropdown,
  selectDatePreset,
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

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function slug(s: string): string {
  return s.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
}

test.describe('default dashboards', () => {
  test.describe.configure({ timeout: 180_000 });

  test.beforeAll(async () => {
    // Start from the views.yaml v0.7.0-v0.8.x seeded (the retired per-widget
    // dashboards), with one of them edited, so the launch runs the views
    // migration end to end. Dimensions + data come from the active config, so
    // widgets still populate. (A missing views.yaml, seeded from scratch, is
    // what the gcp-provider suite's fixture config exercises.)
    const srcConfig = process.env['COSTGOBLIN_CONFIG_DIR'] ?? FIXTURE_CONFIG_DIR;
    const tmpConfig = mkdtempSync(join(tmpdir(), 'cg-seed-config-'));
    for (const entry of readdirSync(srcConfig)) {
      if (entry === 'views.yaml') continue;
      const p = join(srcConfig, entry);
      if (statSync(p).isFile()) copyFileSync(p, join(tmpConfig, entry));
    }
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
  });

  test('a starred default the migration dropped opens the Cost Overview', async () => {
    await expect(page.getByRole('heading', { name: 'Cost Overview', exact: true })).toBeVisible();
    await openDashboardsDropdown(page);
    await expect(page.getByRole('menuitem', { name: 'Cost Overview' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('button', { name: 'Cost Overview is the default dashboard' })).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('the Dashboards menu lists the default dashboards and keeps the edited one', async () => {
    await openDashboardsDropdown(page);
    // Untouched retired dashboards are gone; the edited one stays as the user's own.
    await expect(page.getByRole('menuitem')).toHaveText([...DEFAULT_VIEWS, 'Top spenders']);
    for (const name of DEFAULT_VIEWS) {
      await expect(
        page.getByRole('menuitem', { name: new RegExp(escapeRe(name)) }).first(),
      ).toBeVisible();
    }
    await page.keyboard.press('Escape');
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
