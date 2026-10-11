import type { ListObjectsV2CommandOutput, S3Client } from '@aws-sdk/client-s3';
import { logger, parseS3Path, s3ClientConfig } from '@costgoblin/core';
import type { CostApi, ExportFileVersioning } from '@costgoblin/core';
import { newestDeliveryVersioning, newestPartitionFolder, partitionDeliveries } from './setup-file-versioning.js';
import type { ListedObject } from './setup-file-versioning.js';
import { classifyManifestColumns, parseManifestColumnNames, selectManifestKey } from './setup-manifest.js';
import type { DetectedReportType } from './setup-manifest.js';

// The setup wizard's S3 legs, kept out of handlers/setup.ts (and so free of
// electron) so they can be tested. Every client comes from s3ClientConfig: the
// wizard knows a bucket's name, never its region.

/** What `setup:browse-s3` answers: derived from the `CostApi` contract the
 *  renderer codes against, so the handler cannot drift from it. */
export type S3BrowseResult = Awaited<ReturnType<CostApi['browseS3']>>;

export async function testS3Connection(params: { profile: string; bucket: string }): Promise<{ ok: boolean; error?: string | undefined }> {
  try {
    const { S3Client, ListObjectsV2Command } = await import('@aws-sdk/client-s3');
    const parsed = parseS3Path(params.bucket);
    const client = new S3Client(await s3ClientConfig(params.profile));

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
}

export async function listS3Buckets(profile: string): Promise<{ buckets: { name: string; region: string }[]; error?: string | undefined }> {
  try {
    const { S3Client, ListBucketsCommand } = await import('@aws-sdk/client-s3');
    // ListBuckets is account-wide and answers from any regional endpoint, so
    // it starts where every other client does: the profile's region, which an
    // org that denies us-east-1 by SCP has set to one it allows.
    const client = new S3Client(await s3ClientConfig(profile));

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
}

/** A listing's pages are capped. An export holds one partition per month (or
 *  per day, for cost optimization), and a month a few thousand objects, which
 *  never comes near it; the cap bounds a wizard pointed at a huge, unrelated
 *  prefix. `complete` is false when the cap cut the listing short. */
const MAX_LISTING_PAGES = 10;

interface Listing {
  readonly objects: ListedObject[];
  readonly folderPrefixes: string[];
}

/** Adds one page's objects and subfolders to a listing. */
function collectPage(page: ListObjectsV2CommandOutput, into: Listing): void {
  for (const object of page.Contents ?? []) {
    if (object.Key !== undefined) into.objects.push({ key: object.Key, lastModified: object.LastModified });
  }
  for (const folder of page.CommonPrefixes ?? []) {
    if (folder.Prefix !== undefined) into.folderPrefixes.push(folder.Prefix);
  }
}

/** Every object under a prefix, or, `delimited`, one folder level: the
 *  objects directly in it and its subfolders. */
async function listPrefix(
  client: S3Client, bucket: string, prefix: string, delimited: boolean,
): Promise<Listing & { complete: boolean }> {
  const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
  const listing: Listing = { objects: [], folderPrefixes: [] };
  let continuationToken: string | undefined;
  for (let page = 0; page < MAX_LISTING_PAGES; page++) {
    const response = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ...(delimited ? { Delimiter: '/' } : {}),
      ContinuationToken: continuationToken,
    }));
    collectPage(response, listing);
    continuationToken = response.IsTruncated === true ? response.NextContinuationToken : undefined;
    if (continuationToken === undefined) return { ...listing, complete: true };
  }
  return { ...listing, complete: false };
}

/** The export's type and missing columns, read off the columns manifest in
 *  its metadata/ folder. */
async function detectReportType(
  client: S3Client, bucket: string, exportPrefix: string,
): Promise<{ detectedType: DetectedReportType; missingColumns: string[] }> {
  try {
    const { ListObjectsV2Command, GetObjectCommand } = await import('@aws-sdk/client-s3');
    const metaList = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: `${exportPrefix}metadata/`,
      MaxKeys: 10,
    }));
    const jsonKeys = (metaList.Contents ?? [])
      .map(c => c.Key)
      .filter((k): k is string => k !== undefined && k.endsWith('.json'));
    const manifestKey = selectManifestKey(jsonKeys);
    if (manifestKey === undefined) return { detectedType: 'unknown', missingColumns: [] };
    const manifestResponse = await client.send(new GetObjectCommand({ Bucket: bucket, Key: manifestKey }));
    const body = await manifestResponse.Body?.transformToString();
    if (body === undefined) return { detectedType: 'unknown', missingColumns: [] };
    return classifyManifestColumns(parseManifestColumnNames(body));
  } catch (err: unknown) {
    // A manifest read that fails (no s3:GetObject on metadata/, a transient
    // 5xx) degrades the type detection, never the folder listing.
    logger.info('setup:browse-s3 manifest detection failed', { error: err instanceof Error ? err.message : String(err) });
    return { detectedType: 'unknown', missingColumns: [] };
  }
}

/** The export's File versioning, read off its newest partition folder: the
 *  newest month shows the setting AWS delivers with today. A "Create new"
 *  export syncs nothing, so the wizard must catch it here. */
async function detectFileVersioning(client: S3Client, bucket: string, exportPrefix: string): Promise<ExportFileVersioning> {
  try {
    const dataLevel = await listPrefix(client, bucket, `${exportPrefix}data/`, true);
    const newest = newestPartitionFolder(dataLevel.folderPrefixes);
    if (newest === undefined) return 'unknown';
    switch (partitionDeliveries(await listPrefix(client, bucket, newest, true))) {
      case 'in-place': return 'overwrite';
      case 'per-refresh': return 'create-new';
      case 'none': return 'unknown';
      case 'both': {
        // Switched this month: whichever kind wrote last is in force. A
        // listing the cap cut short can't tell, so it keeps the Overwrite
        // verdict rather than refuse an export that may be fixed already.
        const all = await listPrefix(client, bucket, newest, false);
        return all.complete ? newestDeliveryVersioning(newest, all.objects) : 'overwrite';
      }
    }
  } catch (err: unknown) {
    // Like the manifest read: a probe that fails degrades this one verdict,
    // never the folder listing or the type detection.
    logger.info('setup:browse-s3 file versioning probe failed', { error: err instanceof Error ? err.message : String(err) });
    return 'unknown';
  }
}

export async function browseS3(params: { profile: string; bucket: string; prefix: string }): Promise<S3BrowseResult> {
  try {
    const { S3Client, ListObjectsV2Command } = await import('@aws-sdk/client-s3');
    const client = new S3Client(await s3ClientConfig(params.profile));

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

    if (!isBillingExport) {
      return { prefixes, isBillingExport, detectedType: 'unknown', missingColumns: [], fileVersioning: 'unknown' };
    }
    const { detectedType, missingColumns } = await detectReportType(client, params.bucket, params.prefix);
    // Only FOCUS exports have the setting to check: a CUR 2.0 export is refused
    // already, and AWS doesn't offer Overwrite for Cost Optimization Hub exports.
    const hasFileVersioning = detectedType !== 'cur-legacy' && detectedType !== 'cost-optimization';
    const fileVersioning = hasFileVersioning ? await detectFileVersioning(client, params.bucket, params.prefix) : 'unknown';
    return { prefixes, isBillingExport, detectedType, missingColumns, fileVersioning };
  } catch (err: unknown) {
    // Surface the failure instead of swallowing it into an empty result. An
    // expired SSO token or an s3:ListBucket AccessDenied while browsing used
    // to render exactly like a genuinely empty bucket ("No subfolders
    // found") — no message, no sign-in, no Retry. The wizard's browse step
    // now shows an error panel, matching the bucket-list step and the GCP
    // browse leg (the dead end #539/#542 removed everywhere else).
    const message = err instanceof Error ? err.message : String(err);
    logger.info('setup:browse-s3 failed', { error: message });
    return { prefixes: [], isBillingExport: false, detectedType: 'unknown', missingColumns: [], fileVersioning: 'unknown', error: message };
  }
}
