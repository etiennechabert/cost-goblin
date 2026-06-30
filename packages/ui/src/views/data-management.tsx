import { useState, useEffect, useRef } from 'react';
import type { DataInventoryResult, DataTier, CostGoblinConfig, SyncStatus } from '@costgoblin/core/browser';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { ConfirmModal } from '../components/confirm-modal.js';
import { ProfilePicker } from '../components/profile-picker.js';
import { SetupWizard } from './setup-wizard.js';
import { OrgAccountsSection } from './data-management-org.js';
import { SsmParameterSection } from './data-management-ssm.js';
import { TierPanel, type SyncState } from './data-management-tier.js';
import { SyncLogPanel } from './data-management-logs.js';
import { SsoLoginButton } from '../components/sso-login-button.js';
import { SchedulerControls } from '../components/scheduler-controls.js';

function syncStatusToState(s: SyncStatus): SyncState | null {
  if (s.status === 'syncing') {
    return s.phase === 'repartitioning'
      ? { status: 'repartitioning', datesDone: s.filesDone, datesTotal: s.filesTotal }
      : { status: 'downloading', filesDone: s.filesDone, filesTotal: s.filesTotal, bytesDone: s.bytesDone, bytesTotal: s.bytesTotal, message: s.message };
  }
  if (s.status === 'idle') {
    return { status: 'idle' };
  }
  return null;
}

function incrementKey(k: number): number {
  return k + 1;
}

function retentionCutoffPeriod(retentionDays: number): string {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  return `${String(cutoff.getFullYear())}-${String(cutoff.getMonth() + 1).padStart(2, '0')}`;
}

function toggleInSet(
  setter: (fn: (prev: Set<string>) => Set<string>) => void,
  period: string,
): void {
  setter(prev => {
    const next = new Set(prev);
    if (next.has(period)) { next.delete(period); } else { next.add(period); }
    return next;
  });
}

function missingWithinCutoff(
  inventory: DataInventoryResult | null,
  cutoffPeriod: string,
): DataInventoryResult['periods'] {
  if (inventory === null) return [];
  return inventory.periods
    .filter(p => p.localStatus === 'missing')
    .filter(p => p.period >= cutoffPeriod);
}

// Periods that an on-demand sync should pull: not yet local ('missing') or
// out of date vs. S3 ('stale'), within the tier's retention window. Mirrors the
// background auto-sync's selection so the manual "Sync" button does the same work.
function syncableWithinCutoff(
  inventory: DataInventoryResult | null,
  cutoffPeriod: string,
): DataInventoryResult['periods'] {
  if (inventory === null) return [];
  return inventory.periods
    .filter(p => p.localStatus === 'missing' || p.localStatus === 'stale')
    .filter(p => p.period >= cutoffPeriod);
}

function isSyncActive(state: SyncState): boolean {
  return state.status === 'downloading' || state.status === 'repartitioning';
}

export function DataManagement() {
  const api = useCostApi();
  const [configRefreshKey, setConfigRefreshKey] = useState(0);
  const [dailyRefreshKey, setDailyRefreshKey] = useState(0);
  const [hourlyRefreshKey, setHourlyRefreshKey] = useState(0);
  const [costOptRefreshKey, setCostOptRefreshKey] = useState(0);
  const configQuery = useQuery(() => api.getConfig(), [configRefreshKey]);
  const inventoryQuery = useQuery(() => api.getDataInventory(), [dailyRefreshKey]);
  const isSsoError = inventoryQuery.status === 'error' && inventoryQuery.error.message.includes('aws sso login');
  useEffect(() => {
    if (!isSsoError) return;
    const timer = setInterval(() => { setDailyRefreshKey(k => k + 1); }, 5_000);
    return () => { clearInterval(timer); };
  }, [isSsoError]);
  const [selected, setSelected] = useState(new Set<string>());
  const [hourlySelected, setHourlySelected] = useState(new Set<string>());
  const [costOptSelected, setCostOptSelected] = useState(new Set<string>());
  const [initialized, setInitialized] = useState(false);
  const [dailySyncState, setDailySyncState] = useState<SyncState>({ status: 'idle' });
  const [hourlySyncState, setHourlySyncState] = useState<SyncState>({ status: 'idle' });
  const [costOptSyncState, setCostOptSyncState] = useState<SyncState>({ status: 'idle' });

  // Track the previous server-side status per tier so the poller can detect a
  // syncing→completed/failed transition. Without it, a background auto-sync that
  // finishes between two ticks leaves the React state pinned to the last
  // 'syncing' value (the mapper used to return null for completed/failed,
  // skipping the setter entirely) and the inventory was never refreshed.
  const prevServerStatusRef = useRef<Record<'daily' | 'hourly' | 'cost-optimization', SyncStatus['status'] | null>>({
    daily: null,
    hourly: null,
    'cost-optimization': null,
  });

  useEffect(() => {
    let cancelled = false;
    function applyStatus(
      tier: 'daily' | 'hourly' | 'cost-optimization',
      setter: (s: SyncState) => void,
      bumpRefresh: () => void,
    ) {
      api.getSyncStatus(tier).then(s => {
        if (cancelled) return;
        const prev = prevServerStatusRef.current[tier];
        prevServerStatusRef.current[tier] = s.status;

        if (s.status === 'syncing') {
          const mapped = syncStatusToState(s);
          if (mapped !== null) setter(mapped);
          return;
        }
        // Only react to terminal states when we directly observed the
        // syncing→terminal transition in this session — otherwise a leftover
        // 'completed' from a prior session would keep flashing the "synced N
        // files" message every time the user opens this page.
        if (prev !== 'syncing') return;
        if (s.status === 'completed') {
          setter({ status: 'done', filesDownloaded: s.filesDownloaded });
          bumpRefresh();
        } else if (s.status === 'failed') {
          setter({ status: 'error', message: s.error.message });
        } else {
          setter({ status: 'idle' });
        }
      }).catch(() => undefined);
    }
    function tick() {
      applyStatus('daily', setDailySyncState, () => { setDailyRefreshKey(incrementKey); });
      applyStatus('hourly', setHourlySyncState, () => { setHourlyRefreshKey(incrementKey); });
      applyStatus('cost-optimization', setCostOptSyncState, () => { setCostOptRefreshKey(incrementKey); });
    }
    tick();
    const timer = setInterval(tick, 2_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [api]);

  const [showDeleteAll, setShowDeleteAll] = useState(false);
  const [showPrune, setShowPrune] = useState(false);
  const [pruneNotice, setPruneNotice] = useState<string | null>(null);
  const [configureSource, setConfigureSource] = useState<'daily' | 'hourly' | 'costOptimization' | null>(null);
  // Lightweight profile-only swap: a tiny modal that lists ~/.aws profiles
  // and rewrites only credentials.profile in costgoblin.yaml. Useful when
  // the current role lacks an IAM permission (e.g. ssm:GetParametersByPath)
  // and the user wants to retry with a different role without redoing the
  // bucket setup.
  const [showProfileSwap, setShowProfileSwap] = useState(false);

  const anySyncing = isSyncActive(dailySyncState) || isSyncActive(hourlySyncState) || isSyncActive(costOptSyncState);

  const inventory: DataInventoryResult | null =
    inventoryQuery.status === 'success' ? inventoryQuery.data : null;
  const config: CostGoblinConfig | null =
    configQuery.status === 'success' ? configQuery.data : null;
  const provider = config?.providers[0] ?? null;

  const retentionDays = provider?.sync.daily.retentionDays ?? 365;
  const dailyCutoffPeriod = retentionCutoffPeriod(retentionDays);

  const missingWithinRetention = missingWithinCutoff(inventory, dailyCutoffPeriod);

  useEffect(() => {
    if (!initialized && inventoryQuery.status === 'success' && missingWithinRetention.length > 0) {
      setSelected(new Set(missingWithinRetention.map(p => p.period)));
      setInitialized(true);
    }
  }, [initialized, inventoryQuery.status, missingWithinRetention]);

  function togglePeriod(period: string) {
    toggleInSet(setSelected, period);
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
    setDailySyncState({ status: 'downloading', filesDone: 0, filesTotal: selectedFiles.length, bytesDone: 0, bytesTotal: 0, message: '' });

    const pollInterval = setInterval(() => {
      api.getSyncStatus('daily').then((s) => {
        const mapped = syncStatusToState(s);
        if (mapped !== null) setDailySyncState(mapped);
      }).catch(() => { /* poll failure is transient */ });
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
    api.deleteLocalPeriod(period, 'daily').then(() => { setDailyRefreshKey(k => k + 1); }).catch(() => { /* deletion best-effort */ });
  }

  function handleDeleteHourly(period: string) {
    api.deleteLocalPeriod(period, 'hourly').then(() => { setHourlyRefreshKey(k => k + 1); }).catch(() => { /* deletion best-effort */ });
  }

  function handleDeleteAll() {
    const daily = (inventory?.periods ?? []).filter(p => p.localStatus === 'repartitioned');
    const hourly = (hourlyInventory?.periods ?? []).filter(p => p.localStatus === 'repartitioned');
    const costOpt = (costOptInventory?.periods ?? []).filter(p => p.localStatus === 'repartitioned');
    const promises: Promise<void>[] = [
      ...daily.map(p => api.deleteLocalPeriod(p.period, 'daily')),
      ...hourly.map(p => api.deleteLocalPeriod(p.period, 'hourly')),
      ...costOpt.map(p => api.deleteLocalPeriod(p.period, 'cost-optimization')),
    ];
    Promise.all(promises).then(() => {
      setDailyRefreshKey(k => k + 1);
      setHourlyRefreshKey(k => k + 1);
      setCostOptRefreshKey(k => k + 1);
      setShowDeleteAll(false);
    }).catch(() => { /* deletion best-effort */ });
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

  const hourlyRetentionDays = provider?.sync.hourly?.retentionDays ?? 30;
  const hourlyCutoffPeriod = retentionCutoffPeriod(hourlyRetentionDays);
  const hourlyMissing = missingWithinCutoff(hourlyInventory, hourlyCutoffPeriod);

  const costOptRetentionDays = provider?.sync.costOptimization?.retentionDays ?? 90;
  const costOptCutoffPeriod = retentionCutoffPeriod(costOptRetentionDays);
  const costOptMissing = missingWithinCutoff(costOptInventory, costOptCutoffPeriod);

  // Local periods that have fallen outside their tier's retention window. Mirrors
  // the backend's `periodsOutsideRetention` (period strictly older than the
  // cutoff month) — including its guard against a non-positive retention, so a
  // misconfigured `retentionDays: 0` is never treated as "everything expired".
  const prunable = (localPeriods: readonly string[] | undefined, cutoff: string, days: number): string[] =>
    Number.isFinite(days) && days > 0 ? (localPeriods ?? []).filter(p => p < cutoff) : [];
  const dailyPrunable = prunable(inventory?.local.periods, dailyCutoffPeriod, retentionDays);
  const hourlyPrunable = prunable(hourlyInventory?.local.periods, hourlyCutoffPeriod, hourlyRetentionDays);
  const costOptPrunable = prunable(costOptInventory?.local.periods, costOptCutoffPeriod, costOptRetentionDays);
  const prunableTotal = dailyPrunable.length + hourlyPrunable.length + costOptPrunable.length;

  const syncableTotal =
    syncableWithinCutoff(inventory, dailyCutoffPeriod).length +
    syncableWithinCutoff(hourlyInventory, hourlyCutoffPeriod).length +
    syncableWithinCutoff(costOptInventory, costOptCutoffPeriod).length;

  function handlePrune() {
    setShowPrune(false);
    void api.appendSyncLog('info', 'Manual prune — checking local data against retention…');
    api.pruneNow().then((result) => {
      setPruneNotice(
        result.deleted.length === 0
          ? 'Nothing to prune — all local data is within retention.'
          : `Pruned ${String(result.deleted.length)} period(s) outside retention.`,
      );
      // The data:prune handler logs the removals when there are any; narrate the
      // no-op case here so the click always leaves a trace in the activity log.
      if (result.deleted.length === 0) {
        void api.appendSyncLog('info', 'Prune — nothing outside the retention window');
      }
      setDailyRefreshKey(k => k + 1);
      setHourlyRefreshKey(k => k + 1);
      setCostOptRefreshKey(k => k + 1);
      setTimeout(() => { setPruneNotice(null); }, 6000);
    }).catch((err: unknown) => {
      void api.appendSyncLog('error', `Prune failed — ${err instanceof Error ? err.message : String(err)}`);
      setPruneNotice(`Prune failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  // On-demand counterpart to the auto-sync schedule: pull every tier's missing /
  // stale periods now. Runs tiers sequentially (like the scheduler) so concurrent
  // `aws s3 sync` processes don't contend; the 2s status poller above drives each
  // tier card's progress while a sync is in flight.
  async function handleSyncAll() {
    void api.appendSyncLog('info', 'Manual sync — checking S3 for new or updated data…');
    const tiers: {
      id: DataTier;
      cutoff: string;
      configured: boolean;
      setState: (s: SyncState) => void;
      bump: () => void;
    }[] = [
      { id: 'daily', cutoff: dailyCutoffPeriod, configured: dailyBucket !== null, setState: setDailySyncState, bump: () => { setDailyRefreshKey(k => k + 1); } },
      { id: 'hourly', cutoff: hourlyCutoffPeriod, configured: hourlyBucket !== null, setState: setHourlySyncState, bump: () => { setHourlyRefreshKey(k => k + 1); } },
      { id: 'cost-optimization', cutoff: costOptCutoffPeriod, configured: costOptBucket !== null, setState: setCostOptSyncState, bump: () => { setCostOptRefreshKey(k => k + 1); } },
    ];
    for (const tier of tiers) {
      if (!tier.configured) continue;
      // Re-check S3 now rather than trusting the inventory snapshot the disabled
      // state was derived from — a manual Sync should always reflect what's
      // actually on S3 and pull anything missing or out of date.
      let fresh: DataInventoryResult;
      try {
        fresh = await api.getDataInventory(tier.id);
      } catch (err: unknown) {
        // S3 unreachable / creds expired — surface it instead of skipping silently.
        void api.appendSyncLog('warn', `${tier.id}: S3 check failed — ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const files = syncableWithinCutoff(fresh, tier.cutoff).flatMap(p => [...p.files]);
      if (files.length === 0) {
        void api.appendSyncLog('info', `${tier.id}: up to date`);
        continue;
      }
      tier.setState({ status: 'downloading', filesDone: 0, filesTotal: files.length, bytesDone: 0, bytesTotal: 0, message: '' });
      try {
        const result = await api.syncPeriods(files, tier.id);
        tier.setState({ status: 'done', filesDownloaded: result.filesDownloaded });
        tier.bump();
      } catch (err: unknown) {
        tier.setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  const [hourlyInitialized, setHourlyInitialized] = useState(false);
  useEffect(() => {
    if (!hourlyInitialized && hourlyInventoryQuery.status === 'success' && hourlyMissing.length > 0) {
      setHourlySelected(new Set(hourlyMissing.map(p => p.period)));
      setHourlyInitialized(true);
    }
  }, [hourlyInitialized, hourlyInventoryQuery.status, hourlyMissing]);

  const [costOptInitialized, setCostOptInitialized] = useState(false);
  useEffect(() => {
    if (!costOptInitialized && costOptInventoryQuery.status === 'success' && costOptMissing.length > 0) {
      setCostOptSelected(new Set(costOptMissing.map(p => p.period)));
      setCostOptInitialized(true);
    }
  }, [costOptInitialized, costOptInventoryQuery.status, costOptMissing]);

  function toggleHourlyPeriod(period: string) {
    toggleInSet(setHourlySelected, period);
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
    setHourlySyncState({ status: 'downloading', filesDone: 0, filesTotal: selectedFiles.length, bytesDone: 0, bytesTotal: 0, message: '' });

    const pollInterval = setInterval(() => {
      api.getSyncStatus('hourly').then((s) => {
        const mapped = syncStatusToState(s);
        if (mapped !== null) setHourlySyncState(mapped);
      }).catch(() => { /* poll failure is transient */ });
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
    toggleInSet(setCostOptSelected, period);
  }

  function selectAllCostOpt() {
    setCostOptSelected(new Set(costOptMissing.map(p => p.period)));
  }

  function deselectAllCostOpt() {
    setCostOptSelected(new Set());
  }

  function handleDeleteCostOpt(period: string) {
    api.deleteLocalPeriod(period, 'cost-optimization').then(() => { setCostOptRefreshKey(k => k + 1); }).catch(() => { /* deletion best-effort */ });
  }

  async function handleCostOptSync() {
    const selectedFiles = (costOptInventory?.periods ?? [])
      .filter(p => costOptSelected.has(p.period))
      .flatMap(p => [...p.files]);
    if (selectedFiles.length === 0) return;
    setCostOptSyncState({ status: 'downloading', filesDone: 0, filesTotal: selectedFiles.length, bytesDone: 0, bytesTotal: 0, message: '' });

    const pollInterval = setInterval(() => {
      api.getSyncStatus('cost-optimization').then((s) => {
        const mapped = syncStatusToState(s);
        if (mapped !== null) setCostOptSyncState(mapped);
      }).catch(() => { /* poll failure is transient */ });
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
                  onClick={() => { api.scaffoldConfig().catch(() => undefined); }}
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
          <button
            type="button"
            onClick={() => { handleSyncAll().catch(() => undefined); }}
            disabled={anySyncing}
            title={anySyncing ? 'Sync in progress…' : syncableTotal === 0 ? 'Re-check S3 and download any new or updated data' : `Sync ${String(syncableTotal)} period(s) that are missing or out of date`}
            className="rounded-md border border-border bg-bg-tertiary/50 px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-tertiary hover:text-text-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {syncableTotal === 0 ? 'Sync' : `Sync (${String(syncableTotal)})`}
          </button>
          <button
            type="button"
            onClick={() => { setShowPrune(true); }}
            title={prunableTotal === 0 ? 'Re-check local data and remove anything outside the retention window' : `Delete ${String(prunableTotal)} period(s) outside the retention window`}
            className="rounded-md border border-border bg-bg-tertiary/50 px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-tertiary hover:text-text-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {prunableTotal === 0 ? 'Prune' : `Prune (${String(prunableTotal)})`}
          </button>
          <button
            type="button"
            onClick={() => { setShowProfileSwap(true); }}
            className="rounded-md border border-border bg-bg-tertiary/50 px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-tertiary hover:text-text-primary transition-colors"
            title={awsProfile === null ? 'Pick the AWS profile to use' : `Currently using profile: ${awsProfile}`}
          >
            Change AWS Profile
          </button>
          <button
            type="button"
            onClick={() => { setShowDeleteAll(true); }}
            className="rounded-md border border-negative/50 bg-negative-muted px-3 py-1.5 text-xs font-medium text-negative hover:bg-negative-muted hover:text-negative transition-colors"
          >
            Delete All Data
          </button>
          <button type="button" onClick={() => { api.openDataFolder().catch(() => undefined); }} className="rounded-md border border-border bg-bg-tertiary/50 px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-tertiary hover:text-text-primary transition-colors">
            Open Folder
          </button>
          <button type="button" onClick={() => { setDailyRefreshKey(k => k + 1); setHourlyRefreshKey(k => k + 1); setCostOptRefreshKey(k => k + 1); }} className="rounded-md border border-border bg-bg-tertiary/50 px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-tertiary hover:text-text-primary transition-colors">
            Refresh
          </button>
        </div>
      </div>

      {pruneNotice !== null && (
        <div className="rounded-lg border border-accent/50 bg-positive-muted px-4 py-2 text-xs text-accent">
          {pruneNotice}
        </div>
      )}

      {/* Automatic schedule — drives the background auto-sync + auto-prune, so
          it lives with the rest of the Data & Sync controls rather than the
          top toolbar. */}
      <div className="flex items-center justify-between rounded-xl border border-border bg-bg-secondary/50 px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">Automatic schedule</h3>
          <p className="text-xs text-text-muted mt-0.5">
            Run sync (and optionally prune) in the background on a fixed cadence. The interval drives both and is disabled while both are off.
          </p>
        </div>
        <SchedulerControls />
      </div>

      {/* Account mapping */}
      <OrgAccountsSection profile={awsProfile} />

      {/* Region names enrichment — independent of Org sync */}
      <SsmParameterSection profile={awsProfile} />

      {inventoryQuery.status === 'loading' && !anySyncing && (
        <div className="rounded-xl border border-border bg-bg-secondary/50 p-12 text-center text-text-secondary">
          Checking S3 for available data...
        </div>
      )}

      {inventoryQuery.status === 'error' && (
        <div className="rounded-lg border border-negative/50 bg-negative-muted px-4 py-3">
          <p className="text-sm font-medium text-negative">{inventoryQuery.error.message}</p>
          {inventoryQuery.error.message.includes('aws sso login') && awsProfile !== null && (
            <SsoLoginButton profile={awsProfile} />
          )}
        </div>
      )}

      {/* Two-column tier layout — show immediately if a sync is running */}
      {(inventory !== null || anySyncing) && (
        <div className="flex gap-5">
          <TierPanel
            title="Daily"
            configured={dailyBucket !== null}
            bucket={dailyBucket}
            retentionDays={dailyRetention}
            localPeriods={inventory?.local.periods ?? []}
            diskBytes={inventory?.local.diskBytes ?? 0}
            oldestPeriod={inventory?.local.oldestPeriod ?? null}
            newestPeriod={inventory?.local.newestPeriod ?? null}
            lastSync={inventory?.lastSync ?? null}
            periods={inventory === null ? [] : [...inventory.periods]}
            selected={selected}
            onToggle={togglePeriod}
            onSelectAll={selectAll}
            onDeselectAll={deselectAll}
            onDownload={() => { handleSync().catch(() => undefined); }}
            onDeletePeriod={handleDeleteDaily}
            syncState={dailySyncState}
            onCancelSync={() => { api.cancelSync('daily').catch(() => undefined); setDailySyncState({ status: 'idle' }); }}
            onConfigure={() => { setConfigureSource('daily'); }}

          />
          <TierPanel
            title="Hourly"
            configured={hourlyBucket !== null}
            bucket={hourlyBucket}
            retentionDays={hourlyRetention}
            localPeriods={hourlyInventory?.local.periods ?? []}
            diskBytes={hourlyInventory?.local.diskBytes ?? 0}
            oldestPeriod={hourlyInventory?.local.oldestPeriod ?? null}
            newestPeriod={hourlyInventory?.local.newestPeriod ?? null}
            lastSync={hourlyInventory?.lastSync ?? null}
            periods={hourlyInventory === null ? [] : [...hourlyInventory.periods]}
            selected={hourlySelected}
            onToggle={toggleHourlyPeriod}
            onSelectAll={selectAllHourly}
            onDeselectAll={deselectAllHourly}
            onDownload={() => { handleHourlySync().catch(() => undefined); }}
            onDeletePeriod={handleDeleteHourly}
            syncState={hourlySyncState}
            onCancelSync={() => { api.cancelSync('hourly').catch(() => undefined); setHourlySyncState({ status: 'idle' }); }}
            onConfigure={() => { setConfigureSource('hourly'); }}

          />
          <TierPanel
            title="Cost Optimization"
            configured={costOptBucket !== null}
            bucket={costOptBucket}
            retentionDays={costOptRetention}
            localPeriods={costOptInventory?.local.periods ?? []}
            diskBytes={costOptInventory?.local.diskBytes ?? 0}
            oldestPeriod={costOptInventory?.local.oldestPeriod ?? null}
            newestPeriod={costOptInventory?.local.newestPeriod ?? null}
            lastSync={costOptInventory?.lastSync ?? null}
            periods={costOptInventory === null ? [] : [...costOptInventory.periods]}
            selected={costOptSelected}
            onToggle={toggleCostOptPeriod}
            onSelectAll={selectAllCostOpt}
            onDeselectAll={deselectAllCostOpt}
            onDownload={() => { handleCostOptSync().catch(() => undefined); }}
            onDeletePeriod={handleDeleteCostOpt}
            syncState={costOptSyncState}
            onCancelSync={() => { api.cancelSync('cost-optimization').catch(() => undefined); setCostOptSyncState({ status: 'idle' }); }}
            onConfigure={() => { setConfigureSource('costOptimization'); }}

          />
        </div>
      )}

      <SyncLogPanel active={anySyncing} />

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

      {showPrune && (
        <ConfirmModal
          title="Prune old data"
          message={prunableTotal === 0
            ? "Re-check local data and remove anything that falls outside each tier's retention window? This data can be re-downloaded from S3 anytime."
            : `Remove ${String(prunableTotal)} local period(s) that fall outside each tier's retention window? This data can be re-downloaded from S3 anytime.`}
          confirmLabel="Prune"
          destructive
          onConfirm={handlePrune}
          onCancel={() => { setShowPrune(false); }}
        />
      )}

      {configureSource !== null && awsProfile !== null && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={(e) => { if (e.target === e.currentTarget) setConfigureSource(null); }} aria-hidden="true">
          <div className="relative">
            <button type="button" onClick={() => { setConfigureSource(null); }} className="absolute -top-2 -right-2 z-10 rounded-full bg-bg-tertiary border border-border w-7 h-7 flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-bg-secondary transition-colors" title="Close">
              &#10005;
            </button>
            <SetupWizard
              source={configureSource}
              profile={awsProfile}
              onComplete={() => { setConfigureSource(null); setConfigRefreshKey(k => k + 1); setDailyRefreshKey(k => k + 1); setHourlyRefreshKey(k => k + 1); setCostOptRefreshKey(k => k + 1); }}
            />
          </div>
        </div>
      )}

      {showProfileSwap && (
        <ProfileSwapModal
          currentProfile={awsProfile}
          onClose={() => { setShowProfileSwap(false); }}
          onSaved={() => { setShowProfileSwap(false); setConfigRefreshKey(k => k + 1); setDailyRefreshKey(k => k + 1); setHourlyRefreshKey(k => k + 1); setCostOptRefreshKey(k => k + 1); }}
        />
      )}
    </div>
  );
}

function ProfileSwapModal({ currentProfile, onClose, onSaved }: Readonly<{
  currentProfile: string | null;
  onClose: () => void;
  onSaved: () => void;
}>) {
  const api = useCostApi();
  const profilesQuery = useQuery(() => api.listAwsProfiles(), []);
  const [selected, setSelected] = useState(currentProfile ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const profiles = profilesQuery.status === 'success' ? profilesQuery.data : [];

  async function handleSave(): Promise<void> {
    if (selected.length === 0 || selected === currentProfile) return;
    setSaving(true);
    setError(null);
    try {
      await api.updateAwsProfile(selected);
      onSaved();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} aria-hidden="true">
      <div className="relative rounded-xl border border-border bg-bg-secondary p-6 shadow-2xl max-w-md w-full">
        <h3 className="text-base font-semibold text-text-primary">Change AWS Profile</h3>
        <p className="text-xs text-text-muted mt-1">
          Buckets and other config stay as-is — this only swaps the profile used to talk to AWS.
        </p>

        {profilesQuery.status === 'loading' && (
          <p className="text-sm text-text-secondary mt-4">Loading profiles…</p>
        )}
        {profilesQuery.status === 'error' && (
          <p className="text-sm text-negative mt-4">{profilesQuery.error.message}</p>
        )}
        {profilesQuery.status === 'success' && profiles.length === 0 && (
          <p className="text-sm text-warning mt-4">No AWS profiles found in ~/.aws.</p>
        )}
        {profilesQuery.status === 'success' && profiles.length > 0 && (
          <div className="mt-4">
            <ProfilePicker
              profiles={profiles}
              selected={selected}
              onSelect={setSelected}
              currentProfile={currentProfile ?? undefined}
              listClassName="max-h-64"
              autoFocus
            />
          </div>
        )}

        {error !== null && (
          <p className="text-xs text-negative mt-3">{error}</p>
        )}

        <div className="flex items-center justify-end gap-2 mt-5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-text-secondary hover:bg-bg-tertiary transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => { handleSave().catch(() => undefined); }}
            disabled={saving || selected.length === 0 || selected === currentProfile}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
