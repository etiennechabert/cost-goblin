import { useState, useEffect, useCallback, useLayoutEffect, useMemo, useRef, Profiler } from 'react';
import { BudgetsView, CostTrends, MissingTags, Savings, DataManagement, DimensionsView, CostScopeView, ExplorerView, CostApiProvider, useCostApi, SetupWizard, ErrorBoundary, CustomView, OVERVIEW_SEED_VIEW, ViewsEditor, UnsavedChangesProvider, useConfirmLeave, PaletteProvider, CommandPalette, CoinRainLoader, Dialog, DialogContent, DialogTitle, DialogDescription, DialogClose, Button, McpView } from '@costgoblin/ui';
import type { NavItem } from '@costgoblin/ui';
import type { CostApi, Dimension, FilterMap, SyncStatus, ViewsConfig, ViewSpec, UpdateStatus } from '@costgoblin/core/browser';
import { asDimensionId, asTagValue, DEFAULT_LAG_DAYS, tagColumnName } from '@costgoblin/core/browser';
import { Download, RefreshCw, TrendingUp, Lightbulb, Tag, Search, Terminal, RotateCw, Wallet } from 'lucide-react';
import { DebugPanel, useDebugBadge } from './debug-panel.js';
import { DashboardsDropdown } from './top-menu/dashboards-dropdown.js';
import { OptionsMenu } from './top-menu/options-menu.js';

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

type View =
  | { page: 'setup' }
  | { page: 'custom'; viewId: string; initialFilter?: FilterMap }
  | { page: 'trends' }
  | { page: 'missing-tags' }
  | { page: 'savings' }
  | { page: 'mcp' }
  | { page: 'explorer' }
  | { page: 'budgets' }
  | { page: 'dimensions' }
  | { page: 'cost-scope' }
  | { page: 'views-editor' }
  | { page: 'sync' };

interface AnalyticalNavItem {
  readonly id: string;
  readonly label: string;
  readonly Icon: React.ComponentType<{ size?: number | string }>;
}

const ANALYTICAL_NAV: readonly AnalyticalNavItem[] = [
  { id: 'trends', label: 'Trends', Icon: TrendingUp },
  { id: 'savings', label: 'Findings', Icon: Lightbulb },
  { id: 'missing-tags', label: 'Tags', Icon: Tag },
  { id: 'explorer', label: 'Explorer', Icon: Search },
  { id: 'budgets', label: 'Budgets', Icon: Wallet },
];

const SETTINGS_NAV: readonly { id: string; label: string }[] = [
  { id: 'cost-scope', label: 'Cost Scope' },
  { id: 'dimensions', label: 'Dimensions' },
  { id: 'views-editor', label: 'Views' },
  { id: 'sync', label: 'Sync' },
  { id: 'mcp', label: 'AI Assistant' },
];

type SyncActivity = 'idle' | 'syncing' | 'downloading';

type SetupCheck =
  | { status: 'checking' }
  | { status: 'needs-setup' }
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

function ReleaseNotesModal({
  open,
  onOpenChange,
  status,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: UpdateStatus;
}>): React.JSX.Element | null {
  if (status.state !== 'available' && status.state !== 'downloading' && status.state !== 'downloaded') return null;
  const { info } = status;

  const title = status.state === 'downloaded'
    ? 'Ready to Install'
    : status.state === 'downloading'
      ? 'Downloading Update'
      : 'Update Available';

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
                Downloading...
              </span>
              <span>{String(status.percent)}%</span>
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

function useSyncPolling(
  api: CostApi,
  setupCheck: SetupCheck,
): {
  syncError: string | null;
  setSyncError: React.Dispatch<React.SetStateAction<string | null>>;
  syncActivity: SyncActivity;
  syncFilesRemaining: number;
} {
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncActivity, setSyncActivity] = useState<SyncActivity>('idle');
  const [syncFilesRemaining, setSyncFilesRemaining] = useState(0);

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

  return { syncError, setSyncError, syncActivity, syncFilesRemaining };
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
  return 'tagName' in dim ? tagColumnName(dim.tagName) : dim.name;
}

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
      className="min-h-screen flex flex-col items-center justify-center"
      style={{ background: '#0a0a0a', WebkitAppRegion: 'drag' } as React.CSSProperties}
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
  const [missingPeriods, setMissingPeriods] = useState(0);
  const [isDark, setIsDark] = useState(true);
  const [palette, setPalette] = useState<'standard' | 'colorblind'>('standard');
  const [defaultViewId, setDefaultViewIdState] = useState<string>(OVERVIEW_SEED_VIEW.id);
  const [setupCheck, setSetupCheck] = useState<SetupCheck>({ status: 'checking' });
  const [splashStep, setSplashStep] = useState('Connecting...');
  const [viewsConfig, setViewsConfig] = useState<ViewsConfig | null>(null);
  const { syncError, setSyncError, syncActivity, syncFilesRemaining } = useSyncPolling(api, setupCheck);
  const [debugOpen, setDebugOpen] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [clearingCache, setClearingCache] = useState(false);
  const [reloadConfirmOpen, setReloadConfirmOpen] = useState(false);
  const inFlightCount = useDebugBadge();
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ state: 'idle' });
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false);
  const [appVersion, setAppVersion] = useState('');
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

  useEffect(() => {
    return globalThis.costgoblinUpdate.onStatusChanged(setUpdateStatus);
  }, []);

  useEffect(() => {
    if (autoOpenRef.current) return;
    if (setupCheck.status !== 'ready') return;
    if (updateStatus.state === 'available' || updateStatus.state === 'downloaded') {
      autoOpenRef.current = true;
      setReleaseNotesOpen(true);
    }
  }, [setupCheck.status, updateStatus.state, autoOpenRef]);

  useEffect(() => {
    async function initialize(): Promise<void> {
      setSplashStep('Checking configuration...');
      const { configured } = await api.getSetupStatus();

      if (!configured) {
        setSetupCheck({ status: 'needs-setup' });
        return;
      }

      await prewarmDimensions(api, setSplashStep);
      setSetupCheck({ status: 'ready' });
    }
    initialize().catch(() => undefined);
  }, [api]);

  useEffect(() => {
    api.getUIPreferences().then(prefs => {
      setIsDark(prefs.theme === 'dark');
      setPalette(prefs.palette);
      const defaultId = prefs.defaultViewId ?? OVERVIEW_SEED_VIEW.id;
      setDefaultViewIdState(defaultId);
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
    setDefaultViewIdState(id);
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

  useEffect(() => {
    if (setupCheck.status !== 'ready') return;
    Promise.all([api.getDataInventory(), api.getConfig()]).then(([inv, config]) => {
      const retentionDays = config.providers[0]?.sync.daily.retentionDays ?? 365;
      const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
      const cutoffPeriod = `${String(cutoff.getFullYear())}-${String(cutoff.getMonth() + 1).padStart(2, '0')}`;
      const missing = inv.periods.filter(p => p.localStatus === 'missing' && p.period >= cutoffPeriod).length;
      setMissingPeriods(missing);
      setSyncError(null);
    }).catch((err: unknown) => {
      // Most common cause is expired AWS credentials — surface the
      // message on the Sync nav indicator. Swallowed silently before,
      // which left the user on a screen that looked fine while sync
      // was completely broken.
      const message = err instanceof Error ? err.message : String(err);
      setSyncError(message);
    });
  }, [api, view, setupCheck, setSyncError]);

  function handleNavClick(id: string) {
    const alreadyActive = view.page === 'custom' ? view.viewId === id : view.page === id;
    if (alreadyActive) return;
    confirmLeave(() => {
      api.cancelPendingQueries().catch(() => undefined);
      switch (id) {
        case 'trends': setView({ page: 'trends' }); break;
        case 'missing-tags': setView({ page: 'missing-tags' }); break;
        case 'savings': setView({ page: 'savings' }); break;
        case 'explorer': setView({ page: 'explorer' }); break;
        case 'budgets': setView({ page: 'budgets' }); break;
        case 'cost-scope': setView({ page: 'cost-scope' }); break;
        case 'dimensions': setView({ page: 'dimensions' }); break;
        case 'views-editor': setView({ page: 'views-editor' }); break;
        case 'sync': setView({ page: 'sync' }); break;
        case 'mcp': setView({ page: 'mcp' }); break;
        default:
          // Anything else is a custom view id (every left-nav entry that
          // isn't one of the well-known static pages above).
          setView({ page: 'custom', viewId: id });
      }
    });
  }

  function handleEntityClick(entity: string, dimension: string) {
    confirmLeave(() => {
      api.cancelPendingQueries().catch(() => undefined);
      const firstId = viewsConfig?.views[0]?.id ?? OVERVIEW_SEED_VIEW.id;
      const initialFilter: FilterMap = { [asDimensionId(dimension)]: [asTagValue(entity)] };
      setView({ page: 'custom', viewId: firstId, initialFilter });
    });
  }

  function handleSetupComplete() {
    setSetupCheck({ status: 'ready' });
    setView({ page: 'sync' });
  }

  const views = viewsConfig ?? FALLBACK_VIEWS;
  const viewsReady = viewsConfig !== null;
  const customNav: { id: string; name: string }[] = views.views.map(v => ({ id: v.id, name: v.name }));

  const paletteItems: NavItem[] = useMemo(() => [
    ...customNav.map(n => ({ id: n.id, label: n.name, group: 'Dashboards' })),
    ...ANALYTICAL_NAV.map(n => ({ id: n.id, label: n.label, group: 'Analysis' })),
    ...SETTINGS_NAV.map(n => ({ id: n.id, label: n.label, group: 'Settings' })),
  ], [customNav]);

  if (setupCheck.status === 'checking') {
    return <SplashScreen step={splashStep} />;
  }

  if (setupCheck.status === 'needs-setup') {
    return <SetupWizard onComplete={handleSetupComplete} />;
  }

  function activeNavId(): string | null {
    if (view.page === 'custom') return view.viewId;
    if (view.page === 'trends') return 'trends';
    if (view.page === 'missing-tags') return 'missing-tags';
    if (view.page === 'savings') return 'savings';
    if (view.page === 'explorer') return 'explorer';
    if (view.page === 'budgets') return 'budgets';
    if (view.page === 'cost-scope') return 'cost-scope';
    if (view.page === 'dimensions') return 'dimensions';
    if (view.page === 'views-editor') return 'views-editor';
    if (view.page === 'sync') return 'sync';
    if (view.page === 'mcp') return 'mcp';
    return null;
  }
  const active = activeNavId();

  function findViewSpec(id: string): ViewSpec | null {
    return views.views.find(v => v.id === id) ?? null;
  }

  return (
    <PaletteProvider palette={palette}>
      <CommandPalette items={paletteItems} onNavigate={handleNavClick} />
      <div className="min-h-screen bg-bg-primary text-text-primary">
        <SyncAnnouncer
          syncError={syncError}
          syncActivity={syncActivity}
          syncFilesRemaining={syncFilesRemaining}
          missingPeriods={missingPeriods}
        />
        {/* Title bar + nav */}
        <div ref={headerRef} className="sticky top-0 z-50 bg-bg-primary/80 backdrop-blur-sm border-b border-border [-webkit-app-region:drag]">
        <nav className="grid grid-cols-[1fr_auto_1fr] items-center px-4 pt-7 pb-2">
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
          <div className="flex flex-col items-center justify-center px-4">
            <span className="text-sm font-bold text-accent tracking-wider leading-tight">CostGoblin</span>
            <div className="flex items-center gap-1.5 text-[10px] text-text-muted">
              {appVersion !== '' && <span>v{appVersion}</span>}
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
            {(() => {
              const showError = syncError !== null;
              const showActive = !showError && syncActivity !== 'idle';
              const showMissing = !showError && syncActivity === 'idle' && missingPeriods > 0 && view.page !== 'sync';
              return (
                <button
                  type="button"
                  onClick={() => { handleNavClick('sync'); }}
                  className={[
                    'relative px-3 py-1.5 text-sm font-medium rounded-md transition-colors flex items-center gap-2',
                    active === 'sync'
                      ? 'bg-bg-tertiary text-text-primary'
                      : 'text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/50',
                    showError ? 'ring-1 ring-negative/60' : '',
                    showActive ? 'animate-sync-blink' : '',
                  ].join(' ')}
                  title={syncError === null ? undefined : `Sync error — ${syncError}`}
                  aria-current={active === 'sync' ? 'page' : undefined}
                  aria-label="Sync"
                >
                  {showError && (
                    <span className="inline-flex h-2 w-2 shrink-0 rounded-full bg-negative animate-pulse" aria-hidden="true" />
                  )}
                  {showActive && syncActivity === 'downloading' && (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" />
                      <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                  )}
                  {showActive && syncActivity === 'syncing' && (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 animate-spin">
                      <polyline points="23 4 23 10 17 10" />
                      <polyline points="1 20 1 14 7 14" />
                      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" />
                      <path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14" />
                    </svg>
                  )}
                  Sync
                  {showError && (
                    <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-negative px-1 text-[10px] font-bold text-white">
                      !
                    </span>
                  )}
                  {showActive && syncFilesRemaining > 0 && (
                    <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-white">
                      {String(syncFilesRemaining)}
                    </span>
                  )}
                  {showMissing && (
                    <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-warning px-1 text-[10px] font-bold text-bg-primary">
                      {String(missingPeriods)}
                    </span>
                  )}
                </button>
              );
            })()}
            <OptionsMenu
              isDark={isDark}
              onToggleTheme={handleToggleTheme}
              palette={palette}
              onTogglePalette={handleTogglePalette}
              activeNavId={active}
              onNavigate={handleNavClick}
              updateStatus={updateStatus}
              onShowReleaseNotes={() => { setReleaseNotesOpen(true); }}
              onCheckForUpdates={handleCheckForUpdates}
            />
          </nav>
        </nav>
      </div>

      {/* View content — wrapped in a keyed container so "clear cache"
          forces every mounted view to remount and refetch. */}
      <div key={`refresh-${String(refreshNonce)}`}>
        {view.page === 'custom' && viewsReady && (() => {
          const spec = findViewSpec(view.viewId) ?? OVERVIEW_SEED_VIEW;
          return (
            <Profiler id={`custom:${view.viewId}`} onRender={onPerfRender}>
              <CustomView spec={spec} headerSubtitle="Cloud spending visibility" initialFilter={view.initialFilter} />
            </Profiler>
          );
        })()}
        {view.page === 'trends' && (
          <Profiler id="trends" onRender={onPerfRender}>
            <CostTrends onEntityClick={handleEntityClick} />
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
        {view.page === 'explorer' && (
          <Profiler id="explorer" onRender={onPerfRender}>
            <ExplorerView />
          </Profiler>
        )}
        {view.page === 'budgets' && (
          <Profiler id="budgets" onRender={onPerfRender}>
            <BudgetsView />
          </Profiler>
        )}
        {view.page === 'cost-scope' && (
          <Profiler id="cost-scope" onRender={onPerfRender}>
            <CostScopeView />
          </Profiler>
        )}
        {view.page === 'dimensions' && (
          <Profiler id="dimensions" onRender={onPerfRender}>
            <DimensionsView />
          </Profiler>
        )}
        {view.page === 'views-editor' && (
          <Profiler id="views-editor" onRender={onPerfRender}>
            <ViewsEditor onConfigPersisted={setViewsConfig} />
          </Profiler>
        )}
        {view.page === 'mcp' && (
          <McpView />
        )}
        <div className={view.page === 'sync' ? '' : 'hidden'}>
          <Profiler id="sync" onRender={onPerfRender}>
            <DataManagement />
          </Profiler>
        </div>
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
