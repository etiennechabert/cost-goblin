import { logger, parseS3Path, s3ClientConfig } from '@costgoblin/core';
import { classifyManifestColumns, parseManifestColumnNames, selectManifestKey } from './setup-manifest.js';
import type { DetectedReportType } from './setup-manifest.js';

// The setup wizard's S3 legs, kept out of handlers/setup.ts (and so free of
// electron) so they can be tested. Every client comes from s3ClientConfig: the
// wizard knows a bucket's name, never its region.

export interface S3BrowseResult {
  prefixes: string[];
  isBillingExport: boolean;
  detectedType: DetectedReportType;
  missingColumns: string[];
  error?: string | undefined;
}

export async function testS3Connection(params: { profile: string; bucket: string }): Promise<{ ok: boolean; error?: string | undefined }> {
  try {
    const { S3Client, ListObjectsV2Command } = await import('@aws-sdk/client-s3');
    const parsed = parseS3Path(params.bucket);
    const client = new S3Client(s3ClientConfig(params.profile));

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
    const client = new S3Client(s3ClientConfig(profile, 'us-east-1'));

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

export async function browseS3(params: { profile: string; bucket: string; prefix: string }): Promise<S3BrowseResult> {
  try {
    const { S3Client, ListObjectsV2Command, GetObjectCommand } = await import('@aws-sdk/client-s3');
    const client = new S3Client(s3ClientConfig(params.profile));

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
      } catch (err: unknown) {
        // A manifest read that fails (no s3:GetObject on metadata/, a transient
        // 5xx) degrades the type detection, never the folder listing above.
        logger.info('setup:browse-s3 manifest detection failed', { error: err instanceof Error ? err.message : String(err) });
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
}
