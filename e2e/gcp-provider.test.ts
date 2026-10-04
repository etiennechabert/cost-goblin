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

  test('shows who listing and downloads run as, finding credentials only in the sandbox', async () => {
    // The "Signed in as" panel reads the ADC location the Cloud Storage SDK
    // reads and runs `gcloud config list`. Sandboxed, that location is the
    // pinned, absent file — a panel naming anyone, or pointing anywhere but
    // the sandbox, would mean it read the developer's real credentials.
    await openDataSync();
    const panel = page.getByRole('region', { name: 'Signed in as (gcp-main)' });
    await expect(panel.getByText('Not signed in')).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByText(/No file at .*cloud-sandbox/)).toBeVisible();
    // gcloud may or may not sit in a trusted location on the runner. When it
    // does, the sandbox's CLOUDSDK_AUTH_ACCESS_TOKEN_FILE pin outranks every
    // other gcloud credential, so that pinned (absent) file is what the
    // download row must name — never an account from the developer's gcloud.
    await expect(panel.getByText(/a pre-minted access token|The gcloud CLI is not installed/)).toBeVisible();
    if (await panel.getByText(/a pre-minted access token/).count() > 0) {
      // The pin is an env var, which `gcloud config unset` cannot undo — the
      // panel says where it came from.
      await expect(panel.getByText(/auth\/access_token_file · .*cloud-sandbox.* · set by CLOUDSDK_AUTH_ACCESS_TOKEN_FILE/)).toBeVisible();
    }
    await expect(panel.getByText('Checking Google Cloud credentials…')).toHaveCount(0);

    await panel.getByRole('button', { name: 'Re-check' }).click();
    await expect(panel.getByText('Not signed in')).toBeVisible({ timeout: 30_000 });
    // Running gcloud against the sandbox config must not have minted a
    // credential store there.
    await expectCloudSandboxed(app);
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

  test('add-provider wizard takes an optional read-only service account for GCP', async () => {
    // The reader the wizard browses as is written as the provider's
    // impersonateServiceAccount. Stops before "Find my export", which would
    // spawn gcloud: the field and its validation are what is exercised here.
    await openDataSync();
    await page.getByRole('button', { name: 'Add Provider' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add provider' });
    await dialog.getByLabel('Set up from Google Cloud').click();

    const reader = dialog.locator('#gcp-reader');
    const find = dialog.getByRole('button', { name: 'Find my export' });
    // A new provider starts on the account the setup guide creates, completed
    // with the project picked next.
    await expect(reader).toHaveValue('costgoblin-reader');
    await expect(dialog.locator('#gcp-reader-help')).toContainText('the project you pick');
    await expect(find).toBeEnabled();

    await reader.fill('someone@gmail.com');
    await expect(dialog.locator('#gcp-reader-help')).toContainText('name@project.iam.gserviceaccount.com');
    await expect(find).toBeDisabled();

    await reader.fill('costgoblin-reader@test-project.iam.gserviceaccount.com');
    await expect(dialog.locator('#gcp-reader-help')).toContainText('Token Creator');
    await expect(find).toBeEnabled();

    // Blank reads as the user's own login.
    await reader.fill('');
    await expect(find).toBeEnabled();
    await screenshot(page, 'gcp-wizard-reader-field');

    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(reader).toHaveCount(0);
    await assertNoReactCrash(page);
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
  test('re-running setup goes straight from daily to Confirm and keeps the tuned hourly retention', async () => {
    // The wizard's GCS discovery and its pre-save download check need
    // credentials, and this launch has none by design (see
    // expectCloudSandboxed). Stub just those channels in the main process;
    // everything after them — the Confirm step, the real setup:write-config
    // handler and the YAML it writes — runs as is. The check records what it
    // was asked, so the test can see it ran per tier as the right identity.
    await app.evaluate(({ ipcMain }) => {
      const checks: unknown[] = [];
      Reflect.set(globalThis, '__gcsDownloadChecks', checks);
      ipcMain.removeHandler('setup:verify-gcs-download');
      ipcMain.handle('setup:verify-gcs-download', (_event, params: unknown) => {
        checks.push(params);
        return { ok: true };
      });
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

    const pickTier = async (tier: 'daily' | 'hourly'): Promise<void> => {
      await page.getByText('test-focus-export', { exact: true }).click();
      await page.getByLabel(/^Open folder focus\/?$/).click();
      await page.getByLabel(new RegExp(`^Open folder ${tier}\\/?$`)).click();
      await page.getByRole('button', { name: 'Use this location' }).click();
    };
    const confirm = page.getByRole('heading', { name: 'Confirm Setup' });
    const dailyRetention = page.getByRole('group', { name: 'Daily FOCUS export retention' });
    const hourlyRetention = page.getByRole('group', { name: 'Hourly FOCUS export retention' });

    await clickNavButton(page, 'General');
    await page.getByRole('button', { name: 'Run setup again' }).click();
    await page.getByLabel('Set up from Google Cloud').click();
    // gcp-main already exists and has no reader: re-running setup keeps it
    // reading as the user, rather than prefilling the default reader.
    await expect(page.locator('#gcp-reader')).toHaveValue('');
    await page.getByLabel('Already know the project ID? Skip the project list').fill('test-project');
    await page.getByLabel('Already know the project ID? Skip the project list').press('Enter');

    // Daily lands straight on Confirm, as on AWS — hourly is optional.
    await pickTier('daily');
    await expect(confirm).toBeVisible();
    await expect(hourlyRetention).toHaveCount(0);

    // ← Back is the way to the optional hourly tier. The fixture's gcp-main
    // keeps 14 days of it; the pickers used to start on the 30-day default.
    await dailyRetention.getByRole('button', { name: '2 years' }).click();
    await page.getByRole('button', { name: '← Back' }).click();
    await pickTier('hourly');
    await expect(confirm).toBeVisible();
    await expect(hourlyRetention.getByRole('button', { name: '14 days' })).toHaveAttribute('aria-pressed', 'true');
    // The daily pick survived the round trip.
    await expect(dailyRetention.getByRole('button', { name: '2 years' })).toHaveAttribute('aria-pressed', 'true');
    // Both tiers were checked for download as gcloud's own account before
    // Complete Setup unlocked.
    await expect(page.getByText('gcloud can read this export as your gcloud account')).toBeVisible();
    const checks = await app.evaluate((): unknown => {
      const recorded: unknown = Reflect.get(globalThis, '__gcsDownloadChecks');
      return recorded;
    });
    expect(checks).toEqual(expect.arrayContaining([
      { bucketPath: 'gs://test-focus-export/focus/daily/' },
      { bucketPath: 'gs://test-focus-export/focus/hourly/' },
    ]));
    await screenshot(page, 'gcp-rerun-confirm');
    await page.getByRole('button', { name: 'Complete Setup' }).click();
    await expect(confirm).toBeHidden();

    const configDir = await app.evaluate(() => process.env['COSTGOBLIN_CONFIG_DIR'] ?? '');
    const written: unknown = parseYaml(readFileSync(join(configDir, 'costgoblin.yaml'), 'utf-8'));
    expect(written).toMatchObject({
      providers: [
        { name: 'aws-main', type: 'aws' },
        {
          name: 'gcp-main',
          type: 'gcp',
          sync: {
            daily: { bucket: 'gs://test-focus-export/focus/daily/', retentionDays: 730 },
            hourly: { bucket: 'gs://test-focus-export/focus/hourly/', retentionDays: 14 },
          },
        },
      ],
    });
    await assertNoReactCrash(page);
  });
});
