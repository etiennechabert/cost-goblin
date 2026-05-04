import { useState, useEffect, useCallback, useMemo, useRef, Profiler } from 'react';
import { CostTrends, MissingTags, Savings, DataManagement, DimensionsView, CostScopeView, ExplorerView, CostApiProvider, useCostApi, SetupWizard, ErrorBoundary, CustomView, OVERVIEW_SEED_VIEW, ViewsEditor, UnsavedChangesProvider, useConfirmLeave, PaletteProvider, CommandPalette, CoinRainLoader, Dialog, DialogContent, DialogTitle, DialogDescription, DialogClose, Button } from '@costgoblin/ui';
import type { NavItem } from '@costgoblin/ui';
import type { CostApi, FilterMap, ViewsConfig, ViewSpec, UpdateStatus } from '@costgoblin/core/browser';
import { asDimensionId, asTagValue } from '@costgoblin/core/browser';
import { Download, RefreshCw } from 'lucide-react';
import { DebugPanel, useDebugBadge } from './debug-panel.js';

// ---------------------------------------------------------------------------
// React Profiler — collects render timings when perf mode is active
// ---------------------------------------------------------------------------
const perfEnabled = globalThis.costgoblinPerf !== undefined;
const isDev = globalThis.costgoblinDebug.isDev();
const renderTimings: RenderTiming[] = [];

function RamBadge(): React.JSX.Element {
  const [mb, setMb] = useState(0);
  useEffect(() => {
    function update(): void {
      void globalThis.costgoblinDebug.getMemoryMB().then(setMb);
    }
    update();
    const id = setInterval(update, 1000);
    return () => { clearInterval(id); };
  }, []);
  return (
    <span className="absolute -top-3 left-1/2 -translate-x-1/2 text-[11px] font-medium tabular-nums text-text-secondary whitespace-nowrap">
      {mb} MB
    </span>
  );
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
  | { page: 'explorer' }
  | { page: 'dimensions' }
  | { page: 'cost-scope' }
  | { page: 'views-editor' }
  | { page: 'sync' };

const STATIC_LEFT_NAV: { id: string; label: string }[] = [
  { id: 'trends', label: 'Trends' },
  { id: 'savings', label: 'Findings' },
  { id: 'missing-tags', label: 'Tags' },
  { id: 'explorer', label: 'Explorer' },
];

const RIGHT_NAV: { id: string; label: string }[] = [
  { id: 'cost-scope', label: 'Cost Scope' },
  { id: 'dimensions', label: 'Dimensions' },
  { id: 'views-editor', label: 'Views' },
  { id: 'sync', label: 'Sync' },
];

function SunIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

function PaletteIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
      <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
      <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
      <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
      <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z" />
    </svg>
  );
}

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
  syncActivity: 'idle' | 'syncing' | 'downloading';
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

function UpdateNotification({
  status,
  onShowReleaseNotes,
}: Readonly<{
  status: UpdateStatus;
  onShowReleaseNotes: () => void;
}>): React.JSX.Element | null {
  if (status.state === 'available') {
    return (
      <button
        type="button"
        onClick={onShowReleaseNotes}
        className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-accent hover:bg-bg-tertiary/50 transition-colors"
      >
        <Download size={14} />
        v{status.info.version} available
      </button>
    );
  }
  if (status.state === 'downloading') {
    return (
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-text-secondary">
        <RefreshCw size={14} className="animate-spin" />
        Downloading {String(status.percent)}%
      </div>
    );
  }
  if (status.state === 'downloaded') {
    return (
      <button
        type="button"
        onClick={onShowReleaseNotes}
        className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-positive hover:bg-bg-tertiary/50 transition-colors"
      >
        <Download size={14} />
        Restart to update
      </button>
    );
  }
  return null;
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
  if (status.state !== 'available' && status.state !== 'downloaded') return null;
  const { info } = status;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>
          {status.state === 'downloaded' ? 'Ready to Install' : 'Update Available'} &mdash; v{info.version}
        </DialogTitle>
        <DialogDescription>
          Released {info.releaseDate}
        </DialogDescription>
        {info.releaseNotes !== null && (
          <div className="mt-3 max-h-60 overflow-y-auto rounded-md bg-bg-primary p-3 text-sm text-text-secondary whitespace-pre-wrap">
            {info.releaseNotes}
          </div>
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
                onOpenChange(false);
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

function useSyncPolling(
  api: CostApi,
  setupCheck: SetupCheck,
): {
  syncError: string | null;
  setSyncError: React.Dispatch<React.SetStateAction<string | null>>;
  syncActivity: 'idle' | 'syncing' | 'downloading';
  syncFilesRemaining: number;
} {
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncActivity, setSyncActivity] = useState<'idle' | 'syncing' | 'downloading'>('idle');
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
        const failed = [daily, hourly, costOpt].find(s => s.status === 'failed');
        if (failed !== undefined || autoStatus.state === 'error') {
          let msg = 'Sync failed';
          if (autoStatus.state === 'error') msg = autoStatus.message;
          else if (failed?.status === 'failed') msg = failed.error.message;
          setSyncError(msg);
          setSyncActivity('idle');
        } else {
          const downloading = daily.status === 'syncing' || hourly.status === 'syncing' || costOpt.status === 'syncing' || autoStatus.state === 'syncing';
          let activity: 'idle' | 'syncing' | 'downloading' = 'idle';
          if (downloading) activity = 'downloading';
          else if (autoStatus.state === 'checking') activity = 'syncing';
          setSyncActivity(activity);
          let remaining = 0;
          for (const s of [daily, hourly, costOpt]) {
            if (s.status === 'syncing') remaining += s.filesTotal - s.filesDone;
          }
          setSyncFilesRemaining(remaining);
          setSyncError(downloading ? null : (prev => (prev?.includes('AWS credentials') ? prev : null)));
        }
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
const SPLASH_DURATION = 2500;

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

function SplashScreen(): React.JSX.Element {
  const [order] = useState(() => shuffled(SPLASH_IMAGES));
  const [index, setIndex] = useState(0);
  const [fadeOut, setFadeOut] = useState(false);

  useEffect(() => {
    const rotate = setInterval(() => {
      setIndex(prev => (prev + 1) % SPLASH_IMAGES.length);
    }, SPLASH_INTERVAL);
    const fade = setTimeout(() => { setFadeOut(true); }, SPLASH_DURATION - 400);
    return () => { clearInterval(rotate); clearTimeout(fade); };
  }, []);

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center transition-opacity duration-500"
      style={{ opacity: fadeOut ? 0 : 1, background: '#0a0a0a', WebkitAppRegion: 'drag' } as React.CSSProperties}
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
      <p className="text-sm text-text-muted mb-8">Crunching your cloud costs...</p>
      <div className="w-64">
        <CoinRainLoader height={120} count={6} />
      </div>
    </div>
  );
}

function AppShell(): React.JSX.Element {
  const api = useCostApi();
  const confirmLeave = useConfirmLeave();
  const [view, setView] = useState<View>({ page: 'custom', viewId: 'overview' });
  const [missingPeriods, setMissingPeriods] = useState(0);
  const [isDark, setIsDark] = useState(true);
  const [palette, setPalette] = useState<'standard' | 'colorblind'>('standard');
  const [setupCheck, setSetupCheck] = useState<SetupCheck>({ status: 'checking' });
  const splashMinElapsed = useRef(false);
  const [viewsConfig, setViewsConfig] = useState<ViewsConfig | null>(null);
  const { syncError, setSyncError, syncActivity, syncFilesRemaining } = useSyncPolling(api, setupCheck);
  const [debugOpen, setDebugOpen] = useState(false);
  const inFlightCount = useDebugBadge();
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ state: 'idle' });
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false);

  useEffect(() => {
    return globalThis.costgoblinUpdate.onStatusChanged(setUpdateStatus);
  }, []);

  useEffect(() => {
    const skipSplash = globalThis.costgoblinDebug.isE2E();
    const minTimer = skipSplash
      ? Promise.resolve()
      : new Promise<void>(resolve => {
          setTimeout(() => { splashMinElapsed.current = true; resolve(); }, SPLASH_DURATION);
        });
    const statusCheck = api.getSetupStatus().then(({ configured }) => configured);
    // Pre-fetch dimensions during splash so they're cached when the dashboard mounts
    void api.getDimensions().catch(() => undefined);

    void Promise.all([statusCheck, minTimer]).then(([configured]) => {
      setSetupCheck(configured ? { status: 'ready' } : { status: 'needs-setup' });
    }).catch(() => undefined);
  }, [api]);

  useEffect(() => {
    api.getUIPreferences().then(prefs => {
      setIsDark(prefs.theme === 'dark');
      setPalette(prefs.palette);
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
    api.saveUIPreferences({ theme: next ? 'dark' : 'light', palette }).catch(() => undefined);
  }

  function handleTogglePalette() {
    const next: 'standard' | 'colorblind' = palette === 'standard' ? 'colorblind' : 'standard';
    setPalette(next);
    api.saveUIPreferences({ theme: isDark ? 'dark' : 'light', palette: next }).catch(() => undefined);
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
        case 'cost-scope': setView({ page: 'cost-scope' }); break;
        case 'dimensions': setView({ page: 'dimensions' }); break;
        case 'views-editor': setView({ page: 'views-editor' }); break;
        case 'sync': setView({ page: 'sync' }); break;
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
  const customNav: { id: string; label: string }[] = views.views.map(v => ({ id: v.id, label: v.name }));
  const leftNav = [...customNav, ...STATIC_LEFT_NAV];

  const paletteItems: NavItem[] = useMemo(() => [
    ...customNav.map(n => ({ id: n.id, label: n.label, group: 'Dashboards' })),
    ...STATIC_LEFT_NAV.map(n => ({ id: n.id, label: n.label, group: 'Analysis' })),
    ...RIGHT_NAV.map(n => ({ id: n.id, label: n.label, group: 'Settings' })),
  ], [customNav]);

  if (setupCheck.status === 'checking') {
    return <SplashScreen />;
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
    if (view.page === 'cost-scope') return 'cost-scope';
    if (view.page === 'dimensions') return 'dimensions';
    if (view.page === 'views-editor') return 'views-editor';
    if (view.page === 'sync') return 'sync';
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
        <div className="sticky top-0 z-50 bg-bg-primary/80 backdrop-blur-sm border-b border-border [-webkit-app-region:drag]">
        <nav className="grid grid-cols-[1fr_auto_1fr] items-center px-4 pt-7 pb-2">
          <nav className="flex items-center gap-1" aria-label="Analytical views">
            {leftNav.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => { handleNavClick(item.id); }}
                className={[
                  'px-3 py-1.5 text-sm font-medium rounded-md transition-colors [-webkit-app-region:no-drag]',
                  active === item.id
                    ? 'bg-bg-tertiary text-text-primary'
                    : 'text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/50',
                ].join(' ')}
                aria-current={active === item.id ? 'page' : undefined}
              >
                {item.label}
              </button>
            ))}
          </nav>
          <div className="flex items-center justify-center gap-2 px-4 relative">
            {isDev && <RamBadge />}
            <img src="goblin.png" alt="" className="h-8 w-auto object-contain" />
            <span className="text-sm font-bold text-accent tracking-wider">CostGoblin</span>
          </div>
          <nav className="flex items-center justify-end gap-1 [-webkit-app-region:no-drag]" aria-label="Configuration views">
            <UpdateNotification status={updateStatus} onShowReleaseNotes={() => { setReleaseNotesOpen(true); }} />
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
            >
              <TerminalIcon />
              {inFlightCount > 0 && (
                <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-white">
                  {String(inFlightCount)}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={handleToggleTheme}
              className="rounded-md p-1.5 text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
              aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {isDark ? <SunIcon /> : <MoonIcon />}
            </button>
            <button
              type="button"
              onClick={handleTogglePalette}
              className="rounded-md p-1.5 text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
              aria-label={palette === 'standard' ? 'Switch to colorblind palette' : 'Switch to standard palette'}
            >
              <PaletteIcon />
            </button>
            {RIGHT_NAV.map((item) => {
              const isSync = item.id === 'sync';
              const showError = isSync && syncError !== null;
              const showActive = isSync && !showError && syncActivity !== 'idle';
              const showMissing = isSync && !showError && syncActivity === 'idle' && missingPeriods > 0 && view.page !== 'sync';
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => { handleNavClick(item.id); }}
                  className={[
                    'relative px-3 py-1.5 text-sm font-medium rounded-md transition-colors flex items-center gap-2',
                    active === item.id
                      ? 'bg-bg-tertiary text-text-primary'
                      : 'text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/50',
                    showError ? 'ring-1 ring-negative/60' : '',
                    showActive ? 'animate-sync-blink' : '',
                  ].join(' ')}
                  title={syncError === null ? undefined : `Sync error — ${syncError}`}
                  aria-current={active === item.id ? 'page' : undefined}
                >
                  {showError && (
                    <span className="inline-flex h-2 w-2 shrink-0 rounded-full bg-negative animate-pulse" aria-label="sync error" />
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
                  {item.label}
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
            })}
          </nav>
        </nav>
      </div>

      {/* View content */}
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
      <div className={view.page === 'sync' ? '' : 'hidden'}>
        <Profiler id="sync" onRender={onPerfRender}>
          <DataManagement />
        </Profiler>
      </div>
      {debugOpen && <DebugPanel onClose={() => { setDebugOpen(false); }} />}
      <ReleaseNotesModal open={releaseNotesOpen} onOpenChange={setReleaseNotesOpen} status={updateStatus} />
      </div>
    </PaletteProvider>
  );
}
