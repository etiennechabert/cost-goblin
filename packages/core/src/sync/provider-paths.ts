import { join } from 'node:path';
import type { ProviderName } from '../types/branded.js';
import { getEtagFileName } from './sync-utils.js';

/** On-disk layout of one provider inside a profile's data dir:
 *
 *    {dataDir}/{providerName}/
 *      raw/       provider-delivered Parquet ({tier}-{period}/ dirs)
 *      rollup/    pre-aggregated partitions + manifest
 *      meta/      sync sidecars: etag files, sync-timestamps.json
 *
 *  The provider name is the branded, validated `ProviderName` — it is both a
 *  directory segment and (via the raw dir) a fragment of single-quoted SQL
 *  glob paths, so only values produced by `parseProviderName` may reach
 *  these helpers. */
export function providerRoot(dataDir: string, provider: ProviderName): string {
  return join(dataDir, String(provider));
}

export function providerRawDir(dataDir: string, provider: ProviderName): string {
  return join(dataDir, String(provider), 'raw');
}

export function providerRollupDir(dataDir: string, provider: ProviderName): string {
  return join(dataDir, String(provider), 'rollup');
}

export function providerMetaDir(dataDir: string, provider: ProviderName): string {
  return join(dataDir, String(provider), 'meta');
}

/** Path of the per-tier etag sidecar for one provider. Pre-#516 these files
 *  lived at the dataDir root, shared across the (single) provider — the
 *  desktop boot migration moves them here. */
export function providerEtagPath(dataDir: string, provider: ProviderName, tier: string): string {
  return join(providerMetaDir(dataDir, provider), getEtagFileName(tier));
}
