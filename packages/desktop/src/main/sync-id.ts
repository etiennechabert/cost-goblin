/**
 * Composite syncId convention (#516 phase 3).
 *
 * A syncId addresses one (provider, tier) sync: `'{providerName}:{tier}'`
 * where tier is daily | hourly | cost-optimization. Legacy tier-only ids
 * ('default' | 'daily' | 'hourly' | 'cost-optimization') remain accepted and
 * resolve against the FIRST configured provider.
 *
 * `state.syncStatuses` and the sync-worker map are ALWAYS keyed by the
 * normalized `${provider}:${tier}` — every read and write goes through
 * `resolveSyncId` / `syncStatusKey` so legacy and composite callers observe
 * the same entry.
 *
 * Pure (no Electron / no I/O) so it can be unit-tested directly.
 */

export type SyncTier = 'daily' | 'hourly' | 'cost-optimization';

export interface ParsedSyncId {
  /** Provider segment, or null for a legacy tier-only id (which resolves
   *  against the first configured provider). */
  readonly providerName: string | null;
  readonly tier: SyncTier;
}

/** Legacy tier mapping: 'hourly' / 'cost-optimization' match exactly;
 *  anything else (incl. 'default' and 'daily') is the daily tier. */
function tierFromSegment(segment: string): SyncTier {
  if (segment === 'hourly') return 'hourly';
  if (segment === 'cost-optimization') return 'cost-optimization';
  return 'daily';
}

/** Split a syncId on its LAST ':' — the tier never contains one, but a
 *  provider name might. A syncId without ':' is a legacy tier-only id. */
export function parseSyncId(syncId: string): ParsedSyncId {
  const sep = syncId.lastIndexOf(':');
  if (sep === -1) return { providerName: null, tier: tierFromSegment(syncId) };
  return { providerName: syncId.slice(0, sep), tier: tierFromSegment(syncId.slice(sep + 1)) };
}

/** The one true key for `state.syncStatuses` / the sync-worker map. */
export function syncStatusKey(providerName: string, tier: SyncTier): string {
  return `${providerName}:${tier}`;
}

/** Resolve an optional provider-name argument against the configured
 *  providers: undefined → first provider; otherwise exact name lookup.
 *  Generic over the provider shape so pure tests can inject fakes. */
export function resolveProvider<P extends { readonly name: string }>(
  providers: readonly P[],
  providerName?: string,
): P {
  if (providerName === undefined) {
    const first = providers[0];
    if (first === undefined) throw new Error('No provider configured');
    return first;
  }
  const provider = providers.find(p => p.name === providerName);
  if (provider === undefined) throw new Error(`Unknown provider "${providerName}"`);
  return provider;
}

export interface ResolvedSyncId<P> {
  readonly provider: P;
  readonly tier: SyncTier;
  /** Normalized `${provider}:${tier}` state key. */
  readonly key: string;
}

/** Parse + normalize a syncId against the configured providers. Legacy ids
 *  resolve to the first provider; an unknown provider segment throws. */
export function resolveSyncId<P extends { readonly name: string }>(
  syncId: string,
  providers: readonly P[],
): ResolvedSyncId<P> {
  const { providerName, tier } = parseSyncId(syncId);
  const provider = resolveProvider(providers, providerName ?? undefined);
  return { provider, tier, key: syncStatusKey(provider.name, tier) };
}
