import { useState, useEffect, Profiler } from 'react';
import { CostTrends, MissingTags, Savings, EntityDetail, DataManagement, DimensionsView, CostScopeView, ExplorerView, CostApiProvider, useCostApi, SetupWizard, ErrorBoundary, CustomView, OVERVIEW_SEED_VIEW, ViewsEditor, UnsavedChangesProvider, useConfirmLeave } from '@costgoblin/ui';
import type { CostApi, ViewsConfig, ViewSpec } from '@costgoblin/core/browser';

// ---------------------------------------------------------------------------
// React Profiler — collects render timings when perf mode is active
// ---------------------------------------------------------------------------
const perfEnabled = globalThis.costgoblinPerf !== undefined;
const renderTimings: RenderTiming[] = [];

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
  | { page: 'custom'; viewId: string }
  | { page: 'trends' }
  | { page: 'missing-tags' }
  | { page: 'savings' }
  | { page: 'explorer' }
  | { page: 'dimensions' }
  | { page: 'cost-scope' }
  | { page: 'views-editor' }
  | { page: 'sync' }
  | { page: 'entity-detail'; entity: string; dimension: string };

const STATIC_LEFT_NAV: { id: string; label: string }[] = [
  { id: 'trends', label: 'Trends' },
  { id: 'missing-tags', label: 'Missing Tags' },
  { id: 'savings', label: 'Savings' },
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

type SetupCheck =
  | { status: 'checking' }
  | { status: 'needs-setup' }
  | { status: 'ready' };

const FALLBACK_VIEWS: ViewsConfig = { views: [OVERVIEW_SEED_VIEW] };

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

function AppShell(): React.JSX.Element {
  const api = useCostApi();
  const confirmLeave = useConfirmLeave();
  const [view, setView] = useState<View>({ page: 'custom', viewId: 'overview' });
  const [missingPeriods, setMissingPeriods] = useState(0);
  const [isDark, setIsDark] = useState(true);
  const [setupCheck, setSetupCheck] = useState<SetupCheck>({ status: 'checking' });
  const [viewsConfig, setViewsConfig] = useState(FALLBACK_VIEWS);
  // Sync-health signal. Non-null whenever something AWS-side is broken —
  // most commonly expired credentials. Surfaced as a red dot on the Sync
  // nav button so the user notices without having to open the tab.
  const [syncError, setSyncError] = useState<string | null>(null);

  useEffect(() => {
    void api.getSetupStatus().then(({ configured }) => {
      setSetupCheck(configured ? { status: 'ready' } : { status: 'needs-setup' });
    });
  }, [api]);

  useEffect(() => {
    void api.getUIPreferences().then(prefs => {
      setIsDark(prefs.theme === 'dark');
    });
  }, [api]);

  useEffect(() => {
    if (setupCheck.status !== 'ready') return;
    // Read views.yaml. The handler seeds it lazily on first access so this
    // call also bootstraps the file for new installations.
    api.getViewsConfig()
      .then((cfg) => {
        if (cfg.views.length > 0) {
          setViewsConfig(cfg);
          setView(prev => {
            if (prev.page !== 'custom') return prev;
            const exists = cfg.views.some(v => v.id === prev.viewId);
            const firstId = cfg.views[0]?.id;
            return exists || firstId === undefined ? prev : { page: 'custom', viewId: firstId };
          });
        }
      })
      .catch(() => {
        // Keep fallback — ensures Cost Overview always renders even if YAML
        // parsing fails (corrupted file, schema migration in progress).
      });
  }, [api, setupCheck]);

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
    void api.saveUIPreferences({ theme: next ? 'dark' : 'light' });
  }

  useEffect(() => {
    if (setupCheck.status !== 'ready') return;
    void Promise.all([api.getDataInventory(), api.getConfig()]).then(([inv, config]) => {
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
  }, [api, view, setupCheck]);

  // Independent auto-sync polling — catches background-sync failures
  // even when the user isn't on the Sync tab. The inventory effect above
  // only fires on navigation, so without this a silent auto-sync error
  // wouldn't surface until the user happened to revisit Sync.
  useEffect(() => {
    if (setupCheck.status !== 'ready') return;
    let cancelled = false;
    async function tick(): Promise<void> {
      try {
        const status = await api.getAutoSyncStatus();
        if (cancelled) return;
        if (status.state === 'error') {
          setSyncError(status.message);
        } else {
          // Only clear errors that came from auto-sync itself — don't
          // stomp a credentials error raised by the inventory fetch.
          setSyncError(prev => (prev !== null && prev.includes('AWS credentials') ? prev : null));
        }
      } catch { /* transient */ }
    }
    void tick();
    const timer = setInterval(() => { void tick(); }, 10_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [api, setupCheck]);

  function handleNavClick(id: string) {
    confirmLeave(() => {
      void api.cancelPendingQueries();
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
      void api.cancelPendingQueries();
      setView({ page: 'entity-detail', entity, dimension });
    });
  }

  function handleBack() {
    confirmLeave(() => {
      void api.cancelPendingQueries();
      const firstId = viewsConfig.views[0]?.id ?? OVERVIEW_SEED_VIEW.id;
      setView({ page: 'custom', viewId: firstId });
    });
  }

  function handleSetupComplete() {
    setSetupCheck({ status: 'ready' });
    setView({ page: 'sync' });
  }

  if (setupCheck.status === 'checking') {
    return <div className="min-h-screen bg-bg-primary" />;
  }

  if (setupCheck.status === 'needs-setup') {
    return <SetupWizard onComplete={handleSetupComplete} />;
  }

  // User-defined views populate the left nav before the static analytical
  // views (Trends / Missing Tags / Savings).
  const customNav: { id: string; label: string }[] = viewsConfig.views.map(v => ({ id: v.id, label: v.name }));
  const leftNav = [...customNav, ...STATIC_LEFT_NAV];

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
    return viewsConfig.views.find(v => v.id === id) ?? null;
  }

  return (
    <div className="min-h-screen bg-bg-primary text-text-primary">
      {/* Title bar + nav */}
      <div className="sticky top-0 z-50 bg-bg-primary/80 backdrop-blur-sm border-b border-border [-webkit-app-region:drag]">
        <nav className="grid grid-cols-[1fr_auto_1fr] items-center px-4 pt-7 pb-2">
          <div className="flex items-center gap-1">
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
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="flex items-center justify-center gap-2 px-4">
            <img src="goblin.png" alt="" className="h-8 w-auto object-contain" />
            <span className="text-sm font-bold text-accent tracking-wider">CostGoblin</span>
          </div>
          <div className="flex items-center justify-end gap-1 [-webkit-app-region:no-drag]">
            <button
              type="button"
              onClick={handleToggleTheme}
              className="rounded-md p-1.5 text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
              aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {isDark ? <SunIcon /> : <MoonIcon />}
            </button>
            {RIGHT_NAV.map((item) => {
              const isSync = item.id === 'sync';
              const showError = isSync && syncError !== null;
              const showMissing = isSync && !showError && missingPeriods > 0 && view.page !== 'sync';
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
                  ].join(' ')}
                  title={syncError !== null ? `Sync error — ${syncError}` : undefined}
                >
                  {showError && (
                    <span className="inline-flex h-2 w-2 shrink-0 rounded-full bg-negative animate-pulse" aria-label="sync error" />
                  )}
                  {item.label}
                  {showError && (
                    <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-negative px-1 text-[10px] font-bold text-white">
                      !
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
          </div>
        </nav>
      </div>

      {/* View content */}
      {view.page === 'custom' && (() => {
        const spec = findViewSpec(view.viewId) ?? OVERVIEW_SEED_VIEW;
        return (
          <Profiler id={`custom:${view.viewId}`} onRender={onPerfRender}>
            <CustomView spec={spec} headerSubtitle="Cloud spending visibility" onEntityClick={handleEntityClick} />
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
          <MissingTags />
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
      {view.page === 'entity-detail' && (
        <Profiler id="entity-detail" onRender={onPerfRender}>
          <EntityDetail
            entity={view.entity}
            dimension={view.dimension}
            onBack={handleBack}
          />
        </Profiler>
      )}
    </div>
  );
}
