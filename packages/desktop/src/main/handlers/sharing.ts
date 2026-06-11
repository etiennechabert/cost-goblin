import { app as electronApp, dialog, ipcMain } from 'electron';
import {
  CONFIG_BEACON_KEY,
  ConfigValidationError,
  buildConfigBundle,
  bundleConfigWithProfile,
  bundleSectionIds,
  costGoblinConfigToYaml,
  costScopeToYaml,
  dimensionsConfigToYaml,
  isStringRecord,
  logger,
  orgTreeToYaml,
  parseConfigBundle,
  serializeConfigBundle,
  splitS3Location,
  suggestedConfigBeaconLocation,
  summarizeConfigBundle,
  viewsConfigToYaml,
} from '@costgoblin/core';
import type {
  ApplyConfigBundleResult,
  CheckConfigBeaconResult,
  ConfigBundle,
  ExportConfigBundleResult,
  PreviewConfigBundleResult,
  PublishConfigBundleResult,
} from '@costgoblin/core';
import type { AppContext } from './context.js';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** S3 errors that mean "nothing published here" rather than "broken".
 *  AccessDenied is included: without s3:ListBucket a missing key surfaces
 *  as 403, and a beacon the user cannot read is equivalent to no beacon. */
function isBeaconAbsence(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'NoSuchKey' || err.name === 'NotFound' || err.name === 'NoSuchBucket' || err.name === 'AccessDenied';
}

export function registerSharingHandlers(app: AppContext): void {
  const { ctx, getConfig, getDimensions, getOrgTreeConfig, getViews, getCostScope, clearAllCaches } = app;

  /** Assemble a bundle from whatever org config exists locally. Config and
   *  dimensions are mandatory; the optional files are skipped when missing
   *  or unreadable instead of failing the whole export. */
  async function buildCurrentBundle(): Promise<ConfigBundle> {
    const config = await getConfig();
    const dimensions = await getDimensions();
    const orgTree = await getOrgTreeConfig().catch(() => undefined);
    const costScope = await getCostScope().catch(() => undefined);
    const views = await getViews().catch(() => undefined);
    return buildConfigBundle({
      config,
      dimensions,
      orgTree,
      costScope,
      views,
      appVersion: electronApp.getVersion(),
    });
  }

  ipcMain.handle('sharing:export-bundle', async (): Promise<ExportConfigBundleResult> => {
    try {
      const bundle = await buildCurrentBundle();
      const result = await dialog.showSaveDialog({
        title: 'Export CostGoblin configuration',
        defaultPath: `costgoblin-config-${new Date().toISOString().slice(0, 10)}.yaml`,
        filters: [{ name: 'CostGoblin configuration bundle', extensions: ['yaml', 'yml'] }],
      });
      if (result.canceled || result.filePath.length === 0) return { status: 'canceled' };
      const fs = await import('node:fs/promises');
      await fs.writeFile(result.filePath, serializeConfigBundle(bundle), 'utf-8');
      logger.info('Exported configuration bundle', { path: result.filePath });
      return { status: 'saved', path: result.filePath };
    } catch (err: unknown) {
      return { status: 'error', message: errorMessage(err) };
    }
  });

  ipcMain.handle('sharing:preview-bundle-file', async (): Promise<PreviewConfigBundleResult> => {
    try {
      const result = await dialog.showOpenDialog({
        title: 'Import CostGoblin configuration',
        properties: ['openFile'],
        filters: [
          { name: 'CostGoblin configuration bundle', extensions: ['yaml', 'yml'] },
          { name: 'All files', extensions: ['*'] },
        ],
      });
      const filePath = result.filePaths[0];
      if (result.canceled || filePath === undefined) return { status: 'canceled' };
      const fs = await import('node:fs/promises');
      const content = await fs.readFile(filePath, 'utf-8');
      const parsed = parseConfigBundle(content);
      return { status: 'ok', content, summary: summarizeConfigBundle(parsed) };
    } catch (err: unknown) {
      return { status: 'error', message: errorMessage(err) };
    }
  });

  /** Copy whichever org config files exist into config/backups/<timestamp>/
   *  so an import is always one folder-copy away from being undone. */
  async function backupExistingConfig(): Promise<string | null> {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const configDir = path.dirname(ctx.configPath);
    const candidates = [ctx.configPath, ctx.dimensionsPath, ctx.orgTreePath, ctx.costScopePath, ctx.viewsPath];
    const existing: string[] = [];
    for (const file of candidates) {
      try {
        await fs.access(file);
        existing.push(file);
      } catch {
        // not present — nothing to back up
      }
    }
    if (existing.length === 0) return null;
    const stamp = new Date().toISOString().replaceAll(':', '-');
    const backupDir = path.join(configDir, 'backups', stamp);
    await fs.mkdir(backupDir, { recursive: true });
    for (const file of existing) {
      await fs.copyFile(file, path.join(backupDir, path.basename(file)));
    }
    return backupDir;
  }

  ipcMain.handle('sharing:apply-bundle', async (_event, raw: unknown): Promise<ApplyConfigBundleResult> => {
    if (!isStringRecord(raw) || typeof raw['content'] !== 'string' || typeof raw['profile'] !== 'string' || raw['profile'].length === 0) {
      return { status: 'error', message: 'Invalid import parameters' };
    }
    const content = raw['content'];
    const profile = raw['profile'];
    try {
      // Never trust the renderer's earlier preview — re-parse and
      // re-validate here, in the process that writes the files.
      const parsed = parseConfigBundle(content);
      const { sections } = parsed.bundle;

      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const { stringify } = await import('yaml');
      await fs.mkdir(path.dirname(ctx.configPath), { recursive: true });
      const backupDir = await backupExistingConfig();

      const config = bundleConfigWithProfile(sections.config, profile);
      await fs.writeFile(ctx.configPath, stringify(costGoblinConfigToYaml(config)), 'utf-8');
      await fs.writeFile(ctx.dimensionsPath, stringify(dimensionsConfigToYaml(sections.dimensions)), 'utf-8');
      if (sections.orgTree !== undefined) {
        await fs.writeFile(ctx.orgTreePath, stringify(orgTreeToYaml(sections.orgTree)), 'utf-8');
      }
      if (sections.costScope !== undefined) {
        await fs.writeFile(ctx.costScopePath, stringify(costScopeToYaml(sections.costScope)), 'utf-8');
      }
      if (sections.views !== undefined) {
        await fs.writeFile(ctx.viewsPath, stringify(viewsConfigToYaml(sections.views)), 'utf-8');
      }

      await clearAllCaches();
      logger.info('Applied configuration bundle', {
        sections: bundleSectionIds(sections).join(','),
        backupDir: backupDir ?? 'none',
      });
      return { status: 'applied', sections: bundleSectionIds(sections), backupDir };
    } catch (err: unknown) {
      return { status: 'error', message: errorMessage(err) };
    }
  });

  ipcMain.handle('sharing:publish-bundle', async (_event, raw: unknown): Promise<PublishConfigBundleResult> => {
    try {
      const config = await getConfig();
      const provider = config.providers[0];
      if (provider === undefined) {
        return { status: 'error', message: 'No provider configured — complete setup before publishing' };
      }
      // Caller may override the destination (e.g. write-locked CUR bucket →
      // sibling config bucket). Default is the discoverable beacon key at
      // the daily bucket's root.
      const requested = isStringRecord(raw) && typeof raw['location'] === 'string' && raw['location'].trim().length > 0
        ? raw['location']
        : suggestedConfigBeaconLocation(String(provider.sync.daily.bucket));
      const target = splitS3Location(requested);
      if (target === null) {
        return { status: 'error', message: 'Invalid S3 location — expected s3://bucket/path/to/org-config.yaml' };
      }
      const body = serializeConfigBundle(await buildCurrentBundle());

      const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
      const profile = provider.credentials.profile;
      const client = new S3Client({
        region: 'eu-central-1',
        followRegionRedirects: true,
        ...(profile === 'default' ? {} : { profile }),
      });
      await client.send(new PutObjectCommand({
        Bucket: target.bucket,
        Key: target.key,
        Body: body,
        ContentType: 'application/yaml',
      }));
      const location = `s3://${target.bucket}/${target.key}`;
      logger.info('Published configuration bundle', { location });
      return { status: 'published', location };
    } catch (err: unknown) {
      return { status: 'error', message: errorMessage(err) };
    }
  });

  /** Explicit fetch of a bundle from a user-typed S3 location. Unlike the
   *  wizard's silent beacon probe, every failure here is surfaced — the
   *  user asked for this exact object and wants to know why it failed. */
  ipcMain.handle('sharing:fetch-bundle-from-s3', async (_event, raw: unknown): Promise<PreviewConfigBundleResult> => {
    if (!isStringRecord(raw) || typeof raw['profile'] !== 'string' || typeof raw['location'] !== 'string') {
      return { status: 'error', message: 'Invalid fetch parameters' };
    }
    const profile = raw['profile'];
    const target = splitS3Location(raw['location']);
    if (target === null) {
      return { status: 'error', message: 'Invalid S3 location — expected s3://bucket/path/to/org-config.yaml' };
    }
    const location = `s3://${target.bucket}/${target.key}`;
    try {
      const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
      const client = new S3Client({
        region: 'eu-central-1',
        followRegionRedirects: true,
        ...(profile === 'default' ? {} : { profile }),
      });
      const response = await client.send(new GetObjectCommand({ Bucket: target.bucket, Key: target.key }));
      const content = await response.Body?.transformToString();
      if (content === undefined) {
        return { status: 'error', message: `Nothing found at ${location}` };
      }
      const parsed = parseConfigBundle(content);
      return { status: 'ok', content, summary: summarizeConfigBundle(parsed) };
    } catch (err: unknown) {
      if (isBeaconAbsence(err)) {
        return { status: 'error', message: `No bundle found at ${location} (missing object or access denied)` };
      }
      return { status: 'error', message: errorMessage(err) };
    }
  });

  ipcMain.handle('sharing:check-beacon', async (_event, raw: unknown): Promise<CheckConfigBeaconResult> => {
    if (!isStringRecord(raw) || typeof raw['profile'] !== 'string' || typeof raw['bucket'] !== 'string' || raw['bucket'].length === 0) {
      return { status: 'error', message: 'Invalid beacon parameters' };
    }
    const profile = raw['profile'];
    const bucket = raw['bucket'];
    const location = `s3://${bucket}/${CONFIG_BEACON_KEY}`;
    try {
      const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
      const client = new S3Client({
        region: 'eu-central-1',
        followRegionRedirects: true,
        ...(profile === 'default' ? {} : { profile }),
      });
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: CONFIG_BEACON_KEY }));
      const content = await response.Body?.transformToString();
      if (content === undefined) return { status: 'none' };
      const parsed = parseConfigBundle(content);
      return { status: 'found', location, content, summary: summarizeConfigBundle(parsed) };
    } catch (err: unknown) {
      if (isBeaconAbsence(err)) return { status: 'none' };
      if (err instanceof ConfigValidationError) {
        // Something IS published but unusable — worth telling the user.
        return { status: 'error', message: `Found ${location} but it is not a valid bundle: ${err.message}` };
      }
      // Network/credential hiccups must never block manual setup.
      logger.warn('Beacon check failed', { bucket, error: errorMessage(err) });
      return { status: 'none' };
    }
  });
}
