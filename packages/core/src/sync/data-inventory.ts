import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createS3Handle, parseS3Path } from './s3-client.js';
import type { S3Handle } from './s3-client.js';
import type { ManifestFileEntry } from './manifest.js';
import type { DataTier } from '../types/api.js';
import { getRawDirPrefix, parseEtagsJson } from './sync-utils.js';

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
  readonly local: LocalDataInfo;
}

function extractPeriod(key: string): string | undefined {
  const billingMatch = /BILLING_PERIOD=(\d{4}-\d{2})/.exec(key);
  if (billingMatch?.[1] !== undefined) return billingMatch[1];
  const dateMatch = /date=(\d{4}-\d{2})-\d{2}/.exec(key);
  return dateMatch?.[1];
}

async function getDirSize(dirPath: string): Promise<number> {
  let total = 0;
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        total += await getDirSize(fullPath);
      } else {
        const s = await stat(fullPath);
        total += s.size;
      }
    }
  } catch {
    // dir may not exist
  }
  return total;
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
  let total = 0;
  try {
    const entries = await readdir(rawDir);
    for (const entry of entries) {
      if (entry.startsWith(`${tierPrefix}-`)) {
        total += await getDirSize(join(rawDir, entry));
      }
    }
  } catch {
    // dir may not exist
  }
  return total;
}

const ETAG_FILES: Record<DataTier, string> = {
  'daily': 'sync-etags.json',
  'hourly': 'sync-etags-hourly.json',
  'cost-optimization': 'sync-etags-cost-optimization.json',
};

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
    if (period === undefined) continue;
    const existing = periodMap.get(period);
    if (existing !== undefined) {
      existing.push(file);
    } else {
      periodMap.set(period, [file]);
    }
  }

  const rawDir = join(dataDir, 'aws', 'raw');
  const tierPrefix = getRawDirPrefix(tier);
  const localPeriodList = await listRawPeriods(rawDir, tierPrefix);
  const diskBytes = await getRawTierSize(rawDir, tierPrefix);
  const localPeriods = new Set(localPeriodList);

  let savedEtags: Record<string, Record<string, string>> = {};
  try {
    const raw = await readFile(join(dataDir, ETAG_FILES[tier]), 'utf-8');
    savedEtags = parseEtagsJson(raw);
  } catch {
    // no saved etags yet
  }

  function getPeriodStatus(period: string, files: ManifestFileEntry[]): PeriodStatus {
    if (!localPeriods.has(period)) return 'missing';
    const saved = savedEtags[period];
    if (saved !== undefined) {
      for (const file of files) {
        const savedHash = saved[file.key];
        if (savedHash !== undefined && savedHash !== file.contentHash) return 'stale';
      }
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
  const newestPeriod = localPeriodList.length > 0 ? localPeriodList[localPeriodList.length - 1] ?? null : null;

  return {
    periods,
    totalRemoteSize: remoteFiles.reduce((s, f) => s + f.size, 0),
    totalLocalPeriods: localPeriods.size,
    totalRemotePeriods: periods.length,
    local: {
      periods: localPeriodList,
      diskBytes,
      oldestPeriod,
      newestPeriod,
    },
  };
}
