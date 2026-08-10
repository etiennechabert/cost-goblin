import { ipcMain, shell } from 'electron';
import {
  GCS_READ_ONLY_SCOPE,
  classifyGcsFolder,
  findGcloudCli,
  gcloudSearchPaths,
  logger,
  parseS3Path,
  isStringRecord,
} from '@costgoblin/core';
import type { GcpProject, GcsBrowseResult } from '@costgoblin/core';
import { upsertWizardProvider } from '../config-upsert.js';
import { buildConfigTemplate, buildDimensionsTemplate, PROVIDER_ABSENT_DIMENSIONS } from '../config-templates.js';
import { classifyManifestColumns, parseManifestColumnNames, selectManifestKey } from '../setup-manifest.js';
import { collectGcsPrefixes, gcsNextPageToken, parseGcloudProjects } from '../setup-gcp.js';
import type { DetectedReportType } from '../setup-manifest.js';
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

  ipcMain.handle('setup:test-connection', async (_event, params: { profile: string; bucket: string }): Promise<{ ok: boolean; error?: string | undefined }> => {
    try {
      const { S3Client, ListObjectsV2Command } = await import('@aws-sdk/client-s3');
      const parsed = parseS3Path(params.bucket);
      const client = new S3Client({
        region: 'eu-central-1',
        ...(params.profile === 'default' ? {} : { profile: params.profile }),
      });

      await client.send(new ListObjectsV2Command({
        Bucket: parsed.bucket,
        Prefix: parsed.prefix,
        MaxKeys: 1,
      }));

      return { ok: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  });

  ipcMain.handle('setup:list-profiles', async (): Promise<string[]> => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const os = await import('node:os');

    const profiles = new Set<string>();
    profiles.add('default');

    for (const filename of ['config', 'credentials']) {
      const filePath = path.join(os.homedir(), '.aws', filename);
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) continue;
          let name = trimmed.slice(1, -1).trim();
          if (name.length === 0) continue;
          if (name.startsWith('profile ')) name = name.slice('profile '.length).trim();
          profiles.add(name);
        }
      } catch {
        // file doesn't exist
      }
    }

    return [...profiles].sort((a, b) => a.localeCompare(b));
  });

  ipcMain.handle('setup:list-buckets', async (_event, profile: string): Promise<{ buckets: { name: string; region: string }[]; error?: string | undefined }> => {
    try {
      const { S3Client, ListBucketsCommand } = await import('@aws-sdk/client-s3');
      const client = new S3Client({
        region: 'us-east-1',
        ...(profile === 'default' ? {} : { profile }),
      });

      const response = await client.send(new ListBucketsCommand({}));
      const buckets = (response.Buckets ?? [])
        .filter(b => b.Name !== undefined)
        .map(b => ({ name: b.Name ?? '', region: '' }));
      return { buckets };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.info('setup:list-buckets failed', { error: message });
      return { buckets: [], error: message };
    }
  });

  ipcMain.handle('setup:browse-s3', async (_event, params: { profile: string; bucket: string; prefix: string }): Promise<{ prefixes: string[]; isBillingExport: boolean; detectedType: DetectedReportType; missingColumns: string[]; error?: string | undefined }> => {
    try {
      const { S3Client, ListObjectsV2Command, GetObjectCommand } = await import('@aws-sdk/client-s3');
      const client = new S3Client({
        region: 'eu-central-1',
        ...(params.profile === 'default' ? {} : { profile: params.profile }),
      });

      const response = await client.send(new ListObjectsV2Command({
        Bucket: params.bucket,
        Prefix: params.prefix,
        Delimiter: '/',
        MaxKeys: 200,
      }));

      const prefixes = (response.CommonPrefixes ?? [])
        .filter(p => p.Prefix !== undefined)
        .map(p => {
          const full = p.Prefix ?? '';
          const relative = full.slice(params.prefix.length);
          return relative.replace(/\/$/, '');
        })
        .filter(p => p.length > 0);

      const isBillingExport = prefixes.includes('data') && prefixes.includes('metadata');

      let detectedType: DetectedReportType = 'unknown';
      let missingColumns: string[] = [];

      if (isBillingExport) {
        try {
          const metaList = await client.send(new ListObjectsV2Command({
            Bucket: params.bucket,
            Prefix: `${params.prefix}metadata/`,
            MaxKeys: 10,
          }));
          const jsonKeys = (metaList.Contents ?? [])
            .map(c => c.Key)
            .filter((k): k is string => k !== undefined && k.endsWith('.json'));
          const manifestKey = selectManifestKey(jsonKeys);
          if (manifestKey !== undefined) {
            const manifestResponse = await client.send(new GetObjectCommand({ Bucket: params.bucket, Key: manifestKey }));
            const body = await manifestResponse.Body?.transformToString();
            if (body !== undefined) {
              const columnNames = parseManifestColumnNames(body);
              const classification = classifyManifestColumns(columnNames);
              detectedType = classification.detectedType;
              missingColumns = classification.missingColumns;
            }
          }
        } catch {
          // manifest detection failed
        }
      }

      return { prefixes, isBillingExport, detectedType, missingColumns };
    } catch (err: unknown) {
      // Surface the failure instead of swallowing it into an empty result. An
      // expired SSO token or an s3:ListBucket AccessDenied while browsing used
      // to render exactly like a genuinely empty bucket ("No subfolders
      // found") — no message, no sign-in, no Retry. The wizard's browse step
      // now shows an error panel, matching the bucket-list step and the GCP
      // browse leg (the dead end #539/#542 removed everywhere else).
      const message = err instanceof Error ? err.message : String(err);
      logger.info('setup:browse-s3 failed', { error: message });
      return { prefixes: [], isBillingExport: false, detectedType: 'unknown', missingColumns: [], error: message };
    }
  });

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
    const { spawn } = await import('node:child_process');
    const { delimiter } = await import('node:path');
    const { StringDecoder } = await import('node:string_decoder');

    // `findGcloudCli` returning null is the "not installed" signal on every
    // platform — it cannot come from spawn: on Windows gcloud is a `.cmd`
    // that needs a shell (CVE-2024-27980), and cmd.exe starts fine whether or
    // not gcloud exists, so ENOENT can never fire there.
    const bin = findGcloudCli();
    if (bin === null) {
      return { projects: [], error: 'GCLOUD_CLI_NOT_FOUND' };
    }
    const useShell = process.platform === 'win32';
    const currentPath = process.env['PATH'] ?? '';
    const fullPath = [...new Set([...currentPath.split(delimiter), ...gcloudSearchPaths()])].join(delimiter);
    const args = ['projects', 'list', '--format=json'];

    return new Promise<{ projects: readonly GcpProject[]; error?: string | undefined }>((resolve) => {
      const proc = spawn(
        useShell ? `"${bin}"` : bin,
        useShell ? args.map(a => `"${a}"`) : args,
        {
          // stdin ignored: a gcloud that wants interactive re-auth must fail
          // on the timeout below rather than block waiting for input.
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: useShell,
          env: { ...process.env, PATH: fullPath },
        },
      );

      // StringDecoder, not chunk.toString(): a pipe boundary can fall mid
      // multi-byte character, and two halves each decode to U+FFFD. JSON still
      // parses, so a mangled project name would reach the picker silently.
      const outDecoder = new StringDecoder('utf8');
      const errDecoder = new StringDecoder('utf8');
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (result: { projects: readonly GcpProject[]; error?: string | undefined }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      const timer = setTimeout(() => {
        proc.kill();
        finish({ projects: [], error: 'Timed out listing projects. Check that `gcloud auth login` has been run.' });
      }, GCLOUD_PROJECTS_TIMEOUT_MS);

      proc.stdout.on('data', (chunk: Buffer) => { stdout += outDecoder.write(chunk); });
      proc.stderr.on('data', (chunk: Buffer) => { stderr += errDecoder.write(chunk); });

      proc.on('error', (err: NodeJS.ErrnoException) => {
        finish({ projects: [], error: err.code === 'ENOENT' ? 'GCLOUD_CLI_NOT_FOUND' : err.message });
      });

      proc.on('close', (code) => {
        stdout += outDecoder.end();
        stderr += errDecoder.end();
        if (code === 0) {
          const projects = parseGcloudProjects(stdout);
          if (projects === null) {
            // Exit 0 but unreadable stdout. Reporting [] here would render as
            // "the signed-in account can't see any active projects" — a false
            // statement about their account, with no remedy offered.
            finish({ projects: [], error: 'Could not read the project list from gcloud. Run `gcloud projects list` in a terminal to see what it printed.' });
            return;
          }
          finish({ projects });
          return;
        }
        // gcloud's own stderr is the most useful thing to show: it names the
        // exact remedy ("You do not currently have an active account") that
        // the wizard's sign-in button then performs.
        const message = stderr.trim().length > 0 ? stderr.trim() : `gcloud projects list failed (exit ${String(code)})`;
        logger.info('setup:list-gcp-projects failed', { error: message });
        finish({ projects: [], error: message });
      });
    });
  });

  ipcMain.handle('setup:list-gcs-buckets', async (_event, projectId: string): Promise<{ buckets: readonly { name: string }[]; error?: string | undefined }> => {
    try {
      const { Storage } = await import('@google-cloud/storage');
      const storage = new Storage({ projectId, scopes: [GCS_READ_ONLY_SCOPE] });
      const [buckets] = await storage.getBuckets();
      return { buckets: buckets.map(b => ({ name: b.name })) };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.info('setup:list-gcs-buckets failed', { error: message });
      return { buckets: [], error: message };
    }
  });

  ipcMain.handle('setup:browse-gcs', async (_event, params: { projectId: string; bucket: string; prefix: string }): Promise<GcsBrowseResult> => {
    const prefix = normalizeGcsPrefix(params.prefix);
    try {
      const { Storage } = await import('@google-cloud/storage');
      const storage = new Storage({ projectId: params.projectId, scopes: [GCS_READ_ONLY_SCOPE] });
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
      const message = err instanceof Error ? err.message : String(err);
      logger.info('setup:browse-gcs failed', { error: message });
      // Unlike `setup:browse-s3`, which swallows the error into an empty
      // listing, the message is carried back: a GCP browse fails mostly on
      // credentials, and the wizard turns that into an inline sign-in button.
      return { prefixes: [], folder: { kind: 'unknown' }, hasParquet: false, truncated: false, error: message };
    }
  });

  ipcMain.handle('setup:write-config', async (_event, wizardConfig: {
    providerName: string;
    type?: 'aws' | 'gcp' | undefined;
    profile: string;
    keyFile?: string | undefined;
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
    const costgoblinYaml = upsertWizardProvider(existing, wizardConfig);

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
