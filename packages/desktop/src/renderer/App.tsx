import { useState, useEffect, useCallback, useLayoutEffect, useMemo, useRef, Profiler } from 'react';
import { CostTrends, MissingTags, Savings, Baselines, DataManagement, DimensionsView, CostScopeView, ExplorerView, CostApiProvider, useCostApi, SetupWizard, ErrorBoundary, CustomView, OVERVIEW_SEED_VIEW, ViewsEditor, UnsavedChangesProvider, useConfirmLeave, PaletteProvider, CommandPalette, CoinRainLoader, Dialog, DialogContent, DialogTitle, DialogDescription, DialogClose, Button, McpView, SharingActiveBanner, SettingsShell, SETTINGS_TABS, isSettingsTabId } from '@costgoblin/ui';
import type { NavItem, SettingsTabId } from '@costgoblin/ui';
import type { CostApi, DataSharingStatus, Dimension, FilterMap, SyncStatus, ViewsConfig, ViewSpec, UpdateStatus, RollupStatus, BaselineRecomputeStatus } from '@costgoblin/core/browser';
import { asDimensionId, asTagValue, DEFAULT_LAG_DAYS, tagDimColumn } from '@costgoblin/core/browser';
import { Download, RefreshCw, TrendingUp, Lightbulb, Tag, Search, Gauge, Terminal, RotateCw, Settings, ArrowLeft, GitBranch, GitPullRequest } from 'lucide-react';
import { DebugPanel, useDebugBadge } from './debug-panel.js';
import { DashboardsDropdown } from './top-menu/dashboards-dropdown.js';
import { SyncStatusButton, type SyncActivity, type SyncTier } from './top-menu/sync-status-button.js';
import { RollupStatusButton } from './top-menu/rollup-status-button.js';
import { GeneralTab } from './settings/general-tab.js';
import { PerformanceTab } from './settings/performance-tab.js';
import { TelemetryTab } from './settings/telemetry-tab.js';
import { SetupTelemetryStep } from './setup-telemetry-step.js';
import { syncRendererTelemetry } from './telemetry/renderer-telemetry.js';
import { ShareTab } from './settings/share-tab.js';
import { ImportTab } from './settings/import-tab.js';

// ---------------------------------------------------------------------------
// React Profiler — collects render timings when perf mode is active
// ---------------------------------------------------------------------------
const perfEnabled = globalThis.costgoblinPerf !== undefined;
const isDev = globalThis.costgoblinDebug.isDev();
const renderTimings: RenderTiming[] = [];

function formatMemory(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${String(mb)} MB`;
}

function useMemoryMB(): number {
  const [mb, setMb] = useState(0);
  useEffect(() => {
    function update(): void {
      globalThis.costgoblinDebug.getMemoryMB().then(setMb).catch(() => undefined);
    }
    update();
    const id = setInterval(update, 1000);
    return () => { clearInterval(id); };
  }, []);
  return mb;
}

if (perfEnabled) {
  globalThis.__PERF_REACT__ = renderTimings;
}

function onPerfRender(
  id: string,
  phase: 'mount' | 'update' | 'nested-update',
  actualDuration: number,
  baseDuration: number,
  startTime: number,
  commitTime: number,
): void {
  if (perfEnabled) {
    renderTimings.push({ id, phase, actualDuration, baseDuration, startTime, commitTime });
  }
}

function getApi(): CostApi {
  return globalThis.costgoblin;
}

// "View mode" — looking at cost data. Configuration pages deliberately do NOT
// live here: they're "setting mode" (a SettingsTabId rendered in SettingsShell),
// so the compiler makes it impossible to render a config editor in the analysis
// canvas, and a reserved id like 'sync' can never hijack the custom-view path.
type View =
  | { page: 'setup' }
  | { page: 'custom'; viewId: string; initialFilter?: FilterMap }
  | { page: 'trends' }
  | { page: 'missing-tags' }
  | { page: 'savings' }
  | { page: 'baselines' }
  | { page: 'explorer' };

interface AnalyticalNavItem {
  readonly id: string;
  readonly label: string;
  readonly Icon: React.ComponentType<{ size?: number | string }>;
}

const ANALYTICAL_NAV: readonly AnalyticalNavItem[] = [
  { id: 'trends', label: 'Trends', Icon: TrendingUp },
  { id: 'savings', label: 'Findings', Icon: Lightbulb },
  { id: 'baselines', label: 'Baselines', Icon: Gauge },
  { id: 'missing-tags', label: 'Tags', Icon: Tag },
  { id: 'explorer', label: 'Explorer', Icon: Search },
];

function hasUpdateIndicator(status: UpdateStatus): boolean {
  return status.state === 'available' || status.state === 'downloading' || status.state === 'downloaded';
}

type SetupCheck =
  | { status: 'checking' }
  | { status: 'needs-setup' }
  | { status: 'telemetry' }
  | { status: 'ready' };

const FALLBACK_VIEWS: ViewsConfig = { views: [OVERVIEW_SEED_VIEW] };

function SyncAnnouncer({
  syncError,
  syncActivity,
  syncFilesRemaining,
  missingPeriods,
}: Readonly<{
  syncError: string | null;
  syncActivity: SyncActivity;
  syncFilesRemaining: number;
  missingPeriods: number;
}>): React.JSX.Element {
  const errorMessage = syncError === null ? '' : `Sync error: ${syncError}`;

  let statusMessage = '';
  if (syncActivity === 'downloading' && syncFilesRemaining > 0) {
    statusMessage = `Downloading ${String(syncFilesRemaining)} file${syncFilesRemaining === 1 ? '' : 's'}`;
  } else if (syncActivity === 'syncing') {
    statusMessage = 'Checking for updates';
  } else if (syncActivity === 'idle' && missingPeriods > 0) {
    statusMessage = `${String(missingPeriods)} billing period${missingPeriods === 1 ? '' : 's'} not synced`;
  }

  return (
    <>
      <div aria-live="assertive" aria-atomic="true" className="sr-only">
        {errorMessage}
      </div>
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {statusMessage}
      </div>
    </>
  );
}

function formatLogTimestamp(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function stageLabel(stage: 'check' | 'download' | 'install'): string {
  if (stage === 'check') return 'Checking for updates';
  if (stage === 'download') return 'Downloading update';
  return 'Installing update';
}

function ReleaseNotesModal({
  open,
  onOpenChange,
  status,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: UpdateStatus;
}>): React.JSX.Element | null {
  if (status.state === 'error') {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogTitle>Update failed</DialogTitle>
          <DialogDescription>
            {stageLabel(status.stage)} did not complete. You can try again or copy the log below.
          </DialogDescription>
          <div className="mt-3 rounded-md border border-negative/40 bg-negative-muted p-3 text-sm text-text-primary">
            {status.error}
          </div>
          {status.logs.length > 0 && (
            <div className="mt-3">
              <div className="text-xs text-text-secondary mb-1">Recent events</div>
              <pre className="max-h-60 overflow-y-auto rounded-md bg-bg-primary p-3 text-xs text-text-secondary whitespace-pre-wrap break-words">
                {status.logs.map((entry, i) => {
                  let levelClass: string | undefined;
                  if (entry.level === 'error') levelClass = 'text-negative';
                  else if (entry.level === 'warn') levelClass = 'text-warning';
                  return (
                    <div key={`${String(entry.timestamp)}-${String(i)}`} className={levelClass}>
                      [{formatLogTimestamp(entry.timestamp)}] {entry.level.toUpperCase()}: {entry.message}
                    </div>
                  );
                })}
              </pre>
            </div>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <DialogClose>
              <Button variant="ghost" size="sm">Close</Button>
            </DialogClose>
            <Button
              size="sm"
              onClick={() => { globalThis.costgoblinUpdate.checkForUpdates().catch(() => undefined); }}
            >
              <RotateCw size={14} className="mr-1.5" />
              Retry
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  if (status.state !== 'available' && status.state !== 'downloading' && status.state !== 'downloaded') return null;
  const { info } = status;

  let title = 'Update Available';
  if (status.state === 'downloaded') title = 'Ready to Install';
  else if (status.state === 'downloading') title = 'Downloading Update';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>
          {title} &mdash; v{info.version}
        </DialogTitle>
        <DialogDescription>
          Released {info.releaseDate}
        </DialogDescription>
        {status.state === 'downloading' && (
          <div className="mt-3">
            <div className="flex items-center justify-between text-xs text-text-secondary mb-1.5">
              <span className="flex items-center gap-1.5">
                <RefreshCw size={12} className="animate-spin" />
                {status.percent === 0 ? 'Preparing...' : 'Downloading...'}
              </span>
              {status.percent > 0 && <span>{String(status.percent)}%</span>}
            </div>
            <div className="h-2 rounded-full bg-bg-tertiary overflow-hidden">
              <div
                className="h-full rounded-full bg-accent transition-all duration-300"
                style={{ width: `${String(status.percent)}%` }}
              />
            </div>
          </div>
        )}
        {info.releaseNotes !== null && (
          <div
            className="mt-3 max-h-60 overflow-y-auto rounded-md bg-bg-primary p-3 text-sm text-text-secondary prose prose-sm prose-invert max-w-none [&_a]:text-accent [&_a]:underline [&_h2]:text-base [&_h2]:font-semibold [&_h2]:mt-2 [&_h2]:mb-1 [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:mt-2 [&_h3]:mb-1 [&_p]:my-1 [&_ul]:my-1 [&_li]:my-0"
            dangerouslySetInnerHTML={{ __html: info.releaseNotes }}
          />
        )}
        <div className="mt-4 flex justify-end gap-2">
          <DialogClose>
            <Button variant="ghost" size="sm">Dismiss</Button>
          </DialogClose>
          {status.state === 'available' && (
            <Button
              size="sm"
              onClick={() => {
                globalThis.costgoblinUpdate.downloadUpdate().catch(() => undefined);
              }}
            >
              <Download size={14} className="mr-1.5" />
              Download
            </Button>
          )}
          {status.state === 'downloaded' && (
            <Button
              size="sm"
              onClick={() => { globalThis.costgoblinUpdate.quitAndInstall(); }}
            >
              <RefreshCw size={14} className="mr-1.5" />
              Install and Restart
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Top-level app shell — just establishes the context providers. All the
 *  state + navigation lives in `AppShell` below so it can call
 *  `useConfirmLeave()` from inside the UnsavedChangesProvider. */
export function App(): React.JSX.Element {
  const api = getApi();
  return (
    <ErrorBoundary>
      <CostApiProvider value={api}>
        <UnsavedChangesProvider>
          <AppShell />
        </UnsavedChangesProvider>
      </CostApiProvider>
    </ErrorBoundary>
  );
}

type SyncStatusTuple = readonly [Awaited<ReturnType<CostApi['getAutoSyncStatus']>>, ...SyncStatus[]];

function extractSyncError([autoStatus, ...statuses]: SyncStatusTuple): string | null {
  if (autoStatus.state === 'error') return autoStatus.message;
  const failed = statuses.find(s => s.status === 'failed');
  if (failed?.status === 'failed') return failed.error.message;
  return null;
}

function resolveSyncActivity([autoStatus, ...statuses]: SyncStatusTuple): SyncActivity {
  const isDownloading = statuses.some(s => s.status === 'syncing') || autoStatus.state === 'syncing';
  if (isDownloading) return 'downloading';
  if (autoStatus.state === 'checking') return 'syncing';
  return 'idle';
}

function countFilesRemaining(statuses: readonly SyncStatus[]): number {
  let remaining = 0;
  for (const s of statuses) {
    if (s.status === 'syncing') remaining += s.filesTotal - s.filesDone;
  }
  return remaining;
}

const SYNC_TIER_LABELS: readonly { readonly id: string; readonly label: string }[] = [
  { id: 'daily', label: 'Daily' },
  { id: 'hourly', label: 'Hourly' },
  { id: 'cost-optimization', label: 'Cost optimization' },
];

function useSyncPolling(
  api: CostApi,
  setupCheck: SetupCheck,
): {
  syncError: string | null;
  setSyncError: React.Dispatch<React.SetStateAction<string | null>>;
  syncActivity: SyncActivity;
  syncFilesRemaining: number;
  syncTiers: readonly SyncTier[];
} {
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncActivity, setSyncActivity] = useState<SyncActivity>('idle');
  const [syncFilesRemaining, setSyncFilesRemaining] = useState(0);
  const [syncTiers, setSyncTiers] = useState<readonly SyncTier[]>([]);

  useEffect(() => {
    if (setupCheck.status !== 'ready') return;
    let cancelled = false;
    async function tick(): Promise<void> {
      try {
        const [autoStatus, daily, hourly, costOpt] = await Promise.all([
          api.getAutoSyncStatus(),
          api.getSyncStatus('daily'),
          api.getSyncStatus('hourly'),
          api.getSyncStatus('cost-optimization'),
        ]);
        if (cancelled) return;
        const tiers: readonly SyncStatus[] = [daily, hourly, costOpt];
        setSyncTiers(SYNC_TIER_LABELS.map((t, i) => ({ id: t.id, label: t.label, status: tiers[i] ?? daily })));
        const tuple: SyncStatusTuple = [autoStatus, daily, hourly, costOpt];
        const errorMsg = extractSyncError(tuple);
        if (errorMsg !== null) {
          setSyncError(errorMsg);
          setSyncActivity('idle');
          return;
        }
        const activity = resolveSyncActivity(tuple);
        setSyncActivity(activity);
        setSyncFilesRemaining(countFilesRemaining([daily, hourly, costOpt]));
        setSyncError(activity === 'downloading' ? null : (prev => (prev?.includes('AWS credentials') ? prev : null)));
      } catch { /* transient */ }
    }
    tick().catch(() => undefined);
    const interval = syncActivity === 'idle' ? 10_000 : 2_000;
    const timer = setInterval(() => { tick().catch(() => undefined); }, interval);
    return () => { cancelled = true; clearInterval(timer); };
  }, [api, setupCheck, syncActivity]);

  return { syncError, setSyncError, syncActivity, syncFilesRemaining, syncTiers };
}

/** Poll publisher-side sharing status app-wide so the activity banner can show
 *  on every view while sharing is on. Polls faster when sharing is active (to
 *  keep the live throughput fresh) and backs off when it's off. */
function useDataSharingPolling(api: CostApi, setupCheck: SetupCheck): {
  sharingStatus: DataSharingStatus | null;
  setSharingStatus: React.Dispatch<React.SetStateAction<DataSharingStatus | null>>;
} {
  const [sharingStatus, setSharingStatus] = useState<DataSharingStatus | null>(null);
  const enabled = sharingStatus?.enabled === true;

  useEffect(() => {
    if (setupCheck.status !== 'ready') return undefined;
    let cancelled = false;
    async function tick(): Promise<void> {
      try {
        const status = await api.getDataSharingStatus();
        if (!cancelled) setSharingStatus(status);
      } catch { /* transient */ }
    }
    tick().catch(() => undefined);
    const timer = setInterval(() => { tick().catch(() => undefined); }, enabled ? 2_000 : 10_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [api, setupCheck, enabled]);

  return { sharingStatus, setSharingStatus };
}

const SPLASH_IMAGES = ['splash-1.png', 'splash-2.png', 'splash-3.png', 'splash-4.png', 'splash-5.png', 'splash-6.png', 'splash-7.png', 'splash-8.png', 'splash-9.png', 'splash-10.png'];
const SPLASH_INTERVAL = 500;

function shuffled<T>(arr: readonly T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = copy[i];
    const b = copy[j];
    if (a !== undefined && b !== undefined) {
      copy[i] = b;
      copy[j] = a;
    }
  }
  return copy;
}

function dimId(dim: Dimension): string {
  return 'field' in dim ? dim.name : tagDimColumn(dim);
}

// Upper bound on how long the splash waits for the in-memory cost_base to
// build before prewarming dimensions. Gating prewarm on the base keeps its ~8
// filter probes (and the first dashboard queries) off the slow raw-parquet
// path, so they don't pile concurrent full scans onto the materialize. If the
// base isn't ready by then we proceed anyway (probes fall back to raw parquet,
// the prior behavior) rather than hang the splash.
const BASE_READY_TIMEOUT_MS = 90_000;

function defaultDateRange(): { start: string; end: string } {
  const end = new Date(Date.now() - DEFAULT_LAG_DAYS * 86_400_000);
  const start = new Date(end.getTime() - 30 * 86_400_000);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

function SplashScreen({ step }: Readonly<{ step: string }>): React.JSX.Element {
  const [order] = useState(() => shuffled(SPLASH_IMAGES));
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const rotate = setInterval(() => {
      setIndex(prev => (prev + 1) % SPLASH_IMAGES.length);
    }, SPLASH_INTERVAL);
    return () => { clearInterval(rotate); };
  }, []);

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center [-webkit-app-region:drag]"
      style={{ background: '#0a0a0a' }}
    >
      <div className="relative h-48 w-48 mb-6">
        {order.map((src, i) => (
          <img
            key={src}
            src={src}
            alt=""
            className="absolute inset-0 h-full w-full object-contain drop-shadow-lg transition-opacity duration-200"
            style={{ opacity: i === index ? 1 : 0 }}
          />
        ))}
      </div>
      <h1 className="text-2xl font-bold text-accent tracking-wider mb-1">CostGoblin</h1>
      <p className="text-sm text-text-muted mb-8">{step}</p>
      <div className="w-64">
        <CoinRainLoader height={120} count={6} />
      </div>
    </div>
  );
}

async function prewarmDimensions(
  api: CostApi,
  setSplashStep: (step: string) => void,
): Promise<void> {
  const dims = await api.getDimensions().catch((): Dimension[] => []);
  if (dims.length === 0) return;
  const range = defaultDateRange();
  let done = 0;
  setSplashStep(`Loading dimensions 0/${String(dims.length)}...`);
  await Promise.all(dims.map(async (dim) => {
    await api.getFilterValues(dimId(dim), {}, range, undefined, `splash:warmup:${dimId(dim)}`).catch(() => undefined);
    done++;
    setSplashStep(`Loading dimensions ${String(done)}/${String(dims.length)}...`);
  }));
}

function AppShell(): React.JSX.Element {
  const api = useCostApi();
  const confirmLeave = useConfirmLeave();
  const [view, setView] = useState<View>({ page: 'custom', viewId: OVERVIEW_SEED_VIEW.id });
  // `settingsTab === null` ⇒ view mode; a tab id ⇒ setting mode (the full-canvas
  // SettingsShell). Entering settings never touches `view`, so exiting just
  // clears this and the user lands back exactly where they were.
  const [settingsTab, setSettingsTab] = useState<SettingsTabId | null>(null);
  const [missingPeriods, setMissingPeriods] = useState(0);
  const [currentMonthUpdating, setCurrentMonthUpdating] = useState(false);
  const [isDark, setIsDark] = useState(true);
  const [palette, setPalette] = useState<'standard' | 'colorblind'>('standard');
  const [defaultViewId, setDefaultViewId] = useState<string>(OVERVIEW_SEED_VIEW.id);
  const [setupCheck, setSetupCheck] = useState<SetupCheck>({ status: 'checking' });
  const [splashStep, setSplashStep] = useState('Connecting...');
  const [viewsConfig, setViewsConfig] = useState<ViewsConfig | null>(null);
  const { syncError, setSyncError, syncActivity, syncFilesRemaining, syncTiers } = useSyncPolling(api, setupCheck);
  const { sharingStatus, setSharingStatus } = useDataSharingPolling(api, setupCheck);
  const [stoppingSharing, setStoppingSharing] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [clearingCache, setClearingCache] = useState(false);
  const [reloadConfirmOpen, setReloadConfirmOpen] = useState(false);
  const inFlightCount = useDebugBadge();
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ state: 'idle' });
  const [rollupStatus, setRollupStatus] = useState<RollupStatus>({ state: 'idle' });
  const [baselineStatus, setBaselineStatus] = useState<BaselineRecomputeStatus>({ state: 'idle', lastRun: null });
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false);
  const [appVersion, setAppVersion] = useState('');
  const [devBranch, setDevBranch] = useState<string | null>(null);
  const [branchPr, setBranchPr] = useState<BranchPrInfo | null>(null);
  const memoryMB = useMemoryMB();
  const autoOpenRef = useMemo(() => ({ current: false }), []);
  const initialViewSetRef = useRef(false);
  const headerRef = useRef<HTMLDivElement>(null);
  const [headerHeight, setHeaderHeight] = useState(72);

  // Track the actual rendered header height so the debug panel can sit
  // flush below it without guessing with a magic top offset.
  useLayoutEffect(() => {
    const el = headerRef.current;
    if (el === null) return undefined;
    const update = () => { setHeaderHeight(el.offsetHeight); };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => { observer.disconnect(); };
  }, []);

  useEffect(() => {
    globalThis.costgoblinUpdate.getAppVersion().then(setAppVersion).catch(() => undefined);
  }, []);

  // Start renderer-process crash capture when (and only when) crash reports are
  // already opted-in and the main reporter is active. Renderer events forward to
  // main, where they're scrubbed; this never sends anything on its own.
  useEffect(() => {
    api.getTelemetryStatus().then(syncRendererTelemetry).catch(() => undefined);
  }, [api]);

  useEffect(() => {
    globalThis.costgoblinDebug.getGitBranch().then(setDevBranch).catch(() => undefined);
    // Resolved separately (a gh subprocess, ~0.5s) so the branch label never
    // waits on the network — it upgrades to the PR title + link if/when a PR
    // is found.
    globalThis.costgoblinDebug.getBranchPr().then(setBranchPr).catch(() => undefined);
  }, []);

  useEffect(() => {
    return globalThis.costgoblinUpdate.onStatusChanged(setUpdateStatus);
  }, []);

  useEffect(() => {
    // Pull the current state on mount (a re-roll may already be running before
    // the renderer subscribes), then track transitions via the push channel.
    const apply = (status: RollupStatus): void => {
      setRollupStatus(status);
    };
    globalThis.costgoblinRollup.getStatus().then(apply).catch(() => undefined);
    return globalThis.costgoblinRollup.onStatusChanged(apply);
  }, []);

  useEffect(() => {
    const apply = (status: BaselineRecomputeStatus): void => { setBaselineStatus(status); };
    globalThis.costgoblinBaselines.getStatus().then(apply).catch(() => undefined);
    return globalThis.costgoblinBaselines.onStatusChanged(apply);
  }, []);

  useEffect(() => {
    if (setupCheck.status !== 'ready') return;
    // Always surface errors so the user can see what went wrong; for other
    // user-visible states open only once per session.
    if (updateStatus.state === 'error') {
      setReleaseNotesOpen(true);
      return;
    }
    if (autoOpenRef.current) return;
    if (updateStatus.state === 'available' || updateStatus.state === 'downloaded') {
      autoOpenRef.current = true;
      setReleaseNotesOpen(true);
    }
  }, [setupCheck.status, updateStatus.state, autoOpenRef]);

  useEffect(() => {
    async function initialize(): Promise<void> {
      setSplashStep('Checking configuration...');
      const { configured, postSetup } = await api.getSetupStatus();

      if (!configured) {
        setSetupCheck({ status: 'needs-setup' });
        return;
      }

      setSplashStep('Preparing cost data...');
      await api.awaitMaterializedBase(BASE_READY_TIMEOUT_MS);
      // First launch right after the wizard (the relaunch carried a one-shot
      // flag): land on data-sync so a freshly-configured user is guided to sync,
      // rather than dropping them on an empty default dashboard.
      if (postSetup) setSettingsTab('data-sync');
      // Reveal the app as soon as the in-memory base is ready. The dimension
      // filter-value prewarm previously blocked the splash here for ~13s (~8
      // concurrent probes). Run it in the background instead: with cost_base
      // ready those probes hit the in-memory table, and filter dropdowns also
      // load fast on demand — so there's no reason to hold the splash for them.
      setSetupCheck({ status: 'ready' });
      void prewarmDimensions(api, () => undefined);
    }
    initialize().catch(() => undefined);
  }, [api]);

  useEffect(() => {
    api.getUIPreferences().then(prefs => {
      setIsDark(prefs.theme === 'dark');
      setPalette(prefs.palette);
      const defaultId = prefs.defaultViewId ?? OVERVIEW_SEED_VIEW.id;
      setDefaultViewId(defaultId);
      // Only redirect to the configured default once on startup, so that
      // navigating around (or starring a different default mid-session)
      // doesn't yank the user away from the page they're looking at.
      if (!initialViewSetRef.current) {
        initialViewSetRef.current = true;
        setView({ page: 'custom', viewId: defaultId });
      }
    }).catch(() => undefined);
  }, [api]);

  const applyViews = useCallback((cfg: ViewsConfig): void => {
    const resolved = cfg.views.length > 0 ? cfg : FALLBACK_VIEWS;
    setViewsConfig(resolved);
    setView(prev => {
      if (prev.page !== 'custom') return prev;
      const exists = resolved.views.some(v => v.id === prev.viewId);
      const firstId = resolved.views[0]?.id;
      return exists || firstId === undefined ? prev : { page: 'custom', viewId: firstId };
    });
  }, []);

  useEffect(() => {
    if (setupCheck.status !== 'ready') return;
    api.getViewsConfig()
      .then(applyViews)
      .catch(() => { setViewsConfig(FALLBACK_VIEWS); });
  }, [api, setupCheck, applyViews]);

  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDark]);

  function handleToggleTheme() {
    const next = !isDark;
    setIsDark(next);
    api.saveUIPreferences({ theme: next ? 'dark' : 'light', palette, defaultViewId }).catch(() => undefined);
  }

  function handleTogglePalette() {
    const next: 'standard' | 'colorblind' = palette === 'standard' ? 'colorblind' : 'standard';
    setPalette(next);
    api.saveUIPreferences({ theme: isDark ? 'dark' : 'light', palette: next, defaultViewId }).catch(() => undefined);
  }

  function handleSetDefaultView(id: string) {
    setDefaultViewId(id);
    api.saveUIPreferences({
      theme: isDark ? 'dark' : 'light',
      palette,
      defaultViewId: id,
    }).catch(() => undefined);
  }

  function handleGoHome() {
    handleNavClick(defaultViewId);
  }

  function handleCheckForUpdates() {
    globalThis.costgoblinUpdate.checkForUpdates().catch(() => undefined);
  }

  function handleClearCache() {
    if (clearingCache) return;
    setClearingCache(true);
    api.clearAllCaches()
      .catch(() => undefined)
      .finally(() => {
        // Wipe the debug panel's query log too — after clearing the cache,
        // only the queries that the refresh triggers are interesting.
        globalThis.costgoblinDebug.clearLog().catch(() => undefined);
        setClearingCache(false);
        setRefreshNonce(n => n + 1);
      });
  }

  const checkMissingPeriods = useCallback(async (): Promise<void> => {
    if (setupCheck.status !== 'ready') return;
    try {
      const [inv, config] = await Promise.all([api.getDataInventory(), api.getConfig()]);
      const retentionDays = config.providers[0]?.sync.daily.retentionDays ?? 365;
      const now = new Date();
      const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
      const cutoffPeriod = `${String(cutoff.getFullYear())}-${String(cutoff.getMonth() + 1).padStart(2, '0')}`;
      const currentPeriod = `${String(now.getFullYear())}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      // "Behind" = no local data ('missing'), or a *closed* month whose remote
      // files changed since we synced ('stale'). The current month is almost
      // always 'stale' (CUR re-publishes all month), so it's surfaced as a soft
      // "updating" note instead of nagging as un-synced — matching the Data &
      // Sync view, which already lists stale periods under "Available".
      const inWindow = inv.periods.filter(p => p.period >= cutoffPeriod);
      const missing = inWindow.filter(p =>
        p.localStatus === 'missing' || (p.localStatus === 'stale' && p.period < currentPeriod)).length;
      setMissingPeriods(missing);
      setCurrentMonthUpdating(inWindow.some(p => p.localStatus === 'stale' && p.period === currentPeriod));
      setSyncError(null);
    } catch (err: unknown) {
      // Most common cause is expired AWS credentials — surface the message on
      // the sync indicator. Swallowed silently before, which left the user on a
      // screen that looked fine while sync was completely broken.
      setSyncError(err instanceof Error ? err.message : String(err));
    }
  }, [api, setupCheck, setSyncError]);

  // Re-check on view / settings-tab change (leaving the Data & Sync tab after a
  // download must refresh the missing-periods badge) and on demand from the
  // sync popover's recheck button.
  useEffect(() => { checkMissingPeriods().catch(() => undefined); }, [checkMissingPeriods, view, settingsTab]);

  function handleNavClick(id: string) {
    const inSettings = settingsTab !== null;
    const alreadyActive = !inSettings && (view.page === 'custom' ? view.viewId === id : view.page === id);
    if (alreadyActive) return;
    confirmLeave(() => {
      api.cancelPendingQueries().catch(() => undefined);
      setSettingsTab(null);
      switch (id) {
        case 'trends': setView({ page: 'trends' }); break;
        case 'missing-tags': setView({ page: 'missing-tags' }); break;
        case 'savings': setView({ page: 'savings' }); break;
        case 'baselines': setView({ page: 'baselines' }); break;
        case 'explorer': setView({ page: 'explorer' }); break;
        default:
          // Anything else is a custom view id (every left-nav entry that
          // isn't one of the well-known static analysis pages above).
          setView({ page: 'custom', viewId: id });
      }
    });
  }

  function enterSettings(tab: SettingsTabId) {
    if (settingsTab === tab) return;
    confirmLeave(() => {
      api.cancelPendingQueries().catch(() => undefined);
      setSettingsTab(tab);
    });
  }

  function exitSettings() {
    confirmLeave(() => {
      api.cancelPendingQueries().catch(() => undefined);
      setSettingsTab(null);
    });
  }

  function toggleSettings() {
    // The gear carries the app-wide sync/update badge, so opening it always
    // lands on Data & Sync — the activity that badge is inviting a click for.
    if (settingsTab === null) enterSettings('data-sync');
    else exitSettings();
  }

  // Single entry point for the command palette: routes settings tabs and
  // global actions, falling through to ordinary view navigation.
  function handleCommand(id: string) {
    if (id === 'action:reload') { setReloadConfirmOpen(true); return; }
    if (id.startsWith('settings:')) {
      const tab = id.slice('settings:'.length);
      if (isSettingsTabId(tab)) enterSettings(tab);
      return;
    }
    handleNavClick(id);
  }

  function handleEntityClick(entity: string, dimension: string) {
    confirmLeave(() => {
      api.cancelPendingQueries().catch(() => undefined);
      setSettingsTab(null);
      const firstId = viewsConfig?.views[0]?.id ?? OVERVIEW_SEED_VIEW.id;
      const initialFilter: FilterMap = { [asDimensionId(dimension)]: [asTagValue(entity)] };
      setView({ page: 'custom', viewId: firstId, initialFilter });
    });
  }

  // Finishing the wizard restarts the app. Telemetry choices can only arm at
  // boot (before Electron's `ready` event), and a clean restart also avoids the
  // in-place data reload after a config rewrite (which otherwise cancels the
  // in-flight rollup rebuild and looks like a freeze). After relaunch, the normal
  // startup flow re-checks setup and materialises data.
  function handleSetupComplete() {
    // postSetup=true → the next launch resumes on the data-sync screen.
    globalThis.costgoblinUpdate.relaunch(true);
  }

  // Re-run the first-run wizard on demand (Settings → General). The wizard
  // funnels into the telemetry step and then back to the dashboard; existing
  // config is preserved (setup:write-config merges).
  function handleRerunSetup() {
    setSettingsTab(null);
    setSetupCheck({ status: 'needs-setup' });
  }

  const views = viewsConfig ?? FALLBACK_VIEWS;
  const viewsReady = viewsConfig !== null;
  const customNav: { id: string; name: string }[] = views.views.map(v => ({ id: v.id, name: v.name }));

  const paletteItems: NavItem[] = useMemo(() => [
    ...customNav.map(n => ({ id: n.id, label: n.name, group: 'Dashboards' })),
    ...ANALYTICAL_NAV.map(n => ({ id: n.id, label: n.label, group: 'Analysis' })),
    ...SETTINGS_TABS.map(t => ({ id: `settings:${t.id}`, label: t.label, group: 'Settings', keywords: [...t.keywords] })),
    { id: 'action:reload', label: 'Reload data', group: 'Actions', keywords: ['refresh', 'clear cache'] },
  ], [customNav]);

  if (setupCheck.status === 'checking') {
    return <SplashScreen step={splashStep} />;
  }

  if (setupCheck.status === 'needs-setup') {
    return <SetupWizard onComplete={() => { setSetupCheck({ status: 'telemetry' }); }} />;
  }

  if (setupCheck.status === 'telemetry') {
    return <SetupTelemetryStep onDone={handleSetupComplete} />;
  }

  function activeNavId(): string | null {
    if (settingsTab !== null) return null;
    if (view.page === 'custom') return view.viewId;
    if (view.page === 'trends') return 'trends';
    if (view.page === 'missing-tags') return 'missing-tags';
    if (view.page === 'savings') return 'savings';
    if (view.page === 'baselines') return 'baselines';
    if (view.page === 'explorer') return 'explorer';
    return null;
  }
  const active = activeNavId();

  function findViewSpec(id: string): ViewSpec | null {
    return views.views.find(v => v.id === id) ?? null;
  }

  function handleStopSharing(): void {
    setStoppingSharing(true);
    api.disableDataSharing()
      .then(result => { if (result.status === 'ok') setSharingStatus(result.sharing); })
      .catch(() => undefined)
      .finally(() => { setStoppingSharing(false); });
  }

  // Render the active settings tab's content. Each config view is mounted lazily
  // (only while its tab is active), so opening Settings doesn't fan out every
  // page's self-fetch at once and view mode no longer pays for their polling.
  function renderSettingsTab(): React.JSX.Element | null {
    switch (settingsTab) {
      case 'general':
        return (
          <GeneralTab
            isDark={isDark}
            onToggleTheme={handleToggleTheme}
            palette={palette}
            onTogglePalette={handleTogglePalette}
            dashboards={customNav.map(c => ({ id: c.id, name: c.name }))}
            defaultViewId={defaultViewId}
            onSetDefaultView={handleSetDefaultView}
            appVersion={appVersion}
            updateStatus={updateStatus}
            onCheckForUpdates={handleCheckForUpdates}
            onShowReleaseNotes={() => { setReleaseNotesOpen(true); }}
            onRerunSetup={handleRerunSetup}
          />
        );
      case 'data-sync':
        return <DataManagement />;
      case 'cost-scope':
        return <CostScopeView />;
      case 'dimensions':
        return <DimensionsView />;
      case 'dashboards':
        return <ViewsEditor onConfigPersisted={setViewsConfig} />;
      case 'share':
        return <ShareTab />;
      case 'import':
        return (
          <ImportTab
            onApplied={() => {
              // The whole org config just changed under the renderer — a full
              // reload re-runs the boot path (setup check, views, dimensions
              // prewarm) so nothing serves stale state.
              globalThis.location.reload();
            }}
          />
        );
      case 'ai-assistant':
        return <McpView />;
      case 'performance':
        return <PerformanceTab />;
      case 'telemetry':
        return <TelemetryTab />;
      case null:
        return null;
    }
  }

  // The build indicator prefers a PR link, falls back to the git branch, then to
  // the app version — rendered as a flat sequence rather than a nested ternary.
  function renderBuildIndicator(): React.JSX.Element | false {
    if (branchPr !== null) {
      return (
        <a
          href={branchPr.url}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1 max-w-[320px] font-medium text-accent hover:underline [-webkit-app-region:no-drag]"
          title={`#${String(branchPr.number)} ${branchPr.title} — open on GitHub`}
        >
          <GitPullRequest size={10} className="shrink-0" />
          <span className="truncate">#{branchPr.number} {branchPr.title}</span>
        </a>
      );
    }
    if (devBranch !== null) {
      return (
        <span className="flex items-center gap-1 font-medium text-accent" title="Running from this git branch">
          <GitBranch size={10} />{devBranch}
        </span>
      );
    }
    return appVersion !== '' && <span>v{appVersion}</span>;
  }

  return (
    <PaletteProvider palette={palette}>
      <CommandPalette items={paletteItems} onNavigate={handleCommand} />
      <div className="min-h-screen bg-bg-primary text-text-primary">
        <SyncAnnouncer
          syncError={syncError}
          syncActivity={syncActivity}
          syncFilesRemaining={syncFilesRemaining}
          missingPeriods={missingPeriods}
        />
        {/* Title bar + nav */}
        <div ref={headerRef} className="sticky top-0 z-50 bg-bg-primary/80 backdrop-blur-sm border-b border-border [-webkit-app-region:drag]">
        {sharingStatus?.enabled === true && (
          <SharingActiveBanner status={sharingStatus} onStop={handleStopSharing} stopping={stoppingSharing} />
        )}
        <nav className="grid grid-cols-[1fr_auto_1fr] items-center px-4 pt-7 pb-2">
          {settingsTab === null ? (
          <div className="flex items-center gap-3 min-w-0">
          <nav className="flex items-center gap-1" aria-label="Dashboards and analysis">
            {(() => {
              const isActiveDefault = view.page === 'custom' && view.viewId === defaultViewId;
              const dv = customNav.find(c => c.id === defaultViewId);
              const tooltip = dv === undefined ? 'Go to default dashboard' : `Go to ${dv.name}`;
              return (
                <button
                  type="button"
                  onClick={handleGoHome}
                  className="rounded-md p-1 [-webkit-app-region:no-drag] cursor-pointer"
                  aria-label="Home"
                  aria-current={isActiveDefault ? 'page' : undefined}
                  title={tooltip}
                >
                  <img src="goblin.png" alt="" className="h-7 w-auto object-contain" />
                </button>
              );
            })()}
            <DashboardsDropdown
              items={customNav}
              activeId={active}
              defaultId={defaultViewId}
              onSelect={handleNavClick}
              onSetDefault={handleSetDefaultView}
            />
            {ANALYTICAL_NAV.map((item) => {
              const Icon = item.Icon;
              const isActive = active === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => { handleNavClick(item.id); }}
                  className={[
                    'flex items-center rounded-md transition-colors [-webkit-app-region:no-drag]',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-primary',
                    isActive
                      ? 'gap-1.5 px-3 py-1.5 text-sm font-medium bg-bg-tertiary text-text-primary'
                      : 'p-1.5 text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/50',
                  ].join(' ')}
                  aria-current={isActive ? 'page' : undefined}
                  aria-label={isActive ? undefined : item.label}
                  title={isActive ? undefined : item.label}
                >
                  <Icon size={isActive ? 14 : 18} />
                  {isActive && item.label}
                </button>
              );
            })}
          </nav>
          </div>
          ) : (
            <div className="flex items-center gap-2 [-webkit-app-region:no-drag]">
              <button
                type="button"
                onClick={exitSettings}
                className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-primary"
                aria-label="Done, return to dashboards"
              >
                <ArrowLeft size={16} />Done
              </button>
              <span className="text-sm font-medium text-text-primary">Settings</span>
            </div>
          )}
          <div className="flex flex-col items-center justify-center px-4">
            <span className="text-sm font-bold text-accent tracking-wider leading-tight">CostGoblin</span>
            <div className="flex items-center gap-1.5 text-[10px] text-text-muted">
              {renderBuildIndicator()}
              {isDev && memoryMB > 0 && <span>{formatMemory(memoryMB)}</span>}
            </div>
          </div>
          <nav className="flex items-center justify-end gap-1 [-webkit-app-region:no-drag]" aria-label="Sync and settings">
            <button
              type="button"
              onClick={() => { setDebugOpen(prev => !prev); }}
              className={[
                'relative rounded-md p-1.5 transition-colors',
                debugOpen
                  ? 'bg-bg-tertiary text-text-primary'
                  : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary',
              ].join(' ')}
              aria-label="Debug panel"
              aria-pressed={debugOpen}
              title="Debug panel"
            >
              <Terminal size={16} />
              {inFlightCount > 0 && (
                <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-white">
                  {String(inFlightCount)}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => { setReloadConfirmOpen(true); }}
              disabled={clearingCache}
              className={[
                'rounded-md p-1.5 transition-colors',
                clearingCache
                  ? 'text-text-muted cursor-wait'
                  : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary',
              ].join(' ')}
              aria-label="Reload data"
              title="Reload data"
            >
              <RotateCw size={16} className={clearingCache ? 'animate-spin' : undefined} />
            </button>
            <SyncStatusButton
              activity={syncActivity}
              error={syncError}
              filesRemaining={syncFilesRemaining}
              missingPeriods={missingPeriods}
              currentMonthUpdating={currentMonthUpdating}
              tiers={syncTiers}
              inSettingsData={settingsTab === 'data-sync'}
              onManageData={() => { enterSettings('data-sync'); }}
              onRecheck={checkMissingPeriods}
            />
            <RollupStatusButton status={rollupStatus} />
            {(() => {
              // Sync/missing/error now live on the dedicated sync icon; the gear is
              // the Settings entry point and carries only the update dot.
              const showUpdate = hasUpdateIndicator(updateStatus);
              const inSettings = settingsTab !== null;
              const title = showUpdate ? 'Update available' : 'Settings';
              return (
                <button
                  type="button"
                  onClick={toggleSettings}
                  className={[
                    'relative rounded-md p-1.5 transition-colors',
                    inSettings
                      ? 'bg-bg-tertiary text-text-primary'
                      : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary',
                  ].join(' ')}
                  aria-label="Settings"
                  aria-expanded={inSettings}
                  title={title}
                >
                  <Settings size={16} className={inSettings ? 'text-accent' : undefined} />
                  {showUpdate && (
                    <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-accent" aria-hidden="true" />
                  )}
                </button>
              );
            })()}
          </nav>
        </nav>
      </div>

      {/* View content — wrapped in a keyed container so "clear cache"
          forces every mounted view to remount and refetch. */}
      <div key={`refresh-${String(refreshNonce)}`}>
        {settingsTab === null ? (
          <>
            {view.page === 'custom' && viewsReady && (() => {
              const spec = findViewSpec(view.viewId) ?? OVERVIEW_SEED_VIEW;
              return (
                <Profiler id={`custom:${view.viewId}`} onRender={onPerfRender}>
                  <CustomView spec={spec} headerSubtitle="Cloud spending visibility" initialFilter={view.initialFilter} rollupStatus={rollupStatus} />
                </Profiler>
              );
            })()}
            {view.page === 'trends' && (
              <Profiler id="trends" onRender={onPerfRender}>
                <CostTrends onEntityClick={handleEntityClick} rollupStatus={rollupStatus} />
              </Profiler>
            )}
            {view.page === 'missing-tags' && (
              <Profiler id="missing-tags" onRender={onPerfRender}>
                <MissingTags onEntityClick={handleEntityClick} />
              </Profiler>
            )}
            {view.page === 'savings' && (
              <Profiler id="savings" onRender={onPerfRender}>
                <Savings />
              </Profiler>
            )}
            {view.page === 'baselines' && (
              <Profiler id="baselines" onRender={onPerfRender}>
                <Baselines baselineStatus={baselineStatus} />
              </Profiler>
            )}
            {view.page === 'explorer' && (
              <Profiler id="explorer" onRender={onPerfRender}>
                <ExplorerView />
              </Profiler>
            )}
          </>
        ) : (
          <SettingsShell
            tabs={SETTINGS_TABS}
            activeTab={settingsTab}
            onTabChange={enterSettings}
            topOffset={headerHeight}
          >
            <Profiler id={`settings:${settingsTab}`} onRender={onPerfRender}>
              {renderSettingsTab()}
            </Profiler>
          </SettingsShell>
        )}
      </div>
      {debugOpen && <DebugPanel onClose={() => { setDebugOpen(false); }} topOffset={headerHeight} />}
      <ReleaseNotesModal open={releaseNotesOpen} onOpenChange={setReleaseNotesOpen} status={updateStatus} />
      <Dialog open={reloadConfirmOpen} onOpenChange={setReloadConfirmOpen}>
        <DialogContent>
          <DialogTitle>Reload data?</DialogTitle>
          <DialogDescription>
            This clears cached query results and refreshes the current view. Any pending queries will be cancelled.
          </DialogDescription>
          <div className="mt-4 flex justify-end gap-2">
            <DialogClose>
              <Button variant="ghost" size="sm">Cancel</Button>
            </DialogClose>
            <Button
              size="sm"
              onClick={() => {
                setReloadConfirmOpen(false);
                handleClearCache();
              }}
            >
              <RotateCw size={14} className="mr-1.5" />
              Reload
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      </div>
    </PaletteProvider>
  );
}
