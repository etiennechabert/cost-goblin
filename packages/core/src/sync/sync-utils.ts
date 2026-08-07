import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isStringRecord } from '../utils/json.js';
import { logger } from '../logger/logger.js';
import type { ProviderName } from '../types/branded.js';
import type { ProviderConfig } from '../types/config.js';
import type { ManifestFileEntry } from './manifest.js';
import { providerMetaDir } from './provider-paths.js';

export type ExpectedDataType = 'daily' | 'hourly' | 'cost-optimization';

const TIER_ETAG_FILES: Record<ExpectedDataType, string> = {
  'daily': 'sync-etags.json',
  'hourly': 'sync-etags-hourly.json',
  'cost-optimization': 'sync-etags-cost-optimization.json',
};

const TIER_RAW_PREFIXES: Record<ExpectedDataType, string> = {
  'daily': 'daily',
  'hourly': 'hourly',
  'cost-optimization': 'cost-opt',
};

export function getEtagFileName(tier: string): string {
  if (tier === 'hourly' || tier === 'cost-optimization' || tier === 'daily') {
    return TIER_ETAG_FILES[tier];
  }
  return TIER_ETAG_FILES['daily'];
}

/**
 * Returns the directory-name prefix used under {providerName}/raw/ for a
 * given tier. Files for a period live under {providerName}/raw/{prefix}-{period}/
 * — e.g. aws-main/raw/daily-2026-04/, aws-main/raw/cost-opt-2026-04-08/.
 */
export function getRawDirPrefix(tier: string): string {
  if (tier === 'hourly' || tier === 'cost-optimization' || tier === 'daily') {
    return TIER_RAW_PREFIXES[tier];
  }
  return TIER_RAW_PREFIXES['daily'];
}

/**
 * Bucket location for one provider's tier. Shared by manual and background
 * sync so both resolve buckets identically.
 *
 * The `gcp` arm is checked first and deliberately does NOT take the AWS
 * fallback below (`hourly ?? daily`). An unconfigured GCP hourly tier means
 * the exporter is not publishing that grain at all, so falling back would sync
 * rolled-up daily rows into `raw/hourly-*` — the intraday views would then
 * render one flat 24-hour block per day and look like a data bug rather than a
 * missing configuration.
 */
export function resolveBucketPath(provider: ProviderConfig, tier: ExpectedDataType): string {
  if (provider.type === 'gcp') {
    if (tier === 'cost-optimization') {
      throw new Error(`Provider "${provider.name}" is a GCP billing export, which has no Cost Optimization Hub analogue`);
    }
    if (tier === 'hourly') {
      const hourlyBucket = provider.sync.hourly?.bucket;
      if (hourlyBucket === undefined) {
        throw new Error(`Provider "${provider.name}" has no sync.hourly bucket — set TIERS=daily,hourly on the exporter and add sync.hourly to the provider`);
      }
      return hourlyBucket;
    }
    return provider.sync.daily.bucket;
  }
  if (tier === 'hourly') {
    return provider.sync.hourly?.bucket ?? provider.sync.daily.bucket;
  }
  if (tier === 'cost-optimization') {
    const costOptBucket = provider.sync.costOptimization?.bucket;
    if (costOptBucket === undefined) throw new Error('Cost optimization not configured');
    return costOptBucket;
  }
  return provider.sync.daily.bucket;
}

/**
 * Lists YYYY-MM period directories on disk for one provider's tier. Used by
 * query handlers to intersect a date range's required months with what's
 * actually been synced — DuckDB's read_parquet errors on glob patterns that
 * match zero files, so missing months must be filtered out before query time.
 */
export async function listLocalMonths(dataDir: string, provider: ProviderName, tier: string): Promise<string[]> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const prefix = getRawDirPrefix(tier);
  const rawDir = path.join(dataDir, String(provider), 'raw');
  try {
    const entries = await fs.readdir(rawDir);
    const months = new Set<string>();
    for (const entry of entries) {
      if (!entry.startsWith(`${prefix}-`)) continue;
      const period = entry.slice(prefix.length + 1).slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(period)) continue;
      // Must contain at least one .parquet — otherwise DuckDB errors on the
      // glob. Empty dirs can linger after interrupted downloads or partial
      // deletes; silently skip them.
      try {
        const files = await fs.readdir(path.join(rawDir, entry));
        if (files.some(f => f.endsWith('.parquet'))) months.add(period);
      } catch { /* dir vanished mid-scan */ }
    }
    return [...months].sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

// AWS Data Exports partition the delivery by billing period. FOCUS 1.2
// exports use lowercase `billing_period=YYYY-MM`. The match is deliberately
// case-SENSITIVE: CUR 2.0 used uppercase `BILLING_PERIOD=`, and a bucket
// still holding a leftover CUR subtree next to the FOCUS export must not
// have both grouped into one period (that would sync mixed-schema files
// into the same local dir). CUR-era keys are simply invisible.
export function extractPeriod(key: string): string {
  const billingMatch = /billing_period=(\d{4}-\d{2})/.exec(key);
  if (billingMatch?.[1] !== undefined) return billingMatch[1];
  const dateMatch = /date=(\d{4}-\d{2})-\d{2}/.exec(key);
  return dateMatch?.[1] ?? 'unknown';
}

export function extractPeriodPrefix(key: string): string {
  const billingMatch = /^(.*billing_period=\d{4}-\d{2}\/)/.exec(key);
  if (billingMatch?.[1] !== undefined) return billingMatch[1];
  const dateMatch = /^(.*date=\d{4}-\d{2}-\d{2}\/)/.exec(key);
  return dateMatch?.[1] ?? '';
}

export function extractDate(key: string): string | undefined {
  const match = /date=(\d{4}-\d{2}-\d{2})/.exec(key);
  return match?.[1];
}

export function groupByPeriod(files: readonly ManifestFileEntry[]): Map<string, ManifestFileEntry[]> {
  const groups = new Map<string, ManifestFileEntry[]>();
  for (const file of files) {
    const period = extractPeriod(file.key);
    const existing = groups.get(period);
    if (existing === undefined) {
      groups.set(period, [file]);
    } else {
      existing.push(file);
    }
  }
  return groups;
}

const AWS_UNIT_BYTES: Record<string, number> = {
  B: 1,
  KiB: 1024,
  MiB: 1024 * 1024,
  GiB: 1024 * 1024 * 1024,
  TiB: 1024 * 1024 * 1024 * 1024,
};

/**
 * Parses an `aws s3 sync` "Completed" progress line into byte counts. Format
 * varies — typical shape: `Completed 203.6 MiB/404.2 MiB (3.0 MiB/s) with 7
 * file(s) remaining`. Returns null when the line is in a form without
 * total-known byte counts (e.g. `Completed N file(s) ...`), so callers can
 * leave the previous numbers in place.
 */
export function parseAwsCompletedBytes(line: string): { bytesDone: number; bytesTotal: number } | null {
  const match = /^Completed\s+([\d.]+)\s+(B|KiB|MiB|GiB|TiB)\/([\d.]+)\s+(B|KiB|MiB|GiB|TiB)\b/.exec(line);
  if (match === null) return null;
  const [, doneNum, doneUnit, totalNum, totalUnit] = match;
  if (doneNum === undefined || doneUnit === undefined || totalNum === undefined || totalUnit === undefined) return null;
  const doneFactor = AWS_UNIT_BYTES[doneUnit];
  const totalFactor = AWS_UNIT_BYTES[totalUnit];
  if (doneFactor === undefined || totalFactor === undefined) return null;
  const bytesDone = Number.parseFloat(doneNum) * doneFactor;
  const bytesTotal = Number.parseFloat(totalNum) * totalFactor;
  if (!Number.isFinite(bytesDone) || !Number.isFinite(bytesTotal) || bytesTotal <= 0) return null;
  return { bytesDone, bytesTotal };
}

/**
 * Parses a sync-etags JSON file. Returns an empty record on any malformed input.
 * Shape: `{ [period: string]: { [fileKey: string]: contentHash } }`
 */
export function parseEtagsJson(raw: string): Record<string, Record<string, string>> {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {
    logger.warn('Failed to parse sync-etags JSON — will re-download all files', { rawLength: raw.length });
    return {};
  }
  if (!isStringRecord(parsed)) {
    logger.warn('sync-etags JSON is not a valid object — will re-download all files');
    return {};
  }

  const result: Record<string, Record<string, string>> = {};
  for (const [period, periodEtags] of Object.entries(parsed)) {
    if (!isStringRecord(periodEtags)) continue;
    const stringEtags: Record<string, string> = {};
    for (const [key, hash] of Object.entries(periodEtags)) {
      if (typeof hash === 'string') stringEtags[key] = hash;
    }
    result[period] = stringEtags;
  }
  return result;
}

/**
 * Record the content hashes of one period's remote files, so the next
 * inventory can tell an up-to-date period from a stale one. Merges into the
 * existing sidecar — other periods' entries are preserved.
 *
 * Shared by both provider sync paths (#517): the sidecar format and the
 * "written only once the period is actually installed" contract are
 * transport-neutral, and a second copy would be a second thing to keep in
 * step with `getPeriodStatus`.
 */
export async function saveEtags(
  dataDir: string,
  providerName: ProviderName,
  tier: string,
  period: string,
  periodFiles: readonly ManifestFileEntry[],
): Promise<void> {
  const metaDir = providerMetaDir(dataDir, providerName);
  await mkdir(metaDir, { recursive: true });
  const etagPath = join(metaDir, getEtagFileName(tier));
  let savedEtags: Record<string, Record<string, string>> = {};
  try {
    const raw = await readFile(etagPath, 'utf-8');
    savedEtags = parseEtagsJson(raw);
  } catch {
    // first time
  }
  const periodEtags: Record<string, string> = {};
  for (const f of periodFiles) {
    periodEtags[f.key] = f.contentHash;
  }
  savedEtags[period] = periodEtags;
  await writeFile(etagPath, JSON.stringify(savedEtags, null, 2));
}
