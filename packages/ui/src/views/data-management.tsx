import { useCallback, useState, useEffect, useRef } from 'react';
import type { DataInventoryResult, DataTier, CostGoblinConfig, ProviderConfig, SyncStatus } from '@costgoblin/core/browser';
import { GCLOUD_ADC_LOGIN_COMMAND, GCLOUD_CLI_LOGIN_COMMAND } from '@costgoblin/core/browser';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { ConfirmModal } from '../components/confirm-modal.js';
import { ProfilePicker } from '../components/profile-picker.js';
import { SetupWizard } from './setup-wizard.js';
import { OrgAccountsSection } from './data-management-org.js';
import { SsmParameterSection } from './data-management-ssm.js';
import { TierPanel, type SyncState } from './data-management-tier.js';
import { SyncLogPanel } from './data-management-logs.js';
import { GcloudLoginButton, RetryButton, SsoLoginButton } from '../components/sso-login-button.js';
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

/** Composite syncId addressing one (provider, tier) — see CostApi. */
function syncIdFor(provider: string, tier: DataTier): string {
  return `${provider}:${tier}`;
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

// Local periods that have fallen outside their tier's retention window. Mirrors
// the backend's `periodsOutsideRetention` (period strictly older than the
// cutoff month) — including its guard against a non-positive retention, so a
// misconfigured `retentionDays: 0` is never treated as "everything expired".
function prunable(localPeriods: readonly string[] | undefined, cutoff: string, days: number): string[] {
  return Number.isFinite(days) && days > 0 ? (localPeriods ?? []).filter(p => p < cutoff) : [];
}

/** Per-provider activity the sections report up so the global header can show
 *  Sync/Prune counts and disable Sync while anything is in flight. */
interface ProviderCounts {
  readonly syncable: number;
  readonly prunableCount: number;
  readonly syncing: boolean;
}

/** The configured tiers of one provider, with everything the sync/prune/delete
 *  flows need. One place for the tier trio so the global actions and the
 *  per-provider sections can never disagree on cutoffs. */
function configuredTiers(provider: ProviderConfig): { id: DataTier; cutoff: string; retentionDays: number }[] {
  const tiers: { id: DataTier; cutoff: string; retentionDays: number }[] = [];
  const daily = provider.sync.daily;
  tiers.push({ id: 'daily', cutoff: retentionCutoffPeriod(daily.retentionDays), retentionDays: daily.retentionDays });
  if (provider.sync.hourly !== undefined) {
    tiers.push({ id: 'hourly', cutoff: retentionCutoffPeriod(provider.sync.hourly.retentionDays), retentionDays: provider.sync.hourly.retentionDays });
  }
  if (provider.sync.costOptimization !== undefined) {
    tiers.push({ id: 'cost-optimization', cutoff: retentionCutoffPeriod(provider.sync.costOptimization.retentionDays), retentionDays: provider.sync.costOptimization.retentionDays });
  }
  return tiers;
}

export function DataManagement() {
  const api = useCostApi();
  const [configRefreshKey, setConfigRefreshKey] = useState(0);
  // Bumped by the global Refresh / Prune / Delete All actions; every provider
  // section folds it into its inventory query deps.
  const [refreshSignal, setRefreshSignal] = useState(0);
  const configQuery = useQuery(() => api.getConfig(), [configRefreshKey]);

  const [showDeleteAll, setShowDeleteAll] = useState(false);
  const [showPrune, setShowPrune] = useState(false);
  const [pruneNotice, setPruneNotice] = useState<string | null>(null);
  const [addProviderOpen, setAddProviderOpen] = useState(false);
  const [syncAllRunning, setSyncAllRunning] = useState(false);

  const [counts, setCounts] = useState<ReadonlyMap<string, ProviderCounts>>(new Map());
  const onCounts = useCallback((provider: string, next: ProviderCounts) => {
    setCounts(prev => {
      const existing = prev.get(provider);
      if (existing !== undefined
        && existing.syncable === next.syncable
        && existing.prunableCount === next.prunableCount
        && existing.syncing === next.syncing) {
        return prev;
      }
      const map = new Map(prev);
      map.set(provider, next);
      return map;
    });
  }, []);

  const config: CostGoblinConfig | null =
    configQuery.status === 'success' ? configQuery.data : null;
  const providers = config?.providers ?? [];

  const isNotConfigured = configQuery.status === 'error'
    || (configQuery.status === 'success' && providers.length === 0);

  // Sum ONLY over currently-configured providers — a removed provider's last
  // report would otherwise linger in the map as phantom counts (or hold the
  // Sync button disabled forever if it was mid-sync when removed).
  const liveCounts = providers
    .map(p => counts.get(String(p.name)))
    .filter((c): c is ProviderCounts => c !== undefined);
  const syncableTotal = liveCounts.reduce((sum, c) => sum + c.syncable, 0);
  const prunableTotal = liveCounts.reduce((sum, c) => sum + c.prunableCount, 0);
  const anySyncing = syncAllRunning || liveCounts.some(c => c.syncing);

  function bumpAll(): void {
    setRefreshSignal(k => k + 1);
  }

  function onConfigChanged(): void {
    setConfigRefreshKey(k => k + 1);
    setRefreshSignal(k => k + 1);
  }

  // On-demand counterpart to the auto-sync schedule: pull every provider's and
  // tier's missing / stale periods now. Runs sequentially (like the scheduler)
  // so concurrent `aws s3 sync` processes don't contend; each section's 2s
  // status poller picks the server-side progress up and drives its tier cards.
  async function handleSyncAll() {
    setSyncAllRunning(true);
    void api.appendSyncLog('info', 'Manual sync — checking S3 for new or updated data…');
    try {
      for (const provider of providers) {
        const name = String(provider.name);
        for (const tier of configuredTiers(provider)) {
          // Re-check S3 now rather than trusting the inventory snapshot the
          // disabled state was derived from — a manual Sync should always
          // reflect what's actually on S3.
          let fresh: DataInventoryResult;
          try {
            fresh = await api.getDataInventory(tier.id, name);
          } catch (err: unknown) {
            void api.appendSyncLog('warn', `${name}/${tier.id}: S3 check failed — ${err instanceof Error ? err.message : String(err)}`);
            continue;
          }
          const files = syncableWithinCutoff(fresh, tier.cutoff).flatMap(p => [...p.files]);
          if (files.length === 0) {
            void api.appendSyncLog('info', `${name}/${tier.id}: up to date`);
            continue;
          }
          try {
            await api.syncPeriods(files, syncIdFor(name, tier.id));
          } catch (err: unknown) {
            void api.appendSyncLog('error', `${name}/${tier.id}: sync failed — ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    } finally {
      setSyncAllRunning(false);
      bumpAll();
    }
  }

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
      bumpAll();
      setTimeout(() => { setPruneNotice(null); }, 6000);
    }).catch((err: unknown) => {
      void api.appendSyncLog('error', `Prune failed — ${err instanceof Error ? err.message : String(err)}`);
      setPruneNotice(`Prune failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  // Deletes every provider's downloaded periods. Re-fetches each inventory
  // fresh so the deletion set can't be stale.
  async function handleDeleteAll() {
    const deletions: Promise<void>[] = [];
    for (const provider of providers) {
      const name = String(provider.name);
      for (const tier of configuredTiers(provider)) {
        try {
          const inv = await api.getDataInventory(tier.id, name);
          for (const p of inv.periods.filter(p => p.localStatus === 'repartitioned')) {
            deletions.push(api.deleteLocalPeriod(p.period, tier.id, name));
          }
        } catch { /* provider unreachable — skip its tiers */ }
      }
    }
    Promise.all(deletions).then(() => {
      bumpAll();
      setShowDeleteAll(false);
    }).catch(() => { /* deletion best-effort */ });
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
                  Generate config templates &amp; open folder
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
            onClick={() => { setAddProviderOpen(true); }}
            title="Configure an additional billing source (e.g. a second AWS payer account)"
            className="rounded-md border border-border bg-bg-tertiary/50 px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-tertiary hover:text-text-primary transition-colors"
          >
            Add Provider
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
          <button type="button" onClick={bumpAll} className="rounded-md border border-border bg-bg-tertiary/50 px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-tertiary hover:text-text-primary transition-colors">
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

      {/* One section per configured provider. */}
      {providers.map(provider => (
        <ProviderSection
          key={String(provider.name)}
          provider={provider}
          soleProvider={providers.length === 1}
          refreshSignal={refreshSignal}
          onCounts={onCounts}
          onConfigChanged={onConfigChanged}
          onOrgDataChanged={bumpAll}
        />
      ))}

      {/* Region names enrichment — provider-independent (AWS region metadata
          is global), so one section fed by the first AWS provider's profile.
          Not `providers[0]`: that slot may hold a GCP provider, which has no
          profile and no SSM to read. */}
      <SsmParameterSection profile={providers.find(p => p.type === 'aws')?.credentialsProfile ?? null} />

      <SyncLogPanel active={anySyncing} />

      {showDeleteAll && (
        <ConfirmModal
          title="Delete all local data"
          message="This will remove all downloaded and repartitioned data from your machine. You can re-download it from S3 anytime."
          confirmLabel="Delete All"
          destructive
          onConfirm={() => { handleDeleteAll().catch(() => undefined); }}
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

      {addProviderOpen && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={(e) => { if (e.target === e.currentTarget) setAddProviderOpen(false); }} aria-hidden="true">
          <div className="relative">
            <button type="button" onClick={() => { setAddProviderOpen(false); }} className="absolute -top-2 -right-2 z-10 rounded-full bg-bg-tertiary border border-border w-7 h-7 flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-bg-secondary transition-colors" title="Close">
              &#10005;
            </button>
            <SetupWizard
              mode="add"
              onComplete={() => { setAddProviderOpen(false); onConfigChanged(); }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

interface ProviderSectionProps {
  readonly provider: ProviderConfig;
  /** With a single provider the section header stays slim — the page should
   *  read like the pre-#516 single-provider layout. */
  readonly soleProvider: boolean;
  readonly refreshSignal: number;
  readonly onCounts: (provider: string, counts: ProviderCounts) => void;
  readonly onConfigChanged: () => void;
  /** Org sync/clear changed the SHARED merged lookups — refresh siblings. */
  readonly onOrgDataChanged: () => void;
}

function ProviderSection({ provider, soleProvider, refreshSignal, onCounts, onConfigChanged, onOrgDataChanged }: ProviderSectionProps) {
  const api = useCostApi();
  const name = String(provider.name);
  const awsProfile = provider.type === 'aws' ? provider.credentialsProfile : null;

  const [dailyRefreshKey, setDailyRefreshKey] = useState(0);
  const [hourlyRefreshKey, setHourlyRefreshKey] = useState(0);
  const [costOptRefreshKey, setCostOptRefreshKey] = useState(0);

  const inventoryQuery = useQuery(() => api.getDataInventory('daily', name), [name, dailyRefreshKey, refreshSignal]);
  // Poll while a credential error is showing, so the panel heals itself once
  // the user finishes signing in. Every provider's message, not just AWS's:
  // sniffing only `aws sso login` left a GCP user staring at a stale expired-
  // credentials error after a successful re-login, until they navigated away
  // and back — while the AWS flow recovered in five seconds.
  const credentialErrorMessage = inventoryQuery.status === 'error' ? inventoryQuery.error.message : '';
  const isCredentialError = ['aws sso login', GCLOUD_ADC_LOGIN_COMMAND, GCLOUD_CLI_LOGIN_COMMAND]
    .some(cmd => credentialErrorMessage.includes(cmd));
  useEffect(() => {
    if (!isCredentialError) return;
    const timer = setInterval(() => { setDailyRefreshKey(k => k + 1); }, 5_000);
    return () => { clearInterval(timer); };
  }, [isCredentialError]);
  // The poll above heals the panel on its own, but only on its next tick — the
  // login buttons still get an explicit Retry so a user who has just finished
  // signing in isn't left watching a stale error.
  //
  // All three tiers, not just the one whose error is on screen: expired
  // credentials fail every query, but only daily's error is rendered, so
  // refreshing daily alone healed the panel while the hourly and cost-opt
  // tiers stayed stuck and drew themselves as "0 periods".
  const retryInventory = (): void => {
    setDailyRefreshKey(k => k + 1);
    setHourlyRefreshKey(k => k + 1);
    setCostOptRefreshKey(k => k + 1);
  };

  // Which sign-in, if any, this error has a one-click remedy for. Hoisted out
  // of the JSX so the panel can tell "no remedy" from "no button" and still
  // offer a bare Retry — an Access Denied or a dropped connection stranded the
  // user exactly as badly as an expired token did.
  const awsSsoRemedy = awsProfile !== null && credentialErrorMessage.includes('aws sso login');
  const gcpAdcRemedy = provider.type === 'gcp' && credentialErrorMessage.includes(GCLOUD_ADC_LOGIN_COMMAND);
  // Both GCP commands, not just ADC: a stale gcloud CLI account is reported
  // with `gcloud auth login`, which is not a substring of the ADC command — so
  // matching only ADC left the one error with a one-click remedy showing no
  // button, and re-running ADC could never have fixed it anyway.
  const gcpCliRemedy = provider.type === 'gcp' && !gcpAdcRemedy && credentialErrorMessage.includes(GCLOUD_CLI_LOGIN_COMMAND);

  const [selected, setSelected] = useState(new Set<string>());
  const [hourlySelected, setHourlySelected] = useState(new Set<string>());
  const [costOptSelected, setCostOptSelected] = useState(new Set<string>());
  const [initialized, setInitialized] = useState(false);
  const [hourlyInitialized, setHourlyInitialized] = useState(false);
  const [costOptInitialized, setCostOptInitialized] = useState(false);
  const [dailySyncState, setDailySyncState] = useState<SyncState>({ status: 'idle' });
  const [hourlySyncState, setHourlySyncState] = useState<SyncState>({ status: 'idle' });
  const [costOptSyncState, setCostOptSyncState] = useState<SyncState>({ status: 'idle' });

  const [configureSource, setConfigureSource] = useState<'daily' | 'hourly' | 'costOptimization' | null>(null);
  // Lightweight profile-only swap: a tiny modal that lists ~/.aws profiles
  // and rewrites only THIS provider's credentialsProfile in costgoblin.yaml.
  const [showProfileSwap, setShowProfileSwap] = useState(false);
  const [showRemove, setShowRemove] = useState(false);

  // Track the previous server-side status per tier so the poller can detect a
  // syncing→completed/failed transition. Without it, a background auto-sync that
  // finishes between two ticks leaves the React state pinned to the last
  // 'syncing' value, and the inventory was never refreshed.
  const prevServerStatusRef = useRef<Record<DataTier, SyncStatus['status'] | null>>({
    daily: null,
    hourly: null,
    'cost-optimization': null,
  });

  useEffect(() => {
    let cancelled = false;
    function applyStatus(
      tier: DataTier,
      setter: (s: SyncState) => void,
      bumpRefresh: () => void,
    ) {
      api.getSyncStatus(syncIdFor(name, tier)).then(s => {
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
      applyStatus('daily', setDailySyncState, () => { setDailyRefreshKey(k => k + 1); });
      applyStatus('hourly', setHourlySyncState, () => { setHourlyRefreshKey(k => k + 1); });
      applyStatus('cost-optimization', setCostOptSyncState, () => { setCostOptRefreshKey(k => k + 1); });
    }
    tick();
    const timer = setInterval(tick, 2_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [api, name]);

  const anySyncing = isSyncActive(dailySyncState) || isSyncActive(hourlySyncState) || isSyncActive(costOptSyncState);

  const inventory: DataInventoryResult | null =
    inventoryQuery.status === 'success' ? inventoryQuery.data : null;

  const retentionDays = provider.sync.daily.retentionDays;
  const dailyCutoffPeriod = retentionCutoffPeriod(retentionDays);
  const missingWithinRetention = missingWithinCutoff(inventory, dailyCutoffPeriod);

  const dailyBucket = provider.sync.daily.bucket;
  const dailyRetention = provider.sync.daily.retentionDays;
  const hourlyBucket = provider.sync.hourly?.bucket ?? null;
  const hourlyRetention = provider.sync.hourly?.retentionDays ?? null;
  const costOptBucket = provider.sync.costOptimization?.bucket ?? null;
  const costOptRetention = provider.sync.costOptimization?.retentionDays ?? null;

  const hourlyInventoryQuery = useQuery(
    () => {
      if (hourlyBucket === null) return Promise.resolve(null);
      return api.getDataInventory('hourly', name);
    },
    [hourlyBucket, name, hourlyRefreshKey, refreshSignal],
  );
  const hourlyInventory: DataInventoryResult | null = hourlyInventoryQuery.status === 'success' ? hourlyInventoryQuery.data : null;

  const costOptInventoryQuery = useQuery(
    () => {
      if (costOptBucket === null) return Promise.resolve(null);
      return api.getDataInventory('cost-optimization', name);
    },
    [costOptBucket, name, costOptRefreshKey, refreshSignal],
  );
  const costOptInventory: DataInventoryResult | null = costOptInventoryQuery.status === 'success' ? costOptInventoryQuery.data : null;

  const hourlyRetentionDays = provider.sync.hourly?.retentionDays ?? 30;
  const hourlyCutoffPeriod = retentionCutoffPeriod(hourlyRetentionDays);
  const hourlyMissing = missingWithinCutoff(hourlyInventory, hourlyCutoffPeriod);

  const costOptRetentionDays = provider.sync.costOptimization?.retentionDays ?? 90;
  const costOptCutoffPeriod = retentionCutoffPeriod(costOptRetentionDays);
  const costOptMissing = missingWithinCutoff(costOptInventory, costOptCutoffPeriod);

  const prunableCount =
    prunable(inventory?.local.periods, dailyCutoffPeriod, retentionDays).length +
    prunable(hourlyInventory?.local.periods, hourlyCutoffPeriod, hourlyRetentionDays).length +
    prunable(costOptInventory?.local.periods, costOptCutoffPeriod, costOptRetentionDays).length;

  const syncable =
    syncableWithinCutoff(inventory, dailyCutoffPeriod).length +
    syncableWithinCutoff(hourlyInventory, hourlyCutoffPeriod).length +
    syncableWithinCutoff(costOptInventory, costOptCutoffPeriod).length;

  useEffect(() => {
    onCounts(name, { syncable, prunableCount, syncing: anySyncing });
  }, [onCounts, name, syncable, prunableCount, anySyncing]);

  useEffect(() => {
    if (!initialized && inventoryQuery.status === 'success' && missingWithinRetention.length > 0) {
      setSelected(new Set(missingWithinRetention.map(p => p.period)));
      setInitialized(true);
    }
  }, [initialized, inventoryQuery.status, missingWithinRetention]);

  useEffect(() => {
    if (!hourlyInitialized && hourlyInventoryQuery.status === 'success' && hourlyMissing.length > 0) {
      setHourlySelected(new Set(hourlyMissing.map(p => p.period)));
      setHourlyInitialized(true);
    }
  }, [hourlyInitialized, hourlyInventoryQuery.status, hourlyMissing]);

  useEffect(() => {
    if (!costOptInitialized && costOptInventoryQuery.status === 'success' && costOptMissing.length > 0) {
      setCostOptSelected(new Set(costOptMissing.map(p => p.period)));
      setCostOptInitialized(true);
    }
  }, [costOptInitialized, costOptInventoryQuery.status, costOptMissing]);

  async function runSelectedSync(
    tier: DataTier,
    files: readonly { key: string; contentHash: string; size: number }[],
    setState: (s: SyncState) => void,
    clearSelection: () => void,
    bump: () => void,
  ): Promise<void> {
    if (files.length === 0) return;
    setState({ status: 'downloading', filesDone: 0, filesTotal: files.length, bytesDone: 0, bytesTotal: 0, message: '' });

    const pollInterval = setInterval(() => {
      api.getSyncStatus(syncIdFor(name, tier)).then((s) => {
        const mapped = syncStatusToState(s);
        if (mapped !== null) setState(mapped);
      }).catch(() => { /* poll failure is transient */ });
    }, 500);

    try {
      const result = await api.syncPeriods(files, syncIdFor(name, tier));
      clearInterval(pollInterval);
      setState({ status: 'done', filesDownloaded: result.filesDownloaded });
      clearSelection();
      bump();
    } catch (err: unknown) {
      clearInterval(pollInterval);
      setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  function selectedFilesOf(inv: DataInventoryResult | null, sel: ReadonlySet<string>): { key: string; contentHash: string; size: number }[] {
    return (inv?.periods ?? [])
      .filter(p => sel.has(p.period))
      .flatMap(p => [...p.files]);
  }

  function handleDelete(tier: DataTier, bump: () => void): (period: string) => void {
    return (period) => {
      api.deleteLocalPeriod(period, tier, name).then(bump).catch(() => { /* deletion best-effort */ });
    };
  }

  return (
    <section aria-label={`Provider ${name}`} className="flex flex-col gap-4">
      {/* Provider header — slim with a single provider, full chrome with several. */}
      <div className="flex items-center justify-between border-b border-border pb-2">
        <div className="flex items-baseline gap-3">
          <h3 className="text-base font-semibold text-text-primary">{name}</h3>
          <span className="rounded bg-bg-tertiary/60 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-text-muted">{provider.type}</span>
          {awsProfile === null
            ? (
              <span className="text-xs text-text-muted font-mono" title="GCP credentials">
                {provider.type === 'gcp' && provider.keyFile !== undefined ? 'service account key' : 'application default credentials'}
              </span>
            )
            : <span className="text-xs text-text-muted font-mono" title="AWS credentials profile">{awsProfile}</span>}
        </div>
        <div className="flex items-center gap-3">
          {awsProfile !== null && (
            <button
              type="button"
              onClick={() => { setShowProfileSwap(true); }}
              className="rounded-md border border-border bg-bg-tertiary/50 px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-tertiary hover:text-text-primary transition-colors"
              title={`Currently using profile: ${awsProfile}`}
            >
              Change AWS Profile
            </button>
          )}
          {!soleProvider && (
            <button
              type="button"
              onClick={() => { setShowRemove(true); }}
              className="rounded-md border border-negative/50 bg-negative-muted px-3 py-1.5 text-xs font-medium text-negative transition-colors"
              title="Remove this provider from the configuration"
            >
              Remove
            </button>
          )}
        </div>
      </div>

      {/* Account mapping — per provider: each payer account syncs its own AWS
          Organization; the lookups are merged across providers, so a change
          in any section refreshes them all (via the shared refresh signal).
          AWS-only: the GCP analogue (Cloud Resource Manager) is a follow-up. */}
      {awsProfile !== null && (
        <OrgAccountsSection profile={awsProfile} providerName={name} refreshToken={refreshSignal} onDataChanged={onOrgDataChanged} />
      )}

      {inventoryQuery.status === 'loading' && !anySyncing && (
        <div className="rounded-xl border border-border bg-bg-secondary/50 p-12 text-center text-text-secondary">
          {provider.type === 'gcp' ? 'Checking Cloud Storage for available data...' : 'Checking S3 for available data...'}
        </div>
      )}

      {inventoryQuery.status === 'error' && (
        <div className="rounded-lg border border-negative/50 bg-negative-muted px-4 py-3" role="alert">
          <p className="text-sm font-medium text-negative">{inventoryQuery.error.message}</p>
          {/* Each provider's expired-credentials message carries the sign-in
              command it needs; offer the matching one-click affordance, and a
              bare Retry for every failure that has no sign-in remedy. */}
          {/* `awsSsoRemedy` already narrows `awsProfile` to non-null. */}
          {awsSsoRemedy && (
            <SsoLoginButton profile={awsProfile} onRetry={retryInventory} />
          )}
          {gcpAdcRemedy && (
            <GcloudLoginButton mode="adc" providerName={name} onRetry={retryInventory} />
          )}
          {gcpCliRemedy && (
            <GcloudLoginButton mode="cli" providerName={name} onRetry={retryInventory} />
          )}
          {!awsSsoRemedy && !gcpAdcRemedy && !gcpCliRemedy && (
            <div className="mt-2"><RetryButton onRetry={retryInventory} /></div>
          )}
        </div>
      )}

      {/* Two-column tier layout — show immediately if a sync is running.
          Daily's Configure gear is AWS-only: the wizard browses S3 and its save
          path writes an `aws` provider, so opening it on a GCP provider would
          rewrite that entry as `type: aws` and the GCP source would vanish. The
          GCP wizard step is #517 phase F; until then GCP is configured in the
          YAML. */}
      {(inventory !== null || anySyncing) && (
        <div className="flex gap-5">
          <TierPanel
            title="Daily"
            configured={true}
            bucket={dailyBucket}
            retentionDays={dailyRetention}
            localPeriods={inventory?.local.periods ?? []}
            diskBytes={inventory?.local.diskBytes ?? 0}
            oldestPeriod={inventory?.local.oldestPeriod ?? null}
            newestPeriod={inventory?.local.newestPeriod ?? null}
            lastSync={inventory?.lastSync ?? null}
            periods={inventory === null ? [] : [...inventory.periods]}
            selected={selected}
            onToggle={(period) => { toggleInSet(setSelected, period); }}
            onSelectAll={() => { setSelected(new Set(missingWithinRetention.map(p => p.period))); }}
            onDeselectAll={() => { setSelected(new Set()); }}
            onDownload={() => {
              runSelectedSync('daily', selectedFilesOf(inventory, selected), setDailySyncState, () => { setSelected(new Set()); }, () => { setDailyRefreshKey(k => k + 1); }).catch(() => undefined);
            }}
            onDeletePeriod={handleDelete('daily', () => { setDailyRefreshKey(k => k + 1); })}
            syncState={dailySyncState}
            onCancelSync={() => { api.cancelSync(syncIdFor(name, 'daily')).catch(() => undefined); setDailySyncState({ status: 'idle' }); }}
            onConfigure={provider.type === 'aws' ? () => { setConfigureSource('daily'); } : undefined}
          />
          {/* Hourly is real on both providers: AWS delivers it as a second
              Data Export, GCP as the exporter's untouched `…/hourly/` folder.
              Cost Optimization below stays AWS-only — there is no GCP
              analogue, and `resolveBucketPath` refuses that tier outright. */}
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
              onToggle={(period) => { toggleInSet(setHourlySelected, period); }}
              onSelectAll={() => { setHourlySelected(new Set(hourlyMissing.map(p => p.period))); }}
              onDeselectAll={() => { setHourlySelected(new Set()); }}
              onDownload={() => {
                runSelectedSync('hourly', selectedFilesOf(hourlyInventory, hourlySelected), setHourlySyncState, () => { setHourlySelected(new Set()); }, () => { setHourlyRefreshKey(k => k + 1); }).catch(() => undefined);
              }}
              onDeletePeriod={handleDelete('hourly', () => { setHourlyRefreshKey(k => k + 1); })}
              syncState={hourlySyncState}
              onCancelSync={() => { api.cancelSync(syncIdFor(name, 'hourly')).catch(() => undefined); setHourlySyncState({ status: 'idle' }); }}
              onConfigure={provider.type === 'aws' ? () => { setConfigureSource('hourly'); } : undefined}
            />
          {provider.type === 'aws' && (
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
              onToggle={(period) => { toggleInSet(setCostOptSelected, period); }}
              onSelectAll={() => { setCostOptSelected(new Set(costOptMissing.map(p => p.period))); }}
              onDeselectAll={() => { setCostOptSelected(new Set()); }}
              onDownload={() => {
                runSelectedSync('cost-optimization', selectedFilesOf(costOptInventory, costOptSelected), setCostOptSyncState, () => { setCostOptSelected(new Set()); }, () => { setCostOptRefreshKey(k => k + 1); }).catch(() => undefined);
              }}
              onDeletePeriod={handleDelete('cost-optimization', () => { setCostOptRefreshKey(k => k + 1); })}
              syncState={costOptSyncState}
              onCancelSync={() => { api.cancelSync(syncIdFor(name, 'cost-optimization')).catch(() => undefined); setCostOptSyncState({ status: 'idle' }); }}
              onConfigure={() => { setConfigureSource('costOptimization'); }}
            />
          )}
        </div>
      )}

      {configureSource !== null && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={(e) => { if (e.target === e.currentTarget) setConfigureSource(null); }} aria-hidden="true">
          <div className="relative">
            <button type="button" onClick={() => { setConfigureSource(null); }} className="absolute -top-2 -right-2 z-10 rounded-full bg-bg-tertiary border border-border w-7 h-7 flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-bg-secondary transition-colors" title="Close">
              &#10005;
            </button>
            <SetupWizard
              source={configureSource}
              profile={awsProfile ?? 'default'}
              providerName={name}
              onComplete={() => { setConfigureSource(null); onConfigChanged(); }}
            />
          </div>
        </div>
      )}

      {showProfileSwap && awsProfile !== null && (
        <ProfileSwapModal
          currentProfile={awsProfile}
          providerName={name}
          onClose={() => { setShowProfileSwap(false); }}
          onSaved={() => { setShowProfileSwap(false); onConfigChanged(); }}
        />
      )}

      {showRemove && (
        <ConfirmModal
          title={`Remove provider "${name}"`}
          message="This removes the provider from the configuration only. Its downloaded data stays on disk in the workspace data folder until you delete it — nothing is lost by removing the entry."
          confirmLabel="Remove"
          destructive
          onConfirm={() => {
            api.removeProvider(name).then(() => { setShowRemove(false); onConfigChanged(); }).catch(() => { setShowRemove(false); });
          }}
          onCancel={() => { setShowRemove(false); }}
        />
      )}
    </section>
  );
}

function ProfileSwapModal({ currentProfile, providerName, onClose, onSaved }: Readonly<{
  currentProfile: string | null;
  providerName: string;
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
      await api.updateAwsProfile(selected, providerName);
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
          Buckets and other config stay as-is — this only swaps the profile <span className="font-mono">{providerName}</span> uses to talk to AWS.
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
