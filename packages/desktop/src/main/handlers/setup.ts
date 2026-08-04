import { ipcMain, shell } from 'electron';
import { logger, parseS3Path, isStringRecord } from '@costgoblin/core';
import { upsertWizardProvider } from '../config-upsert.js';
import { classifyManifestColumns, parseManifestColumnNames, selectManifestKey } from '../setup-manifest.js';
import type { DetectedReportType } from '../setup-manifest.js';
import type { AppContext } from './context.js';

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

  ipcMain.handle('setup:browse-s3', async (_event, params: { profile: string; bucket: string; prefix: string }): Promise<{ prefixes: string[]; isBillingExport: boolean; detectedType: DetectedReportType; missingColumns: string[] }> => {
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
    } catch {
      return { prefixes: [], isBillingExport: false, detectedType: 'unknown', missingColumns: [] };
    }
  });

  ipcMain.handle('setup:write-config', async (_event, wizardConfig: {
    providerName: string;
    type?: 'aws' | 'gcp' | undefined;
    profile: string;
    keyFile?: string | undefined;
    dailyBucket: string;
    retentionDays?: number | undefined;
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

    const dimensionsYaml = {
      builtIn: builtInDimensions,
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

  ipcMain.handle('setup:scaffold-config', async (): Promise<void> => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const configDir = path.dirname(ctx.configPath);
    await fs.mkdir(configDir, { recursive: true });

    const configTemplate = `# CostGoblin configuration
# See https://github.com/etiennechabert/cost-goblin for documentation

providers:
  - name: aws-main
    type: aws
    credentialsProfile: default  # <- your AWS CLI profile name
    sync:
      daily:
        bucket: s3://your-bucket/path/to/focus-export/  # <- path containing data/ and metadata/
        retentionDays: 365
      intervalMinutes: 60

  # GCP looks like this. Uncomment and adjust to add one alongside the AWS
  # provider above, or replace that block entirely if you only use GCP.
  # It reads the bucket filled by scripts/gcp-focus-exporter — bucket is that
  # deploy's BUCKET + PREFIX. Credentials come from Application Default
  # Credentials (gcloud auth application-default login); add
  # impersonateServiceAccount to use a read-only service account instead.
  # There is no hourly or costOptimization tier: GCP delivers neither.
  # - name: gcp-main
  #   type: gcp
  #   sync:
  #     daily:
  #       bucket: gs://your-bucket/focus/
  #       retentionDays: 365
  #     intervalMinutes: 60

defaults:
  periodDays: 30
  costMetric: effective
  lagDays: 2
`;

    const dimensionsTemplate = `# Dimension configuration
# Built-in dimensions are always available. Add tag dimensions to map your
# resource tags (the FOCUS Tags map).

builtIn:
  - name: account
    label: Account
    field: account_id
    displayField: account_name
  - name: region
    label: Region
    field: region
  - name: service
    label: Service
    field: service
  - name: service_category
    label: Service Category
    field: service_category

# Map your resource tags below.
# tagName: the tag key exactly as it appears in the FOCUS Tags map
# concept: owner | product | environment (enables special UI features)
tags: []
  # Example:
  # - tagName: team
  #   label: Team
  #   concept: owner
  # - tagName: app
  #   label: Application
  #   concept: product
  # - tagName: env
  #   label: Environment
  #   concept: environment
`;

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
