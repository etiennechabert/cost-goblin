import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createS3Handle, parseS3Path } from './s3-client.js';
import type { ManifestFileEntry } from './manifest.js';
import type { DataTier } from '../types/api.js';

export type PeriodStatus = 'missing' | 'repartitioned' | 'stale';

export interface BillingPeriod {
  readonly period: string;
  readonly files: readonly ManifestFileEntry[];
  readonly totalSize: number;
  readonly localStatus: PeriodStatus;
}

export interface LocalDataInfo {
  readonly dates: readonly string[];
  readonly diskBytes: number;
  readonly oldestDate: string | null;
  readonly newestDate: string | null;
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

async function listPartitionDates(baseDir: string, prefix: string): Promise<string[]> {
  try {
    const entries = await readdir(baseDir);
    return entries
      .filter(e => e.startsWith(`${prefix}=`))
      .map(e => e.replace(`${prefix}=`, ''))
      .sort();
  } catch {
    return [];
  }
}

const ETAG_FILES: Record<DataTier, string> = {
  'daily': 'sync-etags.json',
  'hourly': 'sync-etags-hourly.json',
  'cost-optimization': 'sync-etags-cost-optimization.json',
};

function tierDir(dataDir: string, tier: DataTier): string {
  return join(dataDir, 'aws', tier);
}

export async function getDataInventory(
  bucketPath: string,
  profile: string,
  dataDir: string,
  tier: DataTier = 'daily',
): Promise<DataInventory> {
  const s3Path = parseS3Path(bucketPath);
  const s3 = await createS3Handle(profile);
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

  const dir = tierDir(dataDir, tier);
  const dates = await listPartitionDates(dir, 'usage_date');
  const diskBytes = await getDirSize(dir);
  const localPeriods = new Set(dates.map(d => d.slice(0, 7)));

  let savedEtags: Record<string, Record<string, string>> = {};
  try {
    const raw = await readFile(join(dataDir, ETAG_FILES[tier]), 'utf-8');
    savedEtags = JSON.parse(raw) as Record<string, Record<string, string>>;
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

  const oldestDate = dates.length > 0 ? dates[0] ?? null : null;
  const newestDate = dates.length > 0 ? dates[dates.length - 1] ?? null : null;

  return {
    periods,
    totalRemoteSize: remoteFiles.reduce((s, f) => s + f.size, 0),
    totalLocalPeriods: localPeriods.size,
    totalRemotePeriods: periods.length,
    local: {
      dates,
      diskBytes,
      oldestDate,
      newestDate,
    },
  };
}
