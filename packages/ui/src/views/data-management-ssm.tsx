import { useState } from 'react';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';

type SyncState =
  | { status: 'idle' }
  | { status: 'syncing' }
  | { status: 'done'; count: number }
  | { status: 'error'; message: string };

/** Cached Region Names data — lives separately from the AWS Org sync
 *  conceptually (different API, different IAM perms) so it gets its own UI
 *  block + own re-sync action. We cache per-region metadata published under
 *  /aws/service/global-infrastructure: longName, geolocationCountry,
 *  geolocationRegion. */
export function SsmParameterSection({ profile }: Readonly<{ profile: string | null }>) {
  const api = useCostApi();
  const [refreshKey, setRefreshKey] = useState(0);
  const infoQuery = useQuery(() => api.getRegionNamesInfo(), [refreshKey]);
  const [syncState, setSyncState] = useState<SyncState>({ status: 'idle' });
  const [expanded, setExpanded] = useState(false);
  const [regionSearch, setRegionSearch] = useState('');
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  async function handleClear(): Promise<void> {
    await api.clearOrgData();
    setRefreshKey(k => k + 1);
    setShowClearConfirm(false);
  }

  const info = infoQuery.status === 'success' ? infoQuery.data : null;

  async function handleSync(): Promise<void> {
    if (profile === null) return;
    setSyncState({ status: 'syncing' });
    try {
      const result = await api.syncRegionNames(profile);
      setSyncState({ status: 'done', count: result.count });
      setRefreshKey(k => k + 1);
    } catch (err: unknown) {
      setSyncState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      setRefreshKey(k => k + 1);
    }
  }

  const hasData = info !== null && info.count > 0;
  const hasError = info?.lastError !== null && info?.lastError !== undefined;

  const regionEntries = info === null
    ? []
    : Object.entries(info.regions).sort(([a], [b]) => a.localeCompare(b));
  const needle = regionSearch.toLowerCase();
  const filteredRegions = regionSearch.length > 0
    ? regionEntries.filter(([code, r]) =>
      code.toLowerCase().includes(needle) ||
      r.longName.toLowerCase().includes(needle) ||
      r.country.toLowerCase().includes(needle) ||
      r.continent.toLowerCase().includes(needle))
    : regionEntries;

  if (!hasData) {
    return (
      <div className={[
        'rounded-xl border p-4',
        hasError ? 'border-negative/50 bg-negative-muted' : 'border-warning/50 bg-warning-muted',
      ].join(' ')}>
        <div className="flex items-start gap-3">
          <span className={hasError ? 'text-negative text-lg' : 'text-warning text-lg'}>&#9888;</span>
          <div className="flex-1">
            <p className={[
              'text-sm font-medium',
              hasError ? 'text-negative' : 'text-warning',
            ].join(' ')}>
              {hasError ? 'Region Names sync failed' : 'Region Names not synced'}
            </p>
            <p className="text-xs text-text-secondary mt-1 leading-relaxed">
              {hasError
                ? (info.lastError ?? 'Unknown error')
                : 'Sync region friendly names from SSM to enrich the Region dimension with country and continent.'}
            </p>

            {syncState.status === 'syncing' && (
              <div className="flex items-center gap-2 text-xs text-accent mt-2">
                <div className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
                <span>Fetching region friendly names…</span>
              </div>
            )}

            {profile !== null && syncState.status !== 'syncing' && (
              <button
                type="button"
                onClick={() => { handleSync().catch(() => undefined); }}
                className="mt-3 rounded-md border border-accent/50 bg-accent/10 px-4 py-1.5 text-xs font-medium text-accent hover:bg-accent/20 transition-colors"
              >
                {hasError ? 'Retry sync' : 'Sync region names'}
              </button>
            )}
            {profile === null && (
              <p className="text-xs text-text-muted mt-2">Configure an AWS profile first via the setup wizard.</p>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3">
        <button
          type="button"
          onClick={() => { setExpanded(v => !v); }}
          className="flex items-center gap-2 flex-1 text-left hover:bg-bg-tertiary/30 transition-colors rounded -mx-1 px-1"
        >
          <div className="h-2 w-2 rounded-full bg-accent" />
          <span className="text-sm font-medium text-text-primary">Region Names</span>
          <span className="text-text-muted ml-auto text-xs">{expanded ? '▾' : '▸'}</span>
        </button>
        {profile !== null && (
          <button
            type="button"
            onClick={() => { handleSync().catch(() => undefined); }}
            disabled={syncState.status === 'syncing'}
            className="rounded-md border border-accent/50 bg-accent/10 px-3 py-1 text-xs font-medium text-accent hover:bg-accent/20 transition-colors disabled:opacity-50"
            title="Re-sync SSM region names"
          >
            Re-sync
          </button>
        )}
        <button
          type="button"
          onClick={() => { setShowClearConfirm(true); }}
          disabled={syncState.status === 'syncing'}
          className="rounded-md border border-negative/50 bg-negative/10 px-3 py-1 text-xs font-medium text-negative hover:bg-negative/20 transition-colors disabled:opacity-50"
          title="Clear cached region names"
        >
          Clear
        </button>
      </div>

      {showClearConfirm && (
        <div className="px-4 pb-3">
          <div className="rounded-md border border-negative/30 bg-negative/5 p-3">
            <p className="text-xs text-text-secondary">Clear cached region names? Re-sync any time to repopulate.</p>
            <div className="flex gap-2 mt-2">
              <button
                type="button"
                onClick={() => { setShowClearConfirm(false); }}
                className="rounded-md bg-bg-tertiary px-3 py-1 text-xs font-medium text-text-primary hover:bg-bg-tertiary/80 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => { void handleClear(); }}
                className="rounded-md bg-negative px-3 py-1 text-xs font-medium text-white hover:bg-negative/80 transition-colors"
              >
                Clear
              </button>
            </div>
          </div>
        </div>
      )}

      {syncState.status === 'syncing' && (
        <div className="px-4 pb-2">
          <div className="flex items-center gap-2 text-xs text-accent">
            <div className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
            <span>Fetching region friendly names…</span>
          </div>
        </div>
      )}

      <ul className="px-4 pb-3 flex flex-col gap-1 text-xs">
        <li className="flex items-center gap-2">
          <span className="text-accent">✓</span>
          <span className="text-text-secondary">{String(info.count)} regions enriched with longName + country + continent</span>
          {info.syncedAt.length > 0 && (
            <span className="text-text-muted ml-auto">
              Synced {new Date(info.syncedAt).toLocaleString()}
            </span>
          )}
        </li>
      </ul>

      {expanded && (
        <div className="border-t border-border">
          <div className="flex items-center justify-between px-4 py-2">
            <span className="text-[10px] text-text-muted">
              From /aws/service/global-infrastructure/regions
            </span>
            <input
              type="text"
              placeholder="Search regions..."
              value={regionSearch}
              onChange={e => { setRegionSearch(e.target.value); }}
              className="w-48 rounded border border-border bg-bg-primary px-2 py-1 text-[10px] text-text-primary outline-none focus:border-accent"
            />
          </div>
          <div className="max-h-64 overflow-y-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-text-muted sticky top-0 bg-bg-secondary">
                  <th className="px-4 py-2 font-medium">Region Code</th>
                  <th className="px-4 py-2 font-medium">Friendly Name</th>
                  <th className="px-4 py-2 font-medium">Country</th>
                  <th className="px-4 py-2 font-medium">Continent</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {filteredRegions.map(([code, r]) => (
                  <tr key={code} className="hover:bg-bg-tertiary/20">
                    <td className="px-4 py-1.5 font-mono text-text-secondary">{code}</td>
                    <td className="px-4 py-1.5 text-text-primary">{r.longName}</td>
                    <td className="px-4 py-1.5 text-text-muted font-mono">{r.country.length > 0 ? r.country : '—'}</td>
                    <td className="px-4 py-1.5 text-text-muted">{r.continent.length > 0 ? r.continent : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
