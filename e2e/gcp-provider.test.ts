import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import {
  launchApp,
  clickNavButton,
  selectDatePreset,
  waitForQuerySettle,
  assertNoReactCrash,
  screenshot,
  startCoverage,
  stopAndCollectCoverage,
  writeCoverage,
  FIXTURE_DATA_DIR,
  FIXTURE_MULTI_CONFIG_DIR,
} from './helpers.js';

/**
 * Layer 4 for #517: the app booted against a workspace holding BOTH provider
 * arms at once.
 *
 * Every other suite runs the single-provider baseline config, so nothing below
 * the API boundary had ever seen a `type: gcp` entry survive config load →
 * provider listing → sync-id routing → query → render. The unit and DuckDB
 * layers cover the pieces; this covers them wired together in a real Electron
 * process.
 *
 * Both dirs are pinned explicitly rather than inherited from the environment:
 * the whole point is a config the other suites deliberately do not use.
 */

let app: ElectronApplication;
let page: Page;
const allCoverage: unknown[] = [];

/** Each test navigates for itself. Playwright shares one page across a
 *  describe block, so leaning on the previous test's position makes a failure
 *  anywhere cascade into unrelated ones. */
async function openDataSync(): Promise<void> {
  await clickNavButton(page, 'Sync');
  await expect(page.getByLabel('Provider aws-main')).toBeVisible();
}

test.beforeAll(async () => {
  app = await launchApp({ configDir: FIXTURE_MULTI_CONFIG_DIR, dataDir: FIXTURE_DATA_DIR });
  page = await app.firstWindow();
  // Attach as early as possible: CDP coverage only counts execution after
  // enabling, so every await before this line is boot code lost to the report.
  await startCoverage(page);
  await expect(page).toHaveTitle('CostGoblin');
});

test.afterAll(async () => {
  await stopAndCollectCoverage(page, allCoverage);
  // Write before close: a hung or rejected close() must not discard the
  // coverage already harvested (writeCoverage is synchronous).
  writeCoverage('gcp-provider', allCoverage);
  await app.close();
});

test.describe('mixed AWS + GCP workspace', () => {
  test('boots and renders without a crash', async () => {
    await waitForQuerySettle(page);
    await assertNoReactCrash(page);
    await screenshot(page, 'gcp-mixed-dashboard');
  });

  test('lists both providers on Data & Sync', async () => {
    await openDataSync();
    await expect(page.getByLabel('Provider gcp-main')).toBeVisible();
  });

  test('shows the GCP provider reading a gs:// bucket with ADC', async () => {
    await openDataSync();
    const gcp = page.getByLabel('Provider gcp-main');
    // No keyFile in the fixture config, so it must report Application Default
    // Credentials rather than an AWS profile name.
    await expect(gcp.getByText('application default credentials')).toBeVisible();
    await expect(gcp.getByText(/gs:\/\/test-focus-export/).first()).toBeVisible();
  });

  test('offers GCP the hourly tier but not Cost Optimization', async () => {
    // The exporter publishes an hourly grain, so that panel is real for GCP.
    // Cost Optimization has no GCP analogue and resolveBucketPath refuses that
    // tier, so offering the panel would be a button that can only error.
    await openDataSync();
    const gcp = page.getByLabel('Provider gcp-main');
    await expect(gcp.getByText('Hourly', { exact: true })).toBeVisible();
    await expect(gcp.getByText('Cost Optimization', { exact: true })).toHaveCount(0);

    const aws = page.getByLabel('Provider aws-main');
    await expect(aws.getByText('Cost Optimization', { exact: true })).toBeVisible();
  });

  test('attributes spend to both providers in one query', async () => {
    await clickNavButton(page, 'Explorer');
    // The synthetic fixture is Jan–Feb 2026; the default 30-day window is well
    // past it, so without widening the range every provider reads $0.00 and
    // the assertion below would pass for the wrong reason.
    await selectDatePreset(page, 'Last 365 days');
    await waitForQuerySettle(page);

    await page.getByRole('button', { name: 'Provider', exact: true }).first().click();
    await waitForQuerySettle(page);

    // The provider dimension is injected at read time and is the only thing
    // that can tell the two branches apart once they are unioned.
    await expect(page.getByText('gcp-main').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('aws-main').first()).toBeVisible();
    await assertNoReactCrash(page);
    await screenshot(page, 'gcp-mixed-explorer');
  });
});
