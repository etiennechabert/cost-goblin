/** Sync tiers and their per-tier on-disk names. A leaf module: both
 *  `provider-paths` and `sync-utils` build on it, so it must import neither. */
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
