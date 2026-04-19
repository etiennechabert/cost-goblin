import { useState } from 'react';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';

type SyncState =
  | { status: 'idle' }
  | { status: 'syncing' }
  | { status: 'done'; count: number }
  | { status: 'error'; message: string };

/** Cached SSM Parameter Store data — lives separately from the AWS Org sync
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

  const regionEntries = info !== null
    ? Object.entries(info.regions).sort(([a], [b]) => a.localeCompare(b))
    : [];
  const needle = regionSearch.toLowerCase();
  const filteredRegions = regionSearch.length > 0
    ? regionEntries.filter(([code, r]) =>
      code.toLowerCase().includes(needle) ||
      r.longName.toLowerCase().includes(needle) ||
      r.country.toLowerCase().includes(needle) ||
      r.continent.toLowerCase().includes(needle))
    : regionEntries;

  return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3">
        <button
          type="button"
          onClick={() => { if (hasData) setExpanded(v => !v); }}
          disabled={!hasData}
          className="flex items-center gap-2 flex-1 text-left hover:bg-bg-tertiary/30 transition-colors rounded -mx-1 px-1 disabled:hover:bg-transparent disabled:cursor-default"
        >
          <div className={[
            'h-2 w-2 rounded-full',
            hasData ? 'bg-accent' : hasError ? 'bg-negative' : 'bg-text-muted',
          ].join(' ')} />
          <span className="text-sm font-medium text-text-primary">SSM Parameter Store</span>
          {hasData && <span className="text-text-muted ml-auto text-xs">{expanded ? '▾' : '▸'}</span>}
        </button>
        {profile !== null && (
          <button
            type="button"
            onClick={() => { void handleSync(); }}
            disabled={syncState.status === 'syncing'}
            className="text-xs text-text-muted hover:text-accent transition-colors disabled:opacity-50"
            title={hasData ? 'Re-sync SSM region names' : 'Fetch SSM region names'}
          >
            {hasData ? '↻' : 'Sync'}
          </button>
        )}
      </div>

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
          {hasData ? (
            <>
              <span className="text-accent">✓</span>
              <span className="text-text-secondary">{String(info.count)} regions enriched with longName + country + continent</span>
              {info.syncedAt.length > 0 && (
                <span className="text-text-muted ml-auto">
                  Synced {new Date(info.syncedAt).toLocaleString()}
                </span>
              )}
            </>
          ) : hasError ? (
            <>
              <span className="text-negative shrink-0">✗</span>
              <span className="text-negative break-words">
                Last sync failed: {info.lastError ?? ''}
              </span>
            </>
          ) : (
            <>
              <span className="text-text-muted">○</span>
              <span className="text-text-muted">No region names cached — click Sync to fetch from SSM Parameter Store</span>
            </>
          )}
        </li>
      </ul>

      {expanded && hasData && (
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
