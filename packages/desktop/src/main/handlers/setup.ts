import { ipcMain, shell } from 'electron';
import { logger, parseS3Path, isStringRecord, parseJsonObject } from '@costgoblin/core';
import type { AppContext } from './context.js';

export function registerSetupHandlers(app: AppContext): void {
  const { ctx, invalidateConfig, invalidateDimensions } = app;

  ipcMain.handle('setup:status', async (): Promise<{ configured: boolean }> => {
    const fs = await import('node:fs/promises');
    try {
      await fs.access(ctx.configPath);
      return { configured: true };
    } catch {
      return { configured: false };
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
        const profileRegex = /\[(?:profile\s+)?([^\]]+)\]/g;
        let match = profileRegex.exec(content);
        while (match !== null) {
          const name = match[1];
          if (name !== undefined) profiles.add(name.trim());
          match = profileRegex.exec(content);
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
        ...(profile !== 'default' ? { profile } : {}),
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

  ipcMain.handle('setup:browse-s3', async (_event, params: { profile: string; bucket: string; prefix: string }): Promise<{ prefixes: string[]; isCurReport: boolean; detectedType: 'daily' | 'hourly' | 'cost-optimization' | 'unknown'; missingColumns: string[] }> => {
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

      const hasData = prefixes.includes('data');
      const hasMetadata = prefixes.includes('metadata');
      const isCurReport = hasData && hasMetadata;

      let detectedType: 'daily' | 'hourly' | 'cost-optimization' | 'unknown' = 'unknown';
      let missingColumns: string[] = [];

      const requiredCurColumns = [
        'line_item_usage_start_date', 'line_item_usage_account_id',
        'line_item_unblended_cost', 'product_servicecode',
        'product_product_family', 'product_region_code', 'resource_tags',
      ];

      if (isCurReport) {
        try {
          const metaList = await client.send(new ListObjectsV2Command({
            Bucket: params.bucket,
            Prefix: `${params.prefix}metadata/`,
            MaxKeys: 10,
          }));

          const manifestKey = (metaList.Contents ?? []).find(c => c.Key?.endsWith('.json'))?.Key;
          if (manifestKey !== undefined) {
            const manifestResponse = await client.send(new GetObjectCommand({ Bucket: params.bucket, Key: manifestKey }));
            const body = await manifestResponse.Body?.transformToString();
            if (body !== undefined) {
              const columns = parseJsonObject(body)?.['columns'];
              const columnNames: string[] = Array.isArray(columns)
                ? columns
                  .filter(isStringRecord)
                  .map(c => typeof c['name'] === 'string' ? c['name'] : '')
                  .filter(n => n.length > 0)
                : [];

              if (columnNames.includes('recommendation_id') || columnNames.includes('estimated_monthly_savings')) {
                detectedType = 'cost-optimization';
              } else if (columnNames.includes('line_item_usage_start_date')) {
                detectedType = 'daily';
                missingColumns = requiredCurColumns.filter(c => !columnNames.includes(c));
              }
            }
          }
        } catch {
          // manifest detection failed
        }
      }

      return { prefixes, isCurReport, detectedType, missingColumns };
    } catch {
      return { prefixes: [], isCurReport: false, detectedType: 'unknown', missingColumns: [] };
    }
  });

  ipcMain.handle('setup:write-config', async (_event, wizardConfig: {
    providerName: string;
    profile: string;
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

    const existingProviders: Readonly<Record<string, unknown>>[] = Array.isArray(existing['providers'])
      ? existing['providers'].filter(isStringRecord)
      : [];
    const existingProvider = existingProviders[0] ?? {};
    const rawSync = existingProvider['sync'];
    const existingSync: Readonly<Record<string, unknown>> = isStringRecord(rawSync) ? rawSync : {};

    const sync: Record<string, unknown> = { ...existingSync, intervalMinutes: 60 };

    if (wizardConfig.dailyBucket.length > 0) {
      sync['daily'] = { bucket: wizardConfig.dailyBucket, retentionDays: wizardConfig.retentionDays ?? 365 };
    }
    if (wizardConfig.hourlyBucket !== undefined && wizardConfig.hourlyBucket.length > 0) {
      sync['hourly'] = { bucket: wizardConfig.hourlyBucket, retentionDays: 30 };
    }
    if (wizardConfig.costOptBucket !== undefined && wizardConfig.costOptBucket.length > 0) {
      sync['costOptimization'] = { bucket: wizardConfig.costOptBucket, retentionDays: 90 };
    }

    const costgoblinYaml = {
      ...existing,
      providers: [{
        name: wizardConfig.providerName,
        type: 'aws',
        credentials: { profile: wizardConfig.profile },
        sync,
      }],
      defaults: typeof existing['defaults'] === 'object' && existing['defaults'] !== null ? existing['defaults'] : { periodDays: 30, costMetric: 'UnblendedCost', lagDays: 2 },
    };

    await fs.writeFile(ctx.configPath, stringify(costgoblinYaml), 'utf-8');

    const builtInDimensions = [
      { name: 'account', label: 'Account', field: 'account_id', displayField: 'account_name' },
      { name: 'region', label: 'Region', field: 'region' },
      { name: 'service', label: 'Service', field: 'service' },
      { name: 'service_family', label: 'Service Family', field: 'service_family' },
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

    await fs.writeFile(ctx.dimensionsPath, stringify(dimensionsYaml), 'utf-8');

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
    credentials:
      profile: default  # <- your AWS CLI profile name
    sync:
      daily:
        bucket: s3://your-bucket/path/to/cur/  # <- path containing data/ and metadata/
        retentionDays: 365
      intervalMinutes: 60

defaults:
  periodDays: 30
  costMetric: UnblendedCost
  lagDays: 2
`;

    const dimensionsTemplate = `# Dimension configuration
# Built-in dimensions are always available. Add tag dimensions to map your CUR tags.

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
  - name: service_family
    label: Service Family
    field: service_family

# Map your CUR resource tags below.
# tagName: the tag key in your CUR (without the "user_" prefix)
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
