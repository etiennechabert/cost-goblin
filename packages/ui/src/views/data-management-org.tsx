import { useState } from 'react';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { ConfirmModal } from '../components/confirm-modal.js';

type OrgSyncState =
  | { status: 'idle' }
  | { status: 'syncing'; phase: string; done: number; total: number }
  | { status: 'done'; count: number }
  | { status: 'error'; message: string };

// Map the backend's terse phase keys to user-facing sentences. The 'tags'
// phase iterates ListTagsForResource per account (so total = account count,
// NOT the eventual number of distinct tag keys — that's discovered after).
function phaseLabel(phase: string, total: number): string {
  switch (phase) {
    case 'accounts': return 'Listing accounts';
    case 'ous':      return 'Discovering organizational units';
    case 'tags':     return total > 0 ? 'Fetching tags from each account' : 'Fetching tags';
    case 'regions':  return 'Fetching region friendly names from SSM';
    default:         return phase;
  }
}

export function OrgAccountsSection({ profile }: Readonly<{ profile: string | null }>) {
  const api = useCostApi();
  const [refreshKey, setRefreshKey] = useState(0);
  const orgQuery = useQuery(() => api.getOrgSyncResult(), [refreshKey]);
  const regionInfoQuery = useQuery(() => api.getRegionNamesInfo(), [refreshKey]);
  const [expanded, setExpanded] = useState(false);
  const [syncState, setSyncState] = useState<OrgSyncState>({ status: 'idle' });
  const [accountSearch, setAccountSearch] = useState('');
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);

  const orgData = orgQuery.status === 'success' ? orgQuery.data : null;
  const regionInfo = regionInfoQuery.status === 'success' ? regionInfoQuery.data : null;
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  async function handleClear(): Promise<void> {
    setShowClearConfirm(false);
    setSelectedAccountId(null);
    setExpanded(false);
    await api.clearOrgData();
    setRefreshKey(k => k + 1);
  }
  const selectedAccount = orgData !== null && selectedAccountId !== null
    ? orgData.accounts.find(a => a.id === selectedAccountId) ?? null
    : null;

  async function handleSync() {
    if (profile === null) return;
    setSyncState({ status: 'syncing', phase: 'accounts', done: 0, total: 0 });

    const pollInterval = setInterval(() => {
      void api.getOrgSyncProgress().then(p => {
        if (p !== null) {
          setSyncState({ status: 'syncing', phase: p.phase, done: p.done, total: p.total });
        }
      }).catch(() => { /* transient */ });
    }, 500);

    try {
      const result = await api.syncOrgAccounts(profile);
      clearInterval(pollInterval);
      setSyncState({ status: 'done', count: result.accounts.length });
      // Force the org + region-names queries to re-fetch so the bullet list
      // reflects the new data without waiting for the user to navigate away
      // and back.
      setRefreshKey(k => k + 1);
    } catch (err: unknown) {
      clearInterval(pollInterval);
      setSyncState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  const allTagKeys = orgData !== null
    ? [...new Set(orgData.accounts.flatMap(a => Object.keys(a.tags)))].sort()
    : [];
  // OU count is derivable from the per-account ouPath. Distinct non-empty
  // paths approximate the number of OUs the user has placed accounts into.
  const ouCount = orgData !== null
    ? new Set(orgData.accounts.map(a => a.ouPath).filter(p => p.length > 0)).size
    : 0;

  const filteredAccounts = orgData !== null && accountSearch.length > 0
    ? orgData.accounts.filter(a =>
      a.id.includes(accountSearch) ||
      a.name.toLowerCase().includes(accountSearch.toLowerCase()) ||
      a.ouPath.toLowerCase().includes(accountSearch.toLowerCase()))
    : orgData?.accounts ?? [];

  if (orgData === null) {
    return (
      <div className="rounded-xl border border-warning/50 bg-warning-muted p-4">
        <div className="flex items-start gap-3">
          <span className="text-warning text-lg">&#9888;</span>
          <div className="flex-1">
            <p className="text-sm font-medium text-warning">AWS Organizations not synced</p>
            <p className="text-xs text-text-secondary mt-1 leading-relaxed">
              Sync your AWS Organization to discover accounts, their OU placement, and tags.
              This replaces the manual CSV export.
            </p>

            {syncState.status === 'syncing' && (
              <div className="mt-3 rounded-lg border border-accent/50 bg-positive-muted px-3 py-2">
                <div className="flex items-center gap-2 text-xs text-accent">
                  <div className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
                  <span className="capitalize">{syncState.phase}</span>
                  {syncState.total > 0 && <span>— {String(syncState.done)}/{String(syncState.total)}</span>}
                </div>
              </div>
            )}
            {syncState.status === 'error' && (
              <div className="mt-3 rounded-lg border border-negative/50 bg-negative-muted px-3 py-2 text-xs text-negative">
                {syncState.message}
              </div>
            )}
            {syncState.status === 'done' && (
              <div className="mt-3 rounded-lg border border-accent/50 bg-positive-muted px-3 py-2 text-xs text-accent">
                Synced {String(syncState.count)} accounts
              </div>
            )}

            {profile !== null && syncState.status !== 'syncing' && (
              <button
                type="button"
                onClick={() => { void handleSync(); }}
                className="mt-3 rounded-md border border-accent/50 bg-accent/10 px-4 py-1.5 text-xs font-medium text-accent hover:bg-accent/20 transition-colors"
              >
                Sync from AWS Organizations
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
          <span className="text-sm font-medium text-text-primary">AWS Organization</span>
          <span className="text-text-muted ml-auto text-xs">{expanded ? '▾' : '▸'}</span>
        </button>
        {profile !== null && (
          <button
            type="button"
            onClick={() => { void handleSync(); }}
            disabled={syncState.status === 'syncing'}
            className="text-xs text-text-muted hover:text-accent transition-colors disabled:opacity-50"
            title="Re-sync"
          >
            ↻
          </button>
        )}
        <button
          type="button"
          onClick={() => { setShowClearConfirm(true); }}
          disabled={syncState.status === 'syncing'}
          className="text-xs text-text-muted hover:text-negative transition-colors disabled:opacity-50"
          title="Delete all org-sync data (accounts, account tags, region names)"
        >
          Clear
        </button>
      </div>

      {syncState.status === 'syncing' && (
        <div className="px-4 pb-2">
          <div className="flex items-center gap-2 text-xs text-accent">
            <div className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
            <span>{phaseLabel(syncState.phase, syncState.total)}</span>
            {syncState.total > 0 && <span>— {String(syncState.done)}/{String(syncState.total)}</span>}
          </div>
        </div>
      )}

      {expanded && (
        <div className="border-t border-border">
          {/* What got pulled in the last successful sync. Region names are
              sourced from the SSM piggyback step; missing means insufficient
              permissions or sync hasn't run since the feature was added. */}
          <ul className="px-4 pt-3 pb-1 flex flex-col gap-1 text-xs">
            <li className="flex items-center gap-2 text-text-secondary">
              <span className="text-accent">✓</span>
              <span>{String(orgData.accounts.length)} accounts</span>
            </li>
            <li className="flex items-center gap-2 text-text-secondary">
              <span className="text-accent">✓</span>
              <span>{String(ouCount)} organizational units</span>
            </li>
            <li className="flex items-center gap-2 text-text-secondary">
              <span className="text-accent">✓</span>
              <span>{String(allTagKeys.length)} tag keys (across all accounts, used as fallback when resources are under-tagged)</span>
            </li>
            <li className="flex items-center gap-2">
              {regionInfo !== null && regionInfo.count > 0 ? (
                <>
                  <span className="text-accent">✓</span>
                  <span className="text-text-secondary">{String(regionInfo.count)} region friendly names</span>
                </>
              ) : regionInfo?.lastError !== undefined && regionInfo.lastError !== null ? (
                <>
                  <span className="text-negative">✗</span>
                  <span className="text-negative" title={regionInfo.lastError}>region friendly names — {regionInfo.lastError}</span>
                </>
              ) : (
                <>
                  <span className="text-text-muted">○</span>
                  <span className="text-text-muted">region friendly names not synced (re-sync to populate)</span>
                </>
              )}
            </li>
          </ul>
          <div className="flex items-center justify-between px-4 py-2">
            <span className="text-[10px] text-text-muted">
              Synced {new Date(orgData.syncedAt).toLocaleDateString()} · Org {orgData.orgId}
            </span>
            <input
              type="text"
              placeholder="Search accounts..."
              value={accountSearch}
              onChange={e => { setAccountSearch(e.target.value); }}
              className="w-48 rounded border border-border bg-bg-primary px-2 py-1 text-[10px] text-text-primary outline-none focus:border-accent"
            />
          </div>
          <div className="max-h-64 overflow-y-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-text-muted sticky top-0 bg-bg-secondary">
                  <th className="px-4 py-2 font-medium">Account ID</th>
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium">OU Path</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Tags</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {filteredAccounts.map(a => (
                  <tr
                    key={a.id}
                    className={`cursor-pointer transition-colors ${selectedAccountId === a.id ? 'bg-bg-tertiary/40' : 'hover:bg-bg-tertiary/20'}`}
                    onClick={() => { setSelectedAccountId(selectedAccountId === a.id ? null : a.id); }}
                  >
                    <td className="px-4 py-1.5 font-mono text-text-secondary">{a.id}</td>
                    <td className="px-4 py-1.5 text-text-primary">{a.name}</td>
                    <td className="px-4 py-1.5 text-text-muted">{a.ouPath.length > 0 ? a.ouPath : '—'}</td>
                    <td className="px-4 py-1.5 text-text-muted">{a.status}</td>
                    <td className="px-4 py-1.5 text-text-muted">{String(Object.keys(a.tags).length)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {selectedAccount !== null && (
            <div className="border-t border-accent/30 bg-bg-tertiary/10 px-5 py-4">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h4 className="text-sm font-semibold text-text-primary">{selectedAccount.name}</h4>
                  <p className="text-xs text-text-muted font-mono mt-0.5">{selectedAccount.id}</p>
                </div>
                <button
                  type="button"
                  onClick={() => { setSelectedAccountId(null); }}
                  className="rounded-md p-1 text-text-muted hover:text-text-primary hover:bg-bg-tertiary transition-colors"
                >
                  ✕
                </button>
              </div>
              <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-xs mb-4">
                <div className="flex justify-between">
                  <span className="text-text-muted">Email</span>
                  <span className="text-text-secondary">{selectedAccount.email}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-muted">Status</span>
                  <span className="text-text-secondary">{selectedAccount.status}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-muted">OU Path</span>
                  <span className="text-text-secondary">{selectedAccount.ouPath.length > 0 ? selectedAccount.ouPath : '—'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-muted">Joined</span>
                  <span className="text-text-secondary">{selectedAccount.joinedTimestamp.length > 0 ? new Date(selectedAccount.joinedTimestamp).toLocaleDateString() : '—'}</span>
                </div>
              </div>
              {Object.keys(selectedAccount.tags).length > 0 ? (
                <div>
                  <h5 className="text-xs font-medium text-text-secondary mb-2">Tags ({String(Object.keys(selectedAccount.tags).length)})</h5>
                  <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                    {Object.entries(selectedAccount.tags).sort((a, b) => a[0].localeCompare(b[0])).map(([key, value]) => (
                      <div key={key} className="contents">
                        <span className="text-text-muted font-mono">{key}</span>
                        <span className="text-text-primary">{value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-xs text-text-muted">No tags</p>
              )}
            </div>
          )}

          {allTagKeys.length > 0 && (
            <div className="border-t border-border px-4 py-3">
              <h4 className="text-xs font-medium text-text-secondary mb-2">Discovered Tags</h4>
              <div className="flex flex-wrap gap-1.5">
                {allTagKeys.map(key => (
                  <span key={key} className="rounded-full border border-border bg-bg-tertiary/30 px-2 py-0.5 text-[10px] text-text-secondary">
                    {key}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {showClearConfirm && (
        <ConfirmModal
          title="Clear AWS Org sync data?"
          message="Removes locally cached accounts, account-tag lookups, and SSM region names. Your CUR data is untouched. Re-sync any time to repopulate."
          confirmLabel="Clear"
          cancelLabel="Cancel"
          destructive
          onConfirm={() => { void handleClear(); }}
          onCancel={() => { setShowClearConfirm(false); }}
        />
      )}
    </div>
  );
}
