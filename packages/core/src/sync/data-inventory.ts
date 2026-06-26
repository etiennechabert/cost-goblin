import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createS3Handle, parseS3Path } from './s3-client.js';
import type { S3Handle } from './s3-client.js';
import type { ManifestFileEntry } from './manifest.js';
import type { DataTier } from '../types/api.js';
import { extractPeriod, getEtagFileName, getRawDirPrefix, parseEtagsJson } from './sync-utils.js';
import { readTierLastSync } from './sync-timestamps.js';

export type PeriodStatus = 'missing' | 'repartitioned' | 'stale';

export interface BillingPeriod {
  readonly period: string;
  readonly files: readonly ManifestFileEntry[];
  readonly totalSize: number;
  readonly localStatus: PeriodStatus;
}

export interface LocalDataInfo {
  readonly periods: readonly string[];
  readonly diskBytes: number;
  readonly oldestPeriod: string | null;
  readonly newestPeriod: string | null;
}

export interface DataInventory {
  readonly periods: readonly BillingPeriod[];
  readonly totalRemoteSize: number;
  readonly totalLocalPeriods: number;
  readonly totalRemotePeriods: number;
  /** ISO 8601 of the last successful sync for this tier, or null if never
   *  synced (or imported-only). Durable across restarts. */
  readonly lastSync: string | null;
  readonly local: LocalDataInfo;
}

async function getDirSize(dirPath: string): Promise<number> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const sizes = await Promise.all(
      entries.map(async (entry) => {
        const fullPath = join(dirPath, entry.name);
        if (entry.isDirectory()) return getDirSize(fullPath);
        const s = await stat(fullPath);
        return s.size;
      }),
    );
    return sizes.reduce((sum, size) => sum + size, 0);
  } catch {
    return 0;
  }
}

async function listRawPeriods(rawDir: string, tierPrefix: string): Promise<string[]> {
  try {
    const entries = await readdir(rawDir);
    const raw = entries
      .filter(e => e.startsWith(`${tierPrefix}-`))
      .map(e => e.slice(tierPrefix.length + 1).slice(0, 7));
    return [...new Set(raw)].sort((a, b) => a.localeCompare(b));
  } catch {
    // raw dir may not exist yet
    return [];
  }
}

async function getRawTierSize(rawDir: string, tierPrefix: string): Promise<number> {
  try {
    const entries = await readdir(rawDir);
    const tierDirs = entries.filter(e => e.startsWith(`${tierPrefix}-`));
    const sizes = await Promise.all(
      tierDirs.map(entry => getDirSize(join(rawDir, entry))),
    );
    return sizes.reduce((sum, size) => sum + size, 0);
  } catch {
    return 0;
  }
}

/** On-disk byte size per billing period (YYYY-MM), summing every raw tier dir
 *  that maps to that period. Powers per-month sizes in the local-only inventory
 *  — without it those rows show "0B" even when the data is on disk. */
async function getRawPeriodSizes(rawDir: string, tierPrefix: string): Promise<Map<string, number>> {
  try {
    const entries = await readdir(rawDir);
    const tierDirs = entries.filter(e => e.startsWith(`${tierPrefix}-`));
    const sized = await Promise.all(
      tierDirs.map(async (entry): Promise<readonly [string, number]> => {
        const period = entry.slice(tierPrefix.length + 1).slice(0, 7);
        const size = await getDirSize(join(rawDir, entry));
        return [period, size];
      }),
    );
    const sizes = new Map<string, number>();
    for (const [period, size] of sized) {
      sizes.set(period, (sizes.get(period) ?? 0) + size);
    }
    return sizes;
  } catch {
    return new Map();
  }
}

/** Whether this tier has ever been synced from S3 (its etag file exists). An
 *  imported snapshot has raw Parquet on disk but no etag file, so this cleanly
 *  separates "AWS configured and synced before" from "imported, no AWS" — the
 *  former should surface credential errors, the latter falls back silently. */
export async function hasSyncedTier(dataDir: string, tier: DataTier = 'daily'): Promise<boolean> {
  try {
    await stat(join(dataDir, getEtagFileName(tier)));
    return true;
  } catch {
    return false;
  }
}

/** Build an inventory purely from what's on disk — no S3 listing. Used by a
 *  consumer that pulled a shared snapshot and has no AWS credentials at all:
 *  every local period is reported as present so the Sync view renders, and
 *  there is no remote to compare against (auto-sync treats it as "imported").  */
export async function getLocalDataInventory(dataDir: string, tier: DataTier = 'daily'): Promise<DataInventory> {
  const rawDir = join(dataDir, 'aws', 'raw');
  const tierPrefix = getRawDirPrefix(tier);
  const periodSizes = await getRawPeriodSizes(rawDir, tierPrefix);
  const localPeriodList = [...periodSizes.keys()].sort((a, b) => a.localeCompare(b));
  const diskBytes = [...periodSizes.values()].reduce((sum, size) => sum + size, 0);
  const lastSync = await readTierLastSync(dataDir, tier);

  const periods: BillingPeriod[] = [...localPeriodList]
    .sort((a, b) => b.localeCompare(a))
    .map(period => ({ period, files: [], totalSize: periodSizes.get(period) ?? 0, localStatus: 'repartitioned' }));

  return {
    periods,
    totalRemoteSize: 0,
    totalLocalPeriods: localPeriodList.length,
    totalRemotePeriods: 0,
    lastSync,
    local: {
      periods: localPeriodList,
      diskBytes,
      oldestPeriod: localPeriodList[0] ?? null,
      newestPeriod: localPeriodList.at(-1) ?? null,
    },
  };
}

export async function getDataInventory(
  bucketPath: string,
  profile: string,
  dataDir: string,
  tier: DataTier = 'daily',
  s3Override?: S3Handle,
): Promise<DataInventory> {
  const s3Path = parseS3Path(bucketPath);
  const s3 = s3Override ?? await createS3Handle(profile);
  const remoteFiles = await s3.listFiles(s3Path.bucket, s3Path.prefix);

  const periodMap = new Map<string, ManifestFileEntry[]>();
  for (const file of remoteFiles) {
    const period = extractPeriod(file.key);
    if (period === 'unknown') continue;
    const existing = periodMap.get(period);
    if (existing === undefined) {
      periodMap.set(period, [file]);
    } else {
      existing.push(file);
    }
  }

  const rawDir = join(dataDir, 'aws', 'raw');
  const tierPrefix = getRawDirPrefix(tier);
  const localPeriodList = await listRawPeriods(rawDir, tierPrefix);
  const diskBytes = await getRawTierSize(rawDir, tierPrefix);
  const lastSync = await readTierLastSync(dataDir, tier);
  const localPeriods = new Set(localPeriodList);

  let savedEtags: Record<string, Record<string, string>> = {};
  try {
    const raw = await readFile(join(dataDir, getEtagFileName(tier)), 'utf-8');
    savedEtags = parseEtagsJson(raw);
  } catch {
    // no saved etags yet
  }

  function getPeriodStatus(period: string, files: ManifestFileEntry[]): PeriodStatus {
    if (!localPeriods.has(period)) return 'missing';
    const saved = savedEtags[period] ?? {};
    // Strict: every remote file must have a saved etag that matches. A missing
    // entry (whole period absent or specific file absent) means we have not
    // verified that file locally, so the period is stale and must re-sync.
    for (const file of files) {
      if (saved[file.key] !== file.contentHash) return 'stale';
    }
    return 'repartitioned';
  }

  const periods: BillingPeriod[] = [...periodMap.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([period, files]) => ({
      period,
      files,
      totalSize: files.reduce((s, f) => s + f.size, 0),
      localStatus: getPeriodStatus(period, files),
    }));

  const oldestPeriod = localPeriodList.length > 0 ? localPeriodList[0] ?? null : null;
  const newestPeriod = localPeriodList.length > 0 ? localPeriodList.at(-1) ?? null : null;

  return {
    periods,
    totalRemoteSize: remoteFiles.reduce((s, f) => s + f.size, 0),
    totalLocalPeriods: localPeriods.size,
    totalRemotePeriods: periods.length,
    lastSync,
    local: {
      periods: localPeriodList,
      diskBytes,
      oldestPeriod,
      newestPeriod,
    },
  };
}
