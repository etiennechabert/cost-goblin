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
 *  block + own re-sync action. Right now the only thing we cache is region
 *  long names; geographic / country fields would slot in here too. */
export function SsmParameterSection({ profile }: Readonly<{ profile: string | null }>) {
  const api = useCostApi();
  const [refreshKey, setRefreshKey] = useState(0);
  const infoQuery = useQuery(() => api.getRegionNamesInfo(), [refreshKey]);
  const [syncState, setSyncState] = useState<SyncState>({ status: 'idle' });

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

  // Source-of-truth for the dot color and the "have we got data" check.
  const hasData = info !== null && info.count > 0;
  const hasError = info?.lastError !== null && info?.lastError !== undefined;

  return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3">
        <div className={[
          'h-2 w-2 rounded-full',
          hasData ? 'bg-accent' : hasError ? 'bg-negative' : 'bg-text-muted',
        ].join(' ')} />
        <span className="text-sm font-medium text-text-primary">SSM Parameter Store</span>
        {profile !== null && (
          <button
            type="button"
            onClick={() => { void handleSync(); }}
            disabled={syncState.status === 'syncing'}
            className="ml-auto text-xs text-text-muted hover:text-accent transition-colors disabled:opacity-50"
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
              <span className="text-text-secondary">{String(info.count)} region friendly names</span>
              {info.syncedAt.length > 0 && (
                <span className="text-text-muted ml-auto">
                  Synced {new Date(info.syncedAt).toLocaleString()}
                </span>
              )}
            </>
          ) : hasError ? (
            <>
              <span className="text-negative">✗</span>
              <span className="text-negative" title={info.lastError ?? undefined}>
                Last sync failed: {(info.lastError ?? '').length > 100 ? `${(info.lastError ?? '').slice(0, 100)}…` : (info.lastError ?? '')}
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
    </div>
  );
}
