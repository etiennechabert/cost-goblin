import type { DataTier } from '../types/api.js';

/** The earliest billing month (YYYY-MM) still inside the retention window.
 *  Periods strictly older than this are eligible for pruning; periods at or
 *  after it are kept. This mirrors the auto-sync download cutoff exactly
 *  (download keeps `period >= cutoff`, prune deletes `period < cutoff`), so a
 *  boundary month is never downloaded-then-immediately-pruned. */
export function retentionCutoffPeriod(retentionDays: number, now: number = Date.now()): string {
  const d = new Date(now - retentionDays * 24 * 60 * 60 * 1000);
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Local billing periods (YYYY-MM) that have fallen outside the retention
 *  window and can be safely deleted, sorted oldest-first.
 *
 *  Returns an empty list when `retentionDays` is not a positive, finite number
 *  — a deliberate guard so a misconfigured `retentionDays: 0` (or a negative /
 *  NaN value) can never be interpreted as "everything is expired" and wipe the
 *  whole local cache. */
export function periodsOutsideRetention(
  localPeriods: readonly string[],
  retentionDays: number,
  now: number = Date.now(),
): string[] {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return [];
  const cutoff = retentionCutoffPeriod(retentionDays, now);
  return localPeriods
    .filter(period => period < cutoff)
    .sort((a, b) => a.localeCompare(b));
}

export interface TierRetention {
  readonly tier: DataTier;
  readonly retentionDays: number;
}

/** Minimal structural view of a provider's `sync` config — kept local so this
 *  pure module doesn't depend on the full config type. */
interface SyncRetentionConfig {
  readonly daily: { readonly retentionDays?: number | undefined };
  readonly hourly?: { readonly retentionDays?: number | undefined } | undefined;
  readonly costOptimization?: { readonly retentionDays?: number | undefined } | undefined;
}

/** Default retention windows, matching the values used across the app
 *  (setup wizard, auto-sync, and the Data Management UI). */
/** Per-tier retention default (days), applied whenever a tier config omits
 *  `retentionDays`. Single source of truth for both the prune paths here and
 *  the setup wizard's config writer, so the two can't disagree. */
export const DEFAULT_RETENTION_DAYS = { daily: 365, hourly: 30, costOptimization: 90 } as const;

/** Retention window for every configured tier. Daily is always present; hourly
 *  and cost-optimization only appear when that tier is configured. Used by both
 *  the manual prune action and the auto-prune scheduler pass so they stay in
 *  lockstep. */
export function configuredTierRetentions(sync: SyncRetentionConfig): TierRetention[] {
  const tiers: TierRetention[] = [
    { tier: 'daily', retentionDays: sync.daily.retentionDays ?? DEFAULT_RETENTION_DAYS.daily },
  ];
  if (sync.hourly !== undefined) {
    tiers.push({ tier: 'hourly', retentionDays: sync.hourly.retentionDays ?? DEFAULT_RETENTION_DAYS.hourly });
  }
  if (sync.costOptimization !== undefined) {
    tiers.push({ tier: 'cost-optimization', retentionDays: sync.costOptimization.retentionDays ?? DEFAULT_RETENTION_DAYS.costOptimization });
  }
  return tiers;
}
