import { ipcMain, shell } from 'electron';
import {
  assertValidGcsBucketName,
  classifyGcsFolder,
  createGcsStorage,
  logger,
  isStringRecord,
} from '@costgoblin/core';
import type { GcpIdentityResult, GcpProject, GcsBrowseResult, GcsDownloadCheckResult } from '@costgoblin/core';
import { loadSharedConfigFiles } from '@smithy/shared-ini-file-loader';
import { awsProfileNames } from '../aws-profiles.js';
import { upsertWizardProvider } from '../config-upsert.js';
import { buildConfigTemplate, buildDimensionsTemplate, PROVIDER_ABSENT_DIMENSIONS } from '../config-templates.js';
import { runGcloudCapture } from '../gcloud-capture.js';
import { createGcpIdentityResolver, defaultIdentityDeps, gcpIdentitiesFor } from '../gcp-identity.js';
import type { GcpIdentityResolver } from '../gcp-identity.js';
import { collectGcsPrefixes, gcloudProjectsOutcome, gcsNextPageToken, listGcsBucketsAs, parseWizardReader, verifyGcsDownloadAs, wizardGcsErrorMessage, wizardWriteReader } from '../setup-gcp.js';
import { browseS3, listS3Buckets, testS3Connection } from '../setup-s3.js';
import type { AppContext } from './context.js';

/** Ceiling on `gcloud projects list`. The CLI can sit on a re-auth prompt it
 *  will never receive input for (stdin is ignored here), and an unbounded wait
 *  leaves the wizard's spinner running forever with no way back. */
const GCLOUD_PROJECTS_TIMEOUT_MS = 20_000;

/** Page size for a browse listing. `maxResults` bounds `items[] + prefixes[]`
 *  COMBINED in the GCS JSON API, so a folder that also holds loose objects can
 *  spend a whole page on them and return no folders at all — which is why the
 *  browse paginates rather than taking a single page. */
const GCS_BROWSE_PAGE_SIZE = 200;

/** Hard cap on pages walked per browse, so a bucket with a pathological number
 *  of children cannot hang the wizard. Hitting it sets `truncated`. */
const GCS_BROWSE_MAX_PAGES = 12;

/** Normalize a browsed prefix to the form the GCS delimiter listing needs:
 *  either empty (bucket root) or ending in the delimiter, so child names
 *  slice off cleanly. */
function normalizeGcsPrefix(prefix: string): string {
  if (prefix.length === 0) return '';
  return prefix.endsWith('/') ? prefix : `${prefix}/`;
}

/** One-shot CLI flag the setup wizard's relaunch adds (see update.ts) so the
 *  next launch knows to resume on the data-sync screen rather than the dashboard.
 *  It lives only for that process; a normal restart never carries it. */
export const POST_SETUP_FLAG = '--post-setup';

// Consumed on the FIRST setup:status of the process so an in-process renderer
// reload (e.g. config import calls location.reload) can't re-fire the redirect —
// the CLI flag stays in argv for the whole session, so argv alone isn't one-shot.
let postSetupConsumed = false;

export function registerSetupHandlers(app: AppContext): void {
  const { ctx, invalidateConfig, invalidateDimensions } = app;

  ipcMain.handle('setup:status', async (): Promise<{ configured: boolean; postSetup: boolean }> => {
    const fs = await import('node:fs/promises');
    const postSetup = !postSetupConsumed && process.argv.includes(POST_SETUP_FLAG);
    if (postSetup) postSetupConsumed = true;
    try {
      await fs.access(ctx.configPath);
      return { configured: true, postSetup };
    } catch {
      return { configured: false, postSetup };
    }
  });

  ipcMain.handle('setup:test-connection', (_event, params: { profile: string; bucket: string }) => testS3Connection(params));

  // The SDK's own loader, never a hand read of ~/.aws: see awsProfileNames.
  // ignoreCache because the loader memoises each file for the process
  // lifetime and a profile added since the last listing must show up. It
  // resolves to empty maps for a missing or unreadable file, never rejects.
  ipcMain.handle('setup:list-profiles', async (): Promise<string[]> =>
    awsProfileNames(await loadSharedConfigFiles({ ignoreCache: true })));

  ipcMain.handle('setup:list-buckets', (_event, profile: string) => listS3Buckets(profile));

  ipcMain.handle('setup:browse-s3', (_event, params: { profile: string; bucket: string; prefix: string }) => browseS3(params));

  // ---- GCP: the browse-and-pick counterpart of the three S3 handlers above.
  //
  // The asymmetry that remains is the project step. S3's ListBuckets is a
  // parameter-less, account-wide call; `storage.getBuckets()` is scoped to a
  // project, and Application Default Credentials frequently carry none (hence
  // the `Unable to detect a Project Id` case in `isGcpCredentialError`). The
  // list comes from the gcloud CLI rather than the Resource Manager API
  // because the CLI is already a hard requirement of the GCP download path,
  // so it costs no new dependency and no extra API to enable.

  ipcMain.handle('setup:list-gcp-projects', async (): Promise<{ projects: readonly GcpProject[]; error?: string | undefined }> => {
    // Shared capture helper: trusted binary, gcloudSpawnShape, trusted-first
    // child PATH, stdin ignored so a re-auth prompt fails on the timeout.
    const result = await runGcloudCapture(['projects', 'list', '--format=json'], GCLOUD_PROJECTS_TIMEOUT_MS);
    const outcome = gcloudProjectsOutcome(result);
    if (result.kind === 'exited' && outcome.error !== undefined) {
      logger.info('setup:list-gcp-projects failed', { error: outcome.error });
    }
    return outcome;
  });

  // Read-only: who the listing SDK and the gcloud CLI run as, for the
  // "Signed in as" panel. Lives with the wizard's GCP handlers because the
  // wizard is its first caller; Data Management passes a provider name so
  // that provider's `impersonateServiceAccount` / `keyFile` apply. One
  // resolver for the process, created on first use, so the panels Data
  // Management mounts together share a single gcloud read.
  let identityResolver: GcpIdentityResolver | null = null;
  ipcMain.handle('data:gcp-identities', (_event, rawProvider: unknown): Promise<GcpIdentityResult> => gcpIdentitiesFor(
    rawProvider,
    () => app.getConfig().catch(() => null),
    () => (identityResolver ??= createGcpIdentityResolver(defaultIdentityDeps())),
  ));

  // Both GCS handlers build their client through `createGcsStorage` — the
  // sync's own constructor — so the wizard browses as exactly the identity the
  // provider will sync as: the user's ADC login, or the reader it names.
  ipcMain.handle('setup:list-gcs-buckets', (_event, projectId: string, rawReader?: unknown) =>
    listGcsBucketsAs(projectId, rawReader, createGcsStorage));

  ipcMain.handle('setup:browse-gcs', async (_event, params: { projectId: string; bucket: string; prefix: string; impersonateServiceAccount?: unknown }): Promise<GcsBrowseResult> => {
    const prefix = normalizeGcsPrefix(params.prefix);
    const parsed = parseWizardReader(params.impersonateServiceAccount);
    if (!parsed.ok) return { prefixes: [], folder: { kind: 'unknown' }, hasParquet: false, truncated: false, error: parsed.error };
    try {
      // Before storage.bucket(): the SDK puts the name in its request URL
      // unencoded. Thrown inside the try so the wizard shows it inline.
      assertValidGcsBucketName(params.bucket);
      const storage = await createGcsStorage({ projectId: params.projectId, impersonateServiceAccount: parsed.reader });
      const bucket = storage.bucket(params.bucket);

      // PAGINATED, because `maxResults` bounds `items[] + prefixes[]`
      // COMBINED. A single 200-entry page of a bucket that also holds loose
      // objects at this level can be all objects and no folders, which
      // rendered as "No subfolders found" for a bucket that plainly contains
      // the export. The walk/dedupe/cap live in `collectGcsPrefixes` (tested);
      // this callback is just the SDK-specific page fetch.
      const { prefixes, truncated } = await collectGcsPrefixes(prefix, GCS_BROWSE_MAX_PAGES, async (pageToken) => {
        // The common prefixes live only on the raw `apiResponse` — the SDK
        // types it `unknown`, so `extractGcsPrefixNames` guards every step.
        const [, nextQuery, apiResponse] = await bucket.getFiles({
          prefix,
          delimiter: '/',
          maxResults: GCS_BROWSE_PAGE_SIZE,
          autoPaginate: false,
          ...(pageToken === undefined ? {} : { pageToken }),
        });
        return { apiResponse, nextPageToken: gcsNextPageToken(nextQuery) };
      });

      const folder = classifyGcsFolder(prefixes);

      // Stand-in for the AWS side's manifest read: confirm a period partition
      // actually holds shards, so the wizard can't hand the sync a partition
      // the exporter created and never filled.
      //
      // The NEWEST period, not the oldest: `classifyGcsFolder` sorts ascending,
      // and the oldest partition is the one a lifecycle rule or the exporter
      // README's documented `gcloud storage rm --recursive` cleanup will have
      // emptied, leaving a folder placeholder. Probing it reported a healthy,
      // actively-running export as empty and hard-disabled the button.
      let hasParquet = false;
      if (folder.kind === 'export') {
        const newestPeriod = folder.periods[folder.periods.length - 1];
        if (newestPeriod !== undefined) {
          try {
            const [periodFiles] = await bucket.getFiles({
              // Well above a page of `_SUCCESS` / `.tmp…` / placeholder
              // objects, all of which sort BEFORE `shard-` lexicographically
              // and used to crowd `.parquet` out of a 10-key sample.
              prefix: `${prefix}billing_period=${newestPeriod}/`,
              maxResults: 200,
              autoPaginate: false,
            });
            hasParquet = periodFiles.some(f => f.name.endsWith('.parquet'));
          } catch {
            // Inner catch, mirroring `setup:browse-s3`'s manifest read: a probe
            // that fails (transient 5xx, or an IAM condition that grants the
            // tier prefix but not the period prefix) must degrade the shard
            // check, NOT discard a folder listing we already have.
            hasParquet = false;
          }
        }
      }

      return { prefixes, folder, hasParquet, truncated };
    } catch (err: unknown) {
      const message = wizardGcsErrorMessage(err, parsed.reader);
      logger.info('setup:browse-gcs failed', { error: message });
      // As in `setup:browse-s3`, the message is carried back rather than
      // swallowed into an empty listing: a GCP browse fails mostly on
      // credentials, and the wizard turns that into an inline sign-in button.
      return { prefixes: [], folder: { kind: 'unknown' }, hasParquet: false, truncated: false, error: message };
    }
  });

  // The other half of "browse as the identity the sync uses": listing and
  // browsing above run through the Storage SDK, but the provider's downloads
  // run through `gcloud storage rsync` as gcloud's own active account. A
  // folder the wizard browsed can still refuse the download (403 on
  // storage.objects.get), so the Confirm step asks gcloud itself — through
  // the rsync's binary resolution, spawn shape and child PATH — before saving.
  ipcMain.handle('setup:verify-gcs-download', (_event, rawParams: unknown): Promise<GcsDownloadCheckResult> =>
    verifyGcsDownloadAs(rawParams, {
      run: runGcloudCapture,
      keyFileOf: async (name) => {
        const config = await app.getConfig().catch(() => null);
        const provider = config?.providers.find(p => String(p.name) === name);
        return provider?.type === 'gcp' ? provider.keyFile : undefined;
      },
    }));

  ipcMain.handle('setup:write-config', async (_event, wizardConfig: {
    providerName: string;
    type?: 'aws' | 'gcp' | undefined;
    profile: string;
    keyFile?: string | undefined;
    impersonateServiceAccount?: unknown;
    dailyBucket: string;
    retentionDays?: number | undefined;
    hourlyRetentionDays?: number | undefined;
    costOptRetentionDays?: number | undefined;
    hourlyBucket?: string | undefined;
    costOptBucket?: string | undefined;
    tags?: { tagName: string; label: string; concept?: string | undefined }[] | undefined;
  }): Promise<void> => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const { stringify, parse: parseYaml } = await import('yaml');

    const configDir = path.dirname(ctx.configPath);
    await fs.mkdir(configDir, { recursive: true });

    let existing: Readonly<Record<string, unknown>> = {};
    try {
      const raw = await fs.readFile(ctx.configPath, 'utf-8');
      const parsed: unknown = parseYaml(raw);
      if (isStringRecord(parsed)) {
        existing = parsed;
      }
    } catch {
      // no existing config
    }

    // UPSERT by provider name: replace the matching entry in place, append a
    // new one otherwise; other providers and unknown top-level keys are
    // preserved verbatim. Throws ProviderNameError (friendly message,
    // surfaced to the wizard) on an invalid name.
    const impersonateServiceAccount = wizardWriteReader(wizardConfig.impersonateServiceAccount);
    const costgoblinYaml = upsertWizardProvider(existing, { ...wizardConfig, impersonateServiceAccount });

    await fs.writeFile(ctx.configPath, stringify(costgoblinYaml), 'utf-8');

    const builtInDimensions = [
      {
        name: 'account',
        label: 'Account',
        field: 'account_id',
        displayField: 'account_name',
        description: 'AWS account the cost was charged to. Main axis for org/team-level rollups.',
        useOrgAccounts: true,
      },
      {
        name: 'region',
        label: 'Region',
        field: 'region',
        description: 'AWS region where the resource ran. Useful for spotting unintended multi-region sprawl.',
      },
      {
        name: 'service',
        label: 'Service',
        field: 'service',
        description: 'Service the cost came from (FOCUS ServiceName, e.g. "Amazon Simple Storage Service") — the broadest "what cost me this?" view.',
      },
      {
        name: 'service_category',
        label: 'Service Category',
        field: 'service_category',
        description: 'Standardized FOCUS category (Compute, Storage, Databases). Good for exec summaries.',
      },
      {
        name: 'charge_category',
        label: 'Charge Category',
        field: 'charge_category',
        description: 'Usage vs Purchase vs Tax vs Credit vs Adjustment. Filter this to isolate real usage from billing events.',
      },
      {
        name: 'sku_meter',
        label: 'SKU Meter',
        field: 'sku_meter',
        description: 'Fine-grained usage meter like EUC1-Requests-Tier2. Use for instance/storage-tier breakdowns.',
      },
      {
        name: 'operation',
        label: 'Operation',
        field: 'operation',
        description: 'API operation billed for (RunInstances, GetObject). Useful for API-level cost attribution.',
        enabled: false,
      },
    ];

    const tagDimensions = (wizardConfig.tags ?? []).map(t => ({
      tagName: t.tagName,
      label: t.label,
      ...(t.concept === undefined ? {} : { concept: t.concept }),
    }));

    // GCP's FOCUS export has no ServiceCategory, and the canonicalizer only
    // NULL-fills x_Operation and SkuMeter — so scaffolding them for a gcp
    // provider produces dimensions that render one blank value for every row.
    // `buildDimensionsTemplate('gcp')` already drops them, and the default-
    // dimension merge (context.ts) skips re-adding them; all three read the
    // same PROVIDER_ABSENT_DIMENSIONS map so the routes cannot disagree.
    const absentDims = wizardConfig.type === 'gcp' ? PROVIDER_ABSENT_DIMENSIONS.gcp : PROVIDER_ABSENT_DIMENSIONS.aws;
    const dimensionsYaml = {
      builtIn: builtInDimensions.filter(d => !absentDims.has(d.name)),
      tags: tagDimensions,
    };

    // Only (re)write dimensions.yaml when the wizard actually collected tag
    // choices or no file exists yet (true first run). A re-run that skipped
    // the tag step — per-tier Configure, Add Provider — must not wipe the
    // user's curated dimensions with the defaults.
    const dimensionsExist = await fs.access(ctx.dimensionsPath).then(() => true, () => false);
    if (!dimensionsExist || wizardConfig.tags !== undefined) {
      await fs.writeFile(ctx.dimensionsPath, stringify(dimensionsYaml), 'utf-8');
    }

    invalidateConfig();
    invalidateDimensions();
    logger.info('Setup wizard wrote config files');
  });

  ipcMain.handle('setup:scaffold-config', async (_event, providerType: unknown): Promise<void> => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const configDir = path.dirname(ctx.configPath);
    await fs.mkdir(configDir, { recursive: true });

    // Anything other than the explicit 'gcp' string keeps the historical AWS
    // template — the argument arrives over IPC and pre-#517 callers send none.
    const templateType = providerType === 'gcp' ? 'gcp' : 'aws';
    const configTemplate = buildConfigTemplate(templateType);
    const dimensionsTemplate = buildDimensionsTemplate(templateType);

    try { await fs.access(ctx.configPath); } catch {
      await fs.writeFile(ctx.configPath, configTemplate, 'utf-8');
    }
    try { await fs.access(ctx.dimensionsPath); } catch {
      await fs.writeFile(ctx.dimensionsPath, dimensionsTemplate, 'utf-8');
    }

    await shell.openPath(configDir);
    logger.info('Scaffolded template config files');
  });
}
