import { useState, useEffect } from 'react';
import type { DataInventoryResult, CostGoblinConfig } from '@costgoblin/core/browser';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { ConfirmModal } from '../components/confirm-modal.js';
import { SetupWizard } from './setup-wizard.js';
import { OrgAccountsSection } from './data-management-org.js';
import { SsmParameterSection } from './data-management-ssm.js';
import { TierPanel, type SyncState } from './data-management-tier.js';
import { RecentFileActivity } from './recent-file-activity.js';

export function DataManagement() {
  const api = useCostApi();
  const [configRefreshKey, setConfigRefreshKey] = useState(0);
  const [dailyRefreshKey, setDailyRefreshKey] = useState(0);
  const [hourlyRefreshKey, setHourlyRefreshKey] = useState(0);
  const [costOptRefreshKey, setCostOptRefreshKey] = useState(0);
  const configQuery = useQuery(() => api.getConfig(), [configRefreshKey]);
  const inventoryQuery = useQuery(() => api.getDataInventory(), [dailyRefreshKey]);
  const [selected, setSelected] = useState(new Set<string>());
  const [hourlySelected, setHourlySelected] = useState(new Set<string>());
  const [costOptSelected, setCostOptSelected] = useState(new Set<string>());
  const [initialized, setInitialized] = useState(false);
  const [dailySyncState, setDailySyncState] = useState<SyncState>({ status: 'idle' });
  const [hourlySyncState, setHourlySyncState] = useState<SyncState>({ status: 'idle' });
  const [costOptSyncState, setCostOptSyncState] = useState<SyncState>({ status: 'idle' });
  const autoSyncQuery = useQuery(() => api.getAutoSyncEnabled(), []);
  const [autoSync, setAutoSync] = useState(false);
  const [autoSyncLoaded, setAutoSyncLoaded] = useState(false);

  if (!autoSyncLoaded && autoSyncQuery.status === 'success') {
    setAutoSyncLoaded(true);
    setAutoSync(autoSyncQuery.data);
  }
  const [showDeleteAll, setShowDeleteAll] = useState(false);
  const [configureSource, setConfigureSource] = useState<'daily' | 'hourly' | 'costOptimization' | null>(null);
  // Lightweight profile-only swap: a tiny modal that lists ~/.aws profiles
  // and rewrites only credentials.profile in costgoblin.yaml. Useful when
  // the current role lacks an IAM permission (e.g. ssm:GetParametersByPath)
  // and the user wants to retry with a different role without redoing the
  // bucket setup.
  const [showProfileSwap, setShowProfileSwap] = useState(false);
  const [optimizerBusy, setOptimizerBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function tick(): Promise<void> {
      try {
        const s = await api.getOptimizeStatus();
        // Only block deletes while workers are actually touching files.
        // A paused optimizer with a pending queue is safe — if the user
        // deletes a queued file, the worker will just skip it on resume.
        if (!cancelled) setOptimizerBusy(s.running);
      } catch { /* transient */ }
    }
    void tick();
    const timer = setInterval(() => { void tick(); }, 1500);
    return () => { cancelled = true; clearInterval(timer); };
  }, [api]);

  const deleteDisabledTitle = optimizerBusy
    ? 'Optimizer is running — pause it on the Local optimizer panel to delete data.'
    : undefined;

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

  useEffect(() => {
    if (!initialized && inventoryQuery.status === 'success' && missingWithinRetention.length > 0) {
      setSelected(new Set(missingWithinRetention.map(p => p.period)));
      setInitialized(true);
    }
  }, [initialized, inventoryQuery.status, missingWithinRetention]);

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
    void api.deleteLocalPeriod(period, 'daily').then(() => { setDailyRefreshKey(k => k + 1); }).catch(() => { /* deletion best-effort */ });
  }

  function handleDeleteHourly(period: string) {
    void api.deleteLocalPeriod(period, 'hourly').then(() => { setHourlyRefreshKey(k => k + 1); }).catch(() => { /* deletion best-effort */ });
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
    void Promise.all(promises).then(() => {
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
  const hourlyRetentionCutoff = new Date(Date.now() - hourlyRetentionDays * 24 * 60 * 60 * 1000);
  const hourlyRetentionCutoffPeriod = `${String(hourlyRetentionCutoff.getFullYear())}-${String(hourlyRetentionCutoff.getMonth() + 1).padStart(2, '0')}`;
  const hourlyMissing = (hourlyInventory?.periods.filter(p => p.localStatus === 'missing') ?? []).filter(p => p.period >= hourlyRetentionCutoffPeriod);

  const costOptRetentionDays = provider?.sync.costOptimization?.retentionDays ?? 90;
  const costOptRetentionCutoff = new Date(Date.now() - costOptRetentionDays * 24 * 60 * 60 * 1000);
  const costOptRetentionCutoffPeriod = `${String(costOptRetentionCutoff.getFullYear())}-${String(costOptRetentionCutoff.getMonth() + 1).padStart(2, '0')}`;
  const costOptMissing = (costOptInventory?.periods.filter(p => p.localStatus === 'missing') ?? []).filter(p => p.period >= costOptRetentionCutoffPeriod);

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
    void api.deleteLocalPeriod(period, 'cost-optimization').then(() => { setCostOptRefreshKey(k => k + 1); }).catch(() => { /* deletion best-effort */ });
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
              onClick={() => { const next = !autoSync; setAutoSync(next); void api.setAutoSyncEnabled(next); }}
              className={['relative h-5 w-9 rounded-full transition-colors', autoSync ? 'bg-accent' : 'bg-bg-tertiary'].join(' ')}
            >
              <span className={['absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform', autoSync ? 'translate-x-4' : 'translate-x-0'].join(' ')} />
            </button>
          </div>
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
            disabled={optimizerBusy}
            title={deleteDisabledTitle}
            className="rounded-md border border-negative/50 bg-negative-muted px-3 py-1.5 text-xs font-medium text-negative hover:bg-negative-muted hover:text-negative transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
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
      <OrgAccountsSection profile={awsProfile} />

      {/* SSM Parameter Store enrichment data — independent of Org sync */}
      <SsmParameterSection profile={awsProfile} />

      {inventoryQuery.status === 'loading' && (
        <div className="rounded-xl border border-border bg-bg-secondary/50 p-12 text-center text-text-secondary">
          Checking S3 for available data...
        </div>
      )}

      {inventoryQuery.status === 'error' && (
        <div className="rounded-lg border border-negative/50 bg-negative-muted px-4 py-3">
          <p className="text-sm font-medium text-negative">{inventoryQuery.error.message}</p>
          {inventoryQuery.error.message.includes('aws sso login') && (
            <p className="text-xs text-text-secondary mt-1">Refresh this page after logging in.</p>
          )}
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
            localPeriods={inventory.local.periods}
            diskBytes={inventory.local.diskBytes}
            oldestPeriod={inventory.local.oldestPeriod}
            newestPeriod={inventory.local.newestPeriod}
            periods={[...inventory.periods]}
            selected={selected}
            onToggle={togglePeriod}
            onSelectAll={selectAll}
            onDeselectAll={deselectAll}
            onDownload={() => { void handleSync(); }}
            onDeletePeriod={handleDeleteDaily}
            syncState={dailySyncState}
            onCancelSync={() => { void api.cancelSync('daily'); setDailySyncState({ status: 'idle' }); }}
            onConfigure={() => { setConfigureSource('daily'); }}
            deleteDisabled={optimizerBusy}
            deleteDisabledTitle={deleteDisabledTitle}
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
            deleteDisabled={optimizerBusy}
            deleteDisabledTitle={deleteDisabledTitle}
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
            deleteDisabled={optimizerBusy}
            deleteDisabledTitle={deleteDisabledTitle}
          />
        </div>
      )}

      <RecentFileActivity />

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
          <div className="mt-4 flex flex-col gap-2 max-h-64 overflow-y-auto">
            {profiles.map(p => (
              <label key={p} className="flex items-center gap-2 rounded border border-border bg-bg-primary px-3 py-2 cursor-pointer hover:border-accent">
                <input
                  type="radio"
                  name="profile"
                  value={p}
                  checked={selected === p}
                  onChange={() => { setSelected(p); }}
                />
                <span className="text-sm text-text-primary">{p}</span>
                {p === currentProfile && (
                  <span className="ml-auto text-[10px] text-text-muted uppercase tracking-wider">Current</span>
                )}
              </label>
            ))}
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
            onClick={() => { void handleSave(); }}
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
