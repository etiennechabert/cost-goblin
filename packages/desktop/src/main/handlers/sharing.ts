import { dialog, ipcMain } from 'electron';
import {
  CONFIG_BEACON_KEY,
  ConfigValidationError,
  isStringRecord,
  logger,
  parseConfigBundle,
  serializeConfigBundle,
  splitS3Location,
  suggestedConfigBeaconLocation,
  summarizeConfigBundle,
} from '@costgoblin/core';
import type {
  ApplyConfigBundleResult,
  CheckConfigBeaconResult,
  ExportConfigBundleResult,
  PreviewConfigBundleResult,
  PublishConfigBundleResult,
} from '@costgoblin/core';
import type { AppContext } from './context.js';
import { applyBundleSectionsToDisk, buildCurrentBundle } from './bundle-io.js';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The bundle's credentials profile. The field was renamed profile →
 *  credentialsProfile with #516; accept the legacy key too so a stale renderer
 *  bundle can't brick imports. */
function bundleCredentialsProfile(raw: Record<string, unknown>): string {
  if (typeof raw['credentialsProfile'] === 'string') return raw['credentialsProfile'];
  return typeof raw['profile'] === 'string' ? raw['profile'] : '';
}

/** S3 errors that mean "nothing published here" rather than "broken".
 *  AccessDenied is included: without s3:ListBucket a missing key surfaces
 *  as 403, and a beacon the user cannot read is equivalent to no beacon. */
function isBeaconAbsence(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'NoSuchKey' || err.name === 'NotFound' || err.name === 'NoSuchBucket' || err.name === 'AccessDenied';
}

export function registerSharingHandlers(app: AppContext): void {
  const { ctx, getConfig, clearAllCaches } = app;

  ipcMain.handle('sharing:export-bundle', async (): Promise<ExportConfigBundleResult> => {
    try {
      const bundle = await buildCurrentBundle(app);
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

  ipcMain.handle('sharing:apply-bundle', async (_event, raw: unknown): Promise<ApplyConfigBundleResult> => {
    const credentialsProfile = isStringRecord(raw) ? bundleCredentialsProfile(raw) : '';
    if (!isStringRecord(raw) || typeof raw['content'] !== 'string' || credentialsProfile.length === 0) {
      return { status: 'error', message: 'Invalid import parameters' };
    }
    try {
      // Never trust the renderer's earlier preview — applyBundleSectionsToDisk
      // re-parses and re-validates in the process that writes the files.
      const { sectionIds, backupDir } = await applyBundleSectionsToDisk(ctx, raw['content'], credentialsProfile);
      await clearAllCaches();
      logger.info('Applied configuration bundle', { sections: sectionIds.join(','), backupDir: backupDir ?? 'none' });
      return { status: 'applied', sections: sectionIds, backupDir };
    } catch (err: unknown) {
      return { status: 'error', message: errorMessage(err) };
    }
  });

  ipcMain.handle('sharing:publish-bundle', async (_event, raw: unknown): Promise<PublishConfigBundleResult> => {
    try {
      const config = await getConfig();
      // The beacon is an S3 object written with the AWS SDK, so publishing
      // needs an AWS provider specifically — a GCP-only workspace has no
      // bucket to publish to and no profile to write with. Prefer the first
      // AWS provider rather than `providers[0]`, which may now be a GCP one.
      const provider = config.providers.find(p => p.type === 'aws');
      if (provider === undefined) {
        return {
          status: 'error',
          message: config.providers.length === 0
            ? 'No provider configured — complete setup before publishing'
            : 'Publishing a config bundle to a shared bucket needs an AWS provider — the beacon is written to S3',
        };
      }
      // Caller may override the destination (e.g. write-locked billing bucket →
      // sibling config bucket). Default is the discoverable beacon key at
      // the daily bucket's root.
      const requested = isStringRecord(raw) && typeof raw['location'] === 'string' && raw['location'].trim().length > 0
        ? raw['location']
        : suggestedConfigBeaconLocation(String(provider.sync.daily.bucket));
      const target = splitS3Location(requested);
      if (target === null) {
        return { status: 'error', message: 'Invalid S3 location — expected s3://bucket/path/to/org-config.yaml' };
      }
      const body = serializeConfigBundle(await buildCurrentBundle(app));

      const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
      // Publishing needs s3:PutObject, which day-to-day read-only profiles
      // often lack — callers can hand in an elevated profile for just this
      // action. Default stays the configured sync profile.
      const profile = isStringRecord(raw) && typeof raw['profile'] === 'string' && raw['profile'].trim().length > 0
        ? raw['profile']
        : provider.credentialsProfile;
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
