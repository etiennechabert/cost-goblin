/** Sync tiers and their per-tier on-disk names. A leaf module: both
 *  `provider-paths` and `sync-utils` build on it, so it must import neither. */
export type ExpectedDataType = 'daily' | 'hourly' | 'cost-optimization';

const TIER_ETAG_FILES: Record<ExpectedDataType, string> = {
  'daily': 'sync-etags.json',
  'hourly': 'sync-etags-hourly.json',
  'cost-optimization': 'sync-etags-cost-optimization.json',
};

export function getEtagFileName(tier: string): string {
  if (tier === 'hourly' || tier === 'cost-optimization' || tier === 'daily') {
    return TIER_ETAG_FILES[tier];
  }
  return TIER_ETAG_FILES['daily'];
}
