import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createS3Handle, parseS3Path } from './s3-client.js';
import type { ManifestFileEntry } from './manifest.js';

export type PeriodStatus = 'missing' | 'repartitioned' | 'stale';

export interface BillingPeriod {
  readonly period: string;
  readonly files: readonly ManifestFileEntry[];
  readonly totalSize: number;
  readonly localStatus: PeriodStatus;
}

export interface LocalDataInfo {
  readonly dailyDates: readonly string[];
  readonly dailyDiskBytes: number;
  readonly hourlyDates: readonly string[];
  readonly hourlyDiskBytes: number;
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
  const match = /BILLING_PERIOD=(\d{4}-\d{2})/.exec(key);
  return match?.[1];
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

export async function getDataInventory(
  bucketPath: string,
  profile: string,
  dataDir: string,
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

  const dailyDir = join(dataDir, 'aws', 'daily');
  const hourlyDir = join(dataDir, 'aws', 'hourly');

  const dailyDates = await listPartitionDates(dailyDir, 'usage_date');
  const hourlyDates = await listPartitionDates(hourlyDir, 'usage_date');

  const dailyDiskBytes = await getDirSize(dailyDir);
  const hourlyDiskBytes = await getDirSize(hourlyDir);

  const localPeriods = new Set(dailyDates.map(d => d.slice(0, 7)));

  // Load saved ETags to detect stale periods
  let savedEtags: Record<string, Record<string, string>> = {};
  try {
    const raw = await readFile(join(dataDir, 'sync-etags.json'), 'utf-8');
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

  const allDates = [...dailyDates, ...hourlyDates].sort();
  const oldestDate = allDates.length > 0 ? allDates[0] ?? null : null;
  const newestDate = allDates.length > 0 ? allDates[allDates.length - 1] ?? null : null;

  return {
    periods,
    totalRemoteSize: remoteFiles.reduce((s, f) => s + f.size, 0),
    totalLocalPeriods: localPeriods.size,
    totalRemotePeriods: periods.length,
    local: {
      dailyDates,
      dailyDiskBytes,
      hourlyDates,
      hourlyDiskBytes,
      oldestDate,
      newestDate,
    },
  };
}
