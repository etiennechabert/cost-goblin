import { isStringRecord } from '../utils/json.js';
import { logger } from '../logger/logger.js';
import type { ManifestFileEntry } from './manifest.js';

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
 * Returns the directory-name prefix used under aws/raw/ for a given tier.
 * Files for a period live under aws/raw/{prefix}-{period}/ — e.g.
 * aws/raw/daily-2026-04/, aws/raw/cost-opt-2026-04-08/.
 */
export function getRawDirPrefix(tier: string): string {
  if (tier === 'hourly' || tier === 'cost-optimization' || tier === 'daily') {
    return TIER_RAW_PREFIXES[tier];
  }
  return TIER_RAW_PREFIXES['daily'];
}

/**
 * Lists YYYY-MM period directories on disk for a given tier. Used by query
 * handlers to intersect a date range's required months with what's actually
 * been synced — DuckDB's read_parquet errors on glob patterns that match
 * zero files, so missing months must be filtered out before query time.
 */
export async function listLocalMonths(dataDir: string, tier: string): Promise<string[]> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const prefix = getRawDirPrefix(tier);
  const rawDir = path.join(dataDir, 'aws', 'raw');
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

export function extractPeriod(key: string): string {
  const billingMatch = /BILLING_PERIOD=(\d{4}-\d{2})/.exec(key);
  if (billingMatch?.[1] !== undefined) return billingMatch[1];
  const dateMatch = /date=(\d{4}-\d{2})-\d{2}/.exec(key);
  return dateMatch?.[1] ?? 'unknown';
}

export function extractPeriodPrefix(key: string): string {
  const billingMatch = /^(.*BILLING_PERIOD=\d{4}-\d{2}\/)/.exec(key);
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
    if (existing !== undefined) {
      existing.push(file);
    } else {
      groups.set(period, [file]);
    }
  }
  return groups;
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
