import { useState } from 'react';
import type { AccountMappingStatus, DataInventoryResult, CostGoblinConfig } from '@costgoblin/core/browser';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { ConfirmModal } from '../components/confirm-modal.js';
import { SetupWizard } from './setup-wizard.js';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(0)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`;
}

function formatPeriod(period: string): string {
  const [year, month] = period.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthIdx = Number(month) - 1;
  const monthName = months[monthIdx] ?? month;
  return `${monthName ?? ''} ${year ?? ''}`;
}

type SyncState =
  | { status: 'idle' }
  | { status: 'downloading'; filesDone: number; filesTotal: number; message: string }
  | { status: 'repartitioning'; datesDone: number; datesTotal: number }
  | { status: 'done'; filesDownloaded: number }
  | { status: 'error'; message: string };

function AccountMappingSection({ status, loading }: { status: AccountMappingStatus | null; loading: boolean }) {
  const [expanded, setExpanded] = useState(false);

  if (loading) return null;

  if (status === null || status.status === 'missing') {
    return (
      <div className="rounded-xl border border-warning/50 bg-warning-muted p-4">
        <div className="flex items-start gap-3">
          <span className="text-warning text-lg">&#9888;</span>
          <div>
            <p className="text-sm font-medium text-warning">Account mapping not found</p>
            <p className="text-xs text-text-secondary mt-1 leading-relaxed">
              CostGoblin uses an AWS Organizations account export to map Account IDs to friendly names.
            </p>
            <div className="mt-3 rounded-lg border border-border bg-bg-primary/50 p-3 text-xs text-text-secondary leading-relaxed">
              <p className="font-medium text-text-secondary mb-1">How to export:</p>
              <ol className="list-decimal list-inside space-y-1">
                <li>Go to <span className="text-text-primary">AWS Organizations → AWS accounts</span></li>
                <li>Click <span className="text-text-primary">Actions → Export account list</span></li>
                <li>Save the CSV to <span className="font-mono text-accent">data/raw/</span></li>
              </ol>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 overflow-hidden">
      <button
        type="button"
        onClick={() => { setExpanded(v => !v); }}
        className="flex items-center gap-2 w-full px-4 py-3 text-left hover:bg-bg-tertiary/30 transition-colors"
      >
        <div className="h-2 w-2 rounded-full bg-accent" />
        <span className="text-sm font-medium text-text-primary">Account mapping</span>
        <span className="text-xs text-text-secondary">{String(status.accounts.length)} accounts</span>
        <span className="text-text-muted ml-auto text-xs">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <div className="border-t border-border max-h-48 overflow-y-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-text-muted">
                <th className="px-4 py-2 font-medium">Account ID</th>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">State</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {status.accounts.map(a => (
                <tr key={a.accountId} className="hover:bg-bg-tertiary/20">
                  <td className="px-4 py-1.5 font-mono text-text-secondary">{a.accountId}</td>
                  <td className="px-4 py-1.5 text-text-primary">{a.name}</td>
                  <td className="px-4 py-1.5 text-text-muted">{a.state}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

interface TierPanelProps {
  title: string;
  configured: boolean;
  bucket: string | null;
  retentionDays: number | null;
  localDates: readonly string[];
  diskBytes: number;
  oldestDate: string | null;
  newestDate: string | null;
  periods: DataInventoryResult['periods'];
  selected: Set<string>;
  onToggle: (period: string) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onDownload: () => void;
  onDeletePeriod: (period: string) => void;
  syncState: SyncState;
  onConfigure?: (() => void) | undefined;
  onCancelSync?: (() => void) | undefined;
}

function TierPanel({
  title, configured, bucket, retentionDays,
  localDates, diskBytes, oldestDate, newestDate,
  periods, selected, onToggle, onSelectAll, onDeselectAll, onDownload, onDeletePeriod,
  syncState, onConfigure, onCancelSync,
}: TierPanelProps) {
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const missingPeriods = periods.filter(p => p.localStatus === 'missing' || p.localStatus === 'stale');
  const localPeriods = periods.filter(p => p.localStatus === 'repartitioned');
  const selectedFiles = periods.filter(p => selected.has(p.period)).flatMap(p => [...p.files]);
  const selectedSize = selectedFiles.reduce((s, f) => s + f.size, 0);
  const isSyncing = syncState.status === 'downloading' || syncState.status === 'repartitioning';

  if (!configured) {
    return (
      <div className="flex-1 rounded-xl border border-border bg-bg-secondary/30 p-5">
        <h3 className="text-sm font-semibold text-text-primary mb-4">{title}</h3>
        <div className="rounded-lg border border-dashed border-border p-6 text-center">
          <p className="text-sm text-text-secondary">Not configured</p>
          {onConfigure !== undefined ? (
            <button
              type="button"
              onClick={onConfigure}
              className="mt-3 rounded-md border border-accent/50 bg-accent/10 px-4 py-1.5 text-xs font-medium text-accent hover:bg-accent/20 transition-colors"
            >
              Configure {title.toLowerCase()} data source
            </button>
          ) : (
            <p className="text-xs text-text-muted mt-2">
              Add a <span className="font-mono text-text-secondary">{title.toLowerCase()}</span> section to your provider sync config in <span className="font-mono text-accent">costgoblin.yaml</span>
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 rounded-xl border border-border bg-bg-secondary/30 p-5 flex flex-col gap-4">
      <h3 className="text-sm font-semibold text-text-primary">{title}</h3>

      {/* Config */}
      <div className="space-y-2 text-xs">
        <div className="flex justify-between">
          <span className="text-text-muted">S3 Bucket</span>
          <span className="text-text-secondary font-mono truncate max-w-48 ml-2" title={bucket ?? ''}>{bucket ?? '—'}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-text-muted">Retention</span>
          <span className="text-text-secondary tabular-nums">{retentionDays !== null ? `${String(retentionDays)} days` : '—'}</span>
        </div>
      </div>

      {/* Local stats */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg border border-border bg-bg-primary/50 p-3">
          <p className="text-xs text-text-muted">Local</p>
          <p className="text-lg font-bold tabular-nums text-accent">{String(localDates.length)} <span className="text-xs font-normal text-text-muted">days</span></p>
          <p className="text-xs text-text-muted tabular-nums">{formatBytes(diskBytes)}</p>
        </div>
        <div className="rounded-lg border border-border bg-bg-primary/50 p-3">
          <p className="text-xs text-text-muted">Range</p>
          <p className="text-xs font-medium text-text-primary mt-1">{oldestDate ?? '—'}</p>
          <p className="text-xs text-text-muted">{newestDate !== null ? `to ${newestDate}` : ''}</p>
        </div>
      </div>

      {/* Sync progress */}
      {syncState.status === 'downloading' && (
        <div className="rounded-lg border border-accent/50 bg-positive-muted px-3 py-2">
          <div className="flex items-center justify-between mb-1.5">
            <div className="flex items-center gap-2 text-xs text-accent min-w-0">
              <div className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse shrink-0" />
              <span>Downloading {String(syncState.filesDone)}/{String(syncState.filesTotal)} files</span>
            </div>
            <button
              type="button"
              onClick={() => { onCancelSync?.(); }}
              className="p-0.5 rounded text-negative/70 hover:text-negative hover:bg-negative-muted transition-colors shrink-0 ml-2"
              title="Cancel download"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M1 1l10 10M11 1L1 11" />
              </svg>
            </button>
          </div>
          <div className="h-1 rounded-full bg-bg-tertiary overflow-hidden mb-1.5">
            <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${String(syncState.filesTotal > 0 ? Math.round(syncState.filesDone / syncState.filesTotal * 100) : 0)}%` }} />
          </div>
          {syncState.message.length > 0 && (
            <p className="text-[10px] text-text-muted font-mono truncate">{syncState.message}</p>
          )}
        </div>
      )}
      {syncState.status === 'repartitioning' && (
        <div className="rounded-lg border border-violet-500/50 bg-violet-500/5 px-3 py-2">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-2 text-xs text-violet-400">
              <div className="h-1.5 w-1.5 rounded-full bg-violet-400 animate-pulse" />
              <span>Processing — repartitioning into daily partitions</span>
            </div>
            <span className="text-[10px] text-text-muted tabular-nums">
              {String(syncState.datesDone)} / {String(syncState.datesTotal)} days
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-bg-tertiary overflow-hidden">
            <div className="h-full rounded-full bg-violet-500 transition-all" style={{ width: `${String(syncState.datesTotal > 0 ? Math.round(syncState.datesDone / syncState.datesTotal * 100) : 0)}%` }} />
          </div>
        </div>
      )}
      {syncState.status === 'done' && (
        <div className="rounded-lg border border-accent/50 bg-positive-muted px-3 py-2 text-xs text-accent">
          Synced {String(syncState.filesDownloaded)} files
        </div>
      )}
      {syncState.status === 'error' && (
        <div className="rounded-lg border border-negative/50 bg-negative-muted px-3 py-2 text-xs text-negative">
          {syncState.message}
        </div>
      )}

      {/* Missing / stale periods */}
      {missingPeriods.length > 0 && (
        <div className="rounded-lg border border-border overflow-hidden">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-xs font-medium text-text-secondary">Available</span>
            <div className="flex items-center gap-1.5">
              <button type="button" onClick={onSelectAll} className="text-[11px] text-text-muted hover:text-text-primary">All</button>
              <span className="text-border">·</span>
              <button type="button" onClick={onDeselectAll} className="text-[11px] text-text-muted hover:text-text-primary">None</button>
            </div>
          </div>
          <div className="max-h-48 overflow-y-auto divide-y divide-border-subtle">
            {missingPeriods.map(p => (
              <label key={p.period} className="flex items-center gap-2 px-3 py-1.5 hover:bg-bg-tertiary/30 cursor-pointer text-xs">
                <input type="checkbox" checked={selected.has(p.period)} onChange={() => { onToggle(p.period); }} className="h-3.5 w-3.5 rounded accent-emerald-500" />
                <span className="text-text-primary w-16">{formatPeriod(p.period)}</span>
                {p.localStatus === 'stale' && (
                  <span className="rounded bg-warning-muted px-1.5 py-0.5 text-[10px] font-medium text-warning">stale</span>
                )}
                <span className="text-text-muted tabular-nums ml-auto">{formatBytes(p.totalSize)}</span>
              </label>
            ))}
          </div>
          {selected.size > 0 && (
            <div className="border-t border-border px-3 py-2">
              <button
                type="button"
                onClick={onDownload}
                disabled={isSyncing}
                className="w-full rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Download {String(selected.size)} ({formatBytes(selectedSize)})
              </button>
            </div>
          )}
        </div>
      )}

      {/* Local periods */}
      {localPeriods.length > 0 && (
        <div className="rounded-lg border border-border overflow-hidden">
          <div className="border-b border-border px-3 py-2">
            <span className="text-xs font-medium text-text-secondary">Downloaded</span>
          </div>
          <div className="max-h-48 overflow-y-auto divide-y divide-border-subtle">
            {localPeriods.map(p => (
              <div key={p.period} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                <div className="h-1.5 w-1.5 rounded-full bg-accent" />
                <span className="text-text-primary w-16">{formatPeriod(p.period)}</span>
                <span className="text-text-muted tabular-nums ml-auto mr-2">{formatBytes(p.totalSize)}</span>
                <button type="button" onClick={() => { setPendingDelete(p.period); }} className="text-text-muted hover:text-negative transition-colors">
                  &#10005;
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {missingPeriods.length === 0 && localPeriods.length === 0 && (
        <div className="text-xs text-text-muted text-center py-4">No data found in S3</div>
      )}

      {pendingDelete !== null && (
        <ConfirmModal
          title="Delete local data"
          message={`Remove all local daily partitions for ${formatPeriod(pendingDelete)}? The data can be re-downloaded from S3.`}
          confirmLabel="Delete"
          destructive
          onConfirm={() => { onDeletePeriod(pendingDelete); setPendingDelete(null); }}
          onCancel={() => { setPendingDelete(null); }}
        />
      )}
    </div>
  );
}

export function DataManagement() {
  const api = useCostApi();
  const [configRefreshKey, setConfigRefreshKey] = useState(0);
  const [dailyRefreshKey, setDailyRefreshKey] = useState(0);
  const [hourlyRefreshKey, setHourlyRefreshKey] = useState(0);
  const [costOptRefreshKey, setCostOptRefreshKey] = useState(0);
  const configQuery = useQuery(() => api.getConfig(), [configRefreshKey]);
  const inventoryQuery = useQuery(() => api.getDataInventory(), [dailyRefreshKey]);
  const accountQuery = useQuery(() => api.getAccountMapping(), [configRefreshKey]);
  const [selected, setSelected] = useState(new Set<string>());
  const [hourlySelected, setHourlySelected] = useState(new Set<string>());
  const [costOptSelected, setCostOptSelected] = useState(new Set<string>());
  const [initialized, setInitialized] = useState(false);
  const [dailySyncState, setDailySyncState] = useState<SyncState>({ status: 'idle' });
  const [hourlySyncState, setHourlySyncState] = useState<SyncState>({ status: 'idle' });
  const [costOptSyncState, setCostOptSyncState] = useState<SyncState>({ status: 'idle' });
  const [autoSync, setAutoSync] = useState(false);
  const [showDeleteAll, setShowDeleteAll] = useState(false);
  const [configureSource, setConfigureSource] = useState<'hourly' | 'costOptimization' | null>(null);

  const inventory: DataInventoryResult | null =
    inventoryQuery.status === 'success' ? inventoryQuery.data : null;
  const config: CostGoblinConfig | null =
    configQuery.status === 'success' ? configQuery.data : null;
  const provider = config?.providers[0] ?? null;

  const retentionDays = provider?.sync.daily.retentionDays ?? 365;
  const retentionCutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const retentionCutoffPeriod = `${String(retentionCutoff.getFullYear())}-${String(retentionCutoff.getMonth() + 1).padStart(2, '0')}`;

  const missingPeriods = inventory?.periods.filter(p => p.localStatus === 'missing') ?? [];
  const missingWithinRetention = missingPeriods.filter(p => p.period >= retentionCutoffPeriod);

  if (!initialized && inventoryQuery.status === 'success' && missingWithinRetention.length > 0) {
    setSelected(new Set(missingWithinRetention.map(p => p.period)));
    setInitialized(true);
  }

  function togglePeriod(period: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(period)) { next.delete(period); } else { next.add(period); }
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(missingWithinRetention.map(p => p.period)));
  }

  function deselectAll() {
    setSelected(new Set());
  }

  async function handleSync() {
    const selectedFiles = (inventory?.periods ?? [])
      .filter(p => selected.has(p.period))
      .flatMap(p => [...p.files]);
    if (selectedFiles.length === 0) return;
    setDailySyncState({ status: 'downloading', filesDone: 0, filesTotal: selectedFiles.length, message: '' });

    const pollInterval = setInterval(() => {
      void api.getSyncStatus('daily').then((s) => {
        if (s.status === 'syncing') {
          if (s.phase === 'repartitioning') {
            setDailySyncState({ status: 'repartitioning', datesDone: s.filesDone, datesTotal: s.filesTotal });
          } else {
            setDailySyncState({ status: 'downloading', filesDone: s.filesDone, filesTotal: s.filesTotal, message: s.message });
          }
        } else if (s.status === 'idle') {
          setDailySyncState({ status: 'idle' });
        }
      });
    }, 500);

    try {
      const result = await api.syncPeriods(selectedFiles, 'daily');
      clearInterval(pollInterval);
      setDailySyncState({ status: 'done', filesDownloaded: result.filesDownloaded });
      setSelected(new Set());
      setDailyRefreshKey(k => k + 1);
    } catch (err: unknown) {
      clearInterval(pollInterval);
      setDailySyncState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  function handleDeleteDaily(period: string) {
    void api.deleteLocalPeriod(period, 'daily').then(() => { setDailyRefreshKey(k => k + 1); });
  }

  function handleDeleteHourly(period: string) {
    void api.deleteLocalPeriod(period, 'hourly').then(() => { setHourlyRefreshKey(k => k + 1); });
  }

  function handleDeleteAll() {
    const local = inventory?.periods.filter(p => p.localStatus === 'repartitioned') ?? [];
    const promises = local.map(p => api.deleteLocalPeriod(p.period, 'daily'));
    void Promise.all(promises).then(() => { setDailyRefreshKey(k => k + 1); setShowDeleteAll(false); });
  }

  const isNotConfigured = configQuery.status === 'error' || (configQuery.status === 'success' && config === null);

  const dailyBucket = provider?.sync.daily.bucket ?? null;
  const dailyRetention = provider?.sync.daily.retentionDays ?? null;
  const hourlyBucket = provider?.sync.hourly?.bucket ?? null;

  const hourlyInventoryQuery = useQuery(
    () => {
      if (hourlyBucket === null) return Promise.resolve(null);
      return api.getDataInventory('hourly');
    },
    [hourlyBucket, hourlyRefreshKey],
  );
  const hourlyInventory: DataInventoryResult | null = hourlyInventoryQuery.status === 'success' ? hourlyInventoryQuery.data : null;
  const hourlyRetention = provider?.sync.hourly?.retentionDays ?? null;
  const costOptBucket = provider?.sync.costOptimization?.bucket ?? null;
  const costOptRetention = provider?.sync.costOptimization?.retentionDays ?? null;
  const awsProfile = provider?.credentials.profile ?? null;

  const costOptInventoryQuery = useQuery(
    () => {
      if (costOptBucket === null) return Promise.resolve(null);
      return api.getDataInventory('cost-optimization');
    },
    [costOptBucket, costOptRefreshKey],
  );
  const costOptInventory: DataInventoryResult | null = costOptInventoryQuery.status === 'success' ? costOptInventoryQuery.data : null;

  const hourlyMissing = hourlyInventory?.periods.filter(p => p.localStatus === 'missing') ?? [];
  const costOptMissing = costOptInventory?.periods.filter(p => p.localStatus === 'missing') ?? [];

  function toggleHourlyPeriod(period: string) {
    setHourlySelected(prev => {
      const next = new Set(prev);
      if (next.has(period)) { next.delete(period); } else { next.add(period); }
      return next;
    });
  }

  function selectAllHourly() {
    setHourlySelected(new Set(hourlyMissing.map(p => p.period)));
  }

  function deselectAllHourly() {
    setHourlySelected(new Set());
  }

  async function handleHourlySync() {
    const selectedFiles = (hourlyInventory?.periods ?? [])
      .filter(p => hourlySelected.has(p.period))
      .flatMap(p => [...p.files]);
    if (selectedFiles.length === 0) return;
    setHourlySyncState({ status: 'downloading', filesDone: 0, filesTotal: selectedFiles.length, message: '' });

    const pollInterval = setInterval(() => {
      void api.getSyncStatus('hourly').then((s) => {
        if (s.status === 'syncing') {
          if (s.phase === 'repartitioning') {
            setHourlySyncState({ status: 'repartitioning', datesDone: s.filesDone, datesTotal: s.filesTotal });
          } else {
            setHourlySyncState({ status: 'downloading', filesDone: s.filesDone, filesTotal: s.filesTotal, message: s.message });
          }
        } else if (s.status === 'idle') {
          setHourlySyncState({ status: 'idle' });
        }
      });
    }, 500);

    try {
      const result = await api.syncPeriods(selectedFiles, 'hourly');
      clearInterval(pollInterval);
      setHourlySyncState({ status: 'done', filesDownloaded: result.filesDownloaded });
      setHourlySelected(new Set());
      setHourlyRefreshKey(k => k + 1);
    } catch (err: unknown) {
      clearInterval(pollInterval);
      setHourlySyncState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  function toggleCostOptPeriod(period: string) {
    setCostOptSelected(prev => {
      const next = new Set(prev);
      if (next.has(period)) { next.delete(period); } else { next.add(period); }
      return next;
    });
  }

  function selectAllCostOpt() {
    setCostOptSelected(new Set(costOptMissing.map(p => p.period)));
  }

  function deselectAllCostOpt() {
    setCostOptSelected(new Set());
  }

  function handleDeleteCostOpt(period: string) {
    void api.deleteLocalPeriod(period, 'cost-optimization').then(() => { setCostOptRefreshKey(k => k + 1); });
  }

  async function handleCostOptSync() {
    const selectedFiles = (costOptInventory?.periods ?? [])
      .filter(p => costOptSelected.has(p.period))
      .flatMap(p => [...p.files]);
    if (selectedFiles.length === 0) return;
    setCostOptSyncState({ status: 'downloading', filesDone: 0, filesTotal: selectedFiles.length, message: '' });

    const pollInterval = setInterval(() => {
      void api.getSyncStatus('cost-optimization').then((s) => {
        if (s.status === 'syncing') {
          if (s.phase === 'repartitioning') {
            setCostOptSyncState({ status: 'repartitioning', datesDone: s.filesDone, datesTotal: s.filesTotal });
          } else {
            setCostOptSyncState({ status: 'downloading', filesDone: s.filesDone, filesTotal: s.filesTotal, message: s.message });
          }
        } else if (s.status === 'idle') {
          setCostOptSyncState({ status: 'idle' });
        }
      });
    }, 500);

    try {
      const result = await api.syncPeriods(selectedFiles, 'cost-optimization');
      clearInterval(pollInterval);
      setCostOptSyncState({ status: 'done', filesDownloaded: result.filesDownloaded });
      setCostOptSelected(new Set());
      setCostOptRefreshKey(k => k + 1);
    } catch (err: unknown) {
      clearInterval(pollInterval);
      setCostOptSyncState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  if (isNotConfigured) {
    return (
      <div className="flex flex-col gap-5 p-6">
        <div>
          <h2 className="text-xl font-semibold text-text-primary">Data Management</h2>
          <p className="text-sm text-text-secondary mt-0.5">S3 sync and local data inventory</p>
        </div>
        <div className="flex flex-col items-center gap-5 py-12 text-center">
          <div className="rounded-xl border border-border bg-bg-secondary/50 px-8 py-8 max-w-lg w-full">
            <h3 className="text-lg font-semibold text-text-primary">No data source configured</h3>
            <p className="text-sm text-text-secondary mt-2">
              CostGoblin needs to know where your AWS billing data lives. You can either run the setup wizard or configure it manually.
            </p>

            <div className="flex flex-col gap-3 mt-6">
              <div className="rounded-lg border border-border bg-bg-tertiary/20 px-4 py-3 text-left">
                <p className="text-xs font-medium text-text-secondary uppercase tracking-wider mb-1">Option 1: Run the wizard</p>
                <p className="text-xs text-text-muted">Restart the app to go through the guided setup.</p>
              </div>

              <div className="rounded-lg border border-border bg-bg-tertiary/20 px-4 py-3 text-left">
                <p className="text-xs font-medium text-text-secondary uppercase tracking-wider mb-1">Option 2: Manual setup</p>
                <p className="text-xs text-text-muted mb-2">Generate template config files and edit them with your S3 bucket path and tag mappings.</p>
                <button
                  type="button"
                  onClick={() => { void api.scaffoldConfig(); }}
                  className="rounded-md border border-accent/50 bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent hover:bg-accent/20 transition-colors"
                >
                  Generate config templates & open folder
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-text-primary">Data Management</h2>
          <p className="text-sm text-text-secondary mt-0.5">S3 sync and local data inventory</p>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-xs text-text-secondary">Auto-sync</span>
            <button
              type="button"
              onClick={() => { setAutoSync(v => !v); }}
              className={['relative h-5 w-9 rounded-full transition-colors', autoSync ? 'bg-accent' : 'bg-bg-tertiary'].join(' ')}
            >
              <span className={['absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform', autoSync ? 'translate-x-4' : 'translate-x-0'].join(' ')} />
            </button>
          </div>
          <button type="button" onClick={() => { setShowDeleteAll(true); }} className="rounded-md border border-negative/50 bg-negative-muted px-3 py-1.5 text-xs font-medium text-negative hover:bg-negative-muted hover:text-negative transition-colors">
            Delete All Data
          </button>
          <button type="button" onClick={() => { void api.openDataFolder(); }} className="rounded-md border border-border bg-bg-tertiary/50 px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-tertiary hover:text-text-primary transition-colors">
            Open Folder
          </button>
          <button type="button" onClick={() => { setDailyRefreshKey(k => k + 1); setHourlyRefreshKey(k => k + 1); setCostOptRefreshKey(k => k + 1); }} className="rounded-md border border-border bg-bg-tertiary/50 px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-tertiary hover:text-text-primary transition-colors">
            Refresh
          </button>
        </div>
      </div>

      {/* Account mapping */}
      <AccountMappingSection status={accountQuery.status === 'success' ? accountQuery.data : null} loading={accountQuery.status === 'loading'} />

      {inventoryQuery.status === 'loading' && (
        <div className="rounded-xl border border-border bg-bg-secondary/50 p-12 text-center text-text-secondary">
          Checking S3 for available data...
        </div>
      )}

      {inventoryQuery.status === 'error' && (
        <div className="rounded-lg border border-negative bg-negative-muted px-4 py-3 text-sm text-negative">
          {inventoryQuery.error.message}
        </div>
      )}

      {/* Two-column tier layout */}
      {inventory !== null && (
        <div className="flex gap-5">
          <TierPanel
            title="Daily"
            configured={dailyBucket !== null}
            bucket={dailyBucket}
            retentionDays={dailyRetention}
            localDates={inventory.local.dates}
            diskBytes={inventory.local.diskBytes}
            oldestDate={inventory.local.oldestDate}
            newestDate={inventory.local.newestDate}
            periods={[...inventory.periods]}
            selected={selected}
            onToggle={togglePeriod}
            onSelectAll={selectAll}
            onDeselectAll={deselectAll}
            onDownload={() => { void handleSync(); }}
            onDeletePeriod={handleDeleteDaily}
            syncState={dailySyncState}
            onCancelSync={() => { void api.cancelSync('daily'); setDailySyncState({ status: 'idle' }); }}
          />
          <TierPanel
            title="Hourly"
            configured={hourlyBucket !== null}
            bucket={hourlyBucket}
            retentionDays={hourlyRetention}
            localDates={hourlyInventory?.local.dates ?? []}
            diskBytes={hourlyInventory?.local.diskBytes ?? 0}
            oldestDate={hourlyInventory?.local.oldestDate ?? null}
            newestDate={hourlyInventory?.local.newestDate ?? null}
            periods={hourlyInventory !== null ? [...hourlyInventory.periods] : []}
            selected={hourlySelected}
            onToggle={toggleHourlyPeriod}
            onSelectAll={selectAllHourly}
            onDeselectAll={deselectAllHourly}
            onDownload={() => { void handleHourlySync(); }}
            onDeletePeriod={handleDeleteHourly}
            syncState={hourlySyncState}
            onCancelSync={() => { void api.cancelSync('hourly'); setHourlySyncState({ status: 'idle' }); }}
            onConfigure={() => { setConfigureSource('hourly'); }}
          />
          <TierPanel
            title="Cost Optimization"
            configured={costOptBucket !== null}
            bucket={costOptBucket}
            retentionDays={costOptRetention}
            localDates={costOptInventory?.local.dates ?? []}
            diskBytes={costOptInventory?.local.diskBytes ?? 0}
            oldestDate={costOptInventory?.local.oldestDate ?? null}
            newestDate={costOptInventory?.local.newestDate ?? null}
            periods={costOptInventory !== null ? [...costOptInventory.periods] : []}
            selected={costOptSelected}
            onToggle={toggleCostOptPeriod}
            onSelectAll={selectAllCostOpt}
            onDeselectAll={deselectAllCostOpt}
            onDownload={() => { void handleCostOptSync(); }}
            onDeletePeriod={handleDeleteCostOpt}
            syncState={costOptSyncState}
            onCancelSync={() => { void api.cancelSync('cost-optimization'); setCostOptSyncState({ status: 'idle' }); }}
            onConfigure={() => { setConfigureSource('costOptimization'); }}
          />
        </div>
      )}

      {showDeleteAll && (
        <ConfirmModal
          title="Delete all local data"
          message="This will remove all downloaded and repartitioned data from your machine. You can re-download it from S3 anytime."
          confirmLabel="Delete All"
          destructive
          onConfirm={handleDeleteAll}
          onCancel={() => { setShowDeleteAll(false); }}
        />
      )}

      {configureSource !== null && awsProfile !== null && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <SetupWizard
            source={configureSource}
            profile={awsProfile}
            onComplete={() => { setConfigureSource(null); setConfigRefreshKey(k => k + 1); setDailyRefreshKey(k => k + 1); setHourlyRefreshKey(k => k + 1); setCostOptRefreshKey(k => k + 1); }}
          />
        </div>
      )}
    </div>
  );
}
