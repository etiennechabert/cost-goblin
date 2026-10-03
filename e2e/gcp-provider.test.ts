import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { parse as parseYaml } from 'yaml';
import {
  launchAppWithCoverage,
  finishCoverage,
  clickNavButton,
  selectDatePreset,
  waitForQuerySettle,
  assertNoReactCrash,
  expectCloudSandboxed,
  screenshot,
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

/** Each test navigates for itself. Playwright shares one page across a
 *  describe block, so leaning on the previous test's position makes a failure
 *  anywhere cascade into unrelated ones. */
async function openDataSync(): Promise<void> {
  await clickNavButton(page, 'Sync');
  await expect(page.getByLabel('Provider aws-main')).toBeVisible();
}

test.beforeAll(async () => {
  ({ app, page } = await launchAppWithCoverage({
    configDir: FIXTURE_MULTI_CONFIG_DIR,
    dataDir: FIXTURE_DATA_DIR,
  }));
});

test.afterAll(async () => {
  await finishCoverage(app, page, 'gcp-provider');
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

  test('runs with cloud credential discovery sandboxed', async () => {
    // This suite is where the leak showed: launched with the runner's env, a
    // developer's real ADC let the app query `gs://test-focus-export` as them,
    // and the card below sat on "Checking Cloud Storage for available data..."
    // while it did. CI holds no credentials to leak, so this check is what
    // keeps a developer's run as credential-free as CI's.
    await expectCloudSandboxed(app);
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

  // Last on purpose: Complete Setup rewrites this launch's costgoblin.yaml.
  test('re-running setup keeps the tuned hourly retention and writes the impersonation target', async () => {
    // The wizard's GCS discovery needs credentials, and this launch has none
    // by design (see expectCloudSandboxed). Stub just the two discovery
    // channels in the main process; everything after them — the Confirm step,
    // the real setup:write-config handler and the YAML it writes — runs as is.
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('setup:list-gcs-buckets');
      ipcMain.handle('setup:list-gcs-buckets', () => ({ buckets: [{ name: 'test-focus-export' }] }));
      ipcMain.removeHandler('setup:browse-gcs');
      ipcMain.handle('setup:browse-gcs', (_event, params: { prefix: string }) => {
        const prefix = params.prefix.replace(/\/+$/, '');
        if (prefix === 'focus') {
          return { prefixes: ['daily', 'hourly'], folder: { kind: 'tier-parent', tiers: ['daily', 'hourly'] }, hasParquet: false, truncated: false };
        }
        if (prefix === '') return { prefixes: ['focus'], folder: { kind: 'unknown' }, hasParquet: false, truncated: false };
        return { prefixes: ['billing_period=2026-01'], folder: { kind: 'export', periods: ['2026-01'] }, hasParquet: true, truncated: false };
      });
    });

    await clickNavButton(page, 'General');
    await page.getByRole('button', { name: 'Run setup again' }).click();
    await page.getByLabel('Set up from Google Cloud').click();
    await page.getByLabel('Already know the project ID? Skip the project list').fill('test-project');
    await page.getByLabel('Already know the project ID? Skip the project list').press('Enter');

    // Daily, then hourly, each from the bucket root down to its tier folder.
    for (const tier of ['daily', 'hourly']) {
      await page.getByText('test-focus-export', { exact: true }).click();
      await page.getByLabel(/^Open folder focus\/?$/).click();
      await page.getByLabel(new RegExp(`^Open folder ${tier}\\/?$`)).click();
      await page.getByRole('button', { name: 'Use this location' }).click();
    }
    await expect(page.getByRole('heading', { name: 'Confirm Setup' })).toBeVisible();

    // The fixture's gcp-main keeps 14 days of hourly. The pickers used to
    // start on the 30-day default, so this re-run silently cut it.
    const hourly = page.getByRole('group', { name: 'Hourly FOCUS export retention' });
    await expect(hourly.getByRole('button', { name: '14 days' })).toHaveAttribute('aria-pressed', 'true');

    const field = page.getByLabel('Impersonate service account');
    await field.fill('not-an-address');
    await expect(page.getByRole('button', { name: 'Complete Setup' })).toBeDisabled();
    await field.fill('costgoblin-reader@test-project.iam.gserviceaccount.com');
    await screenshot(page, 'gcp-rerun-confirm');
    await page.getByRole('button', { name: 'Complete Setup' }).click();
    await expect(page.getByRole('heading', { name: 'Confirm Setup' })).toBeHidden();

    const configDir = await app.evaluate(() => process.env['COSTGOBLIN_CONFIG_DIR'] ?? '');
    const written: unknown = parseYaml(readFileSync(join(configDir, 'costgoblin.yaml'), 'utf-8'));
    expect(written).toMatchObject({
      providers: [
        { name: 'aws-main', type: 'aws' },
        {
          name: 'gcp-main',
          type: 'gcp',
          impersonateServiceAccount: 'costgoblin-reader@test-project.iam.gserviceaccount.com',
          sync: {
            daily: { bucket: 'gs://test-focus-export/focus/daily/', retentionDays: 365 },
            hourly: { bucket: 'gs://test-focus-export/focus/hourly/', retentionDays: 14 },
          },
        },
      ],
    });
    await assertNoReactCrash(page);
  });
});

