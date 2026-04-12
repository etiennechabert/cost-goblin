import { useState, useEffect } from 'react';
import { CostOverview, CostTrends, MissingTags, Savings, EntityDetail, DataManagement, CostApiProvider, SetupWizard, ErrorBoundary } from '@costgoblin/ui';
import type { CostApi } from '@costgoblin/core/browser';

function getApi(): CostApi {
  return window.costgoblin;
}

type View =
  | { page: 'setup' }
  | { page: 'overview' }
  | { page: 'trends' }
  | { page: 'missing-tags' }
  | { page: 'savings' }
  | { page: 'data' }
  | { page: 'entity-detail'; entity: string; dimension: string };

const LEFT_NAV: { id: string; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'trends', label: 'Trends' },
  { id: 'missing-tags', label: 'Missing Tags' },
  { id: 'savings', label: 'Savings' },
];

function getStoredTheme(): 'dark' | 'light' {
  try {
    const stored = localStorage.getItem('costgoblin-theme');
    if (stored === 'light') return 'light';
  } catch {
    // localStorage unavailable
  }
  return 'dark';
}

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

export function App(): React.JSX.Element {
  const api = getApi();
  const [view, setView] = useState<View>({ page: 'overview' });
  const [missingPeriods, setMissingPeriods] = useState(0);
  const [isDark, setIsDark] = useState(() => getStoredTheme() === 'dark');
  const [setupCheck, setSetupCheck] = useState<SetupCheck>({ status: 'checking' });

  useEffect(() => {
    void api.getSetupStatus().then(({ configured }) => {
      setSetupCheck(configured ? { status: 'ready' } : { status: 'needs-setup' });
    });
  }, [api]);

  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    try {
      localStorage.setItem('costgoblin-theme', isDark ? 'dark' : 'light');
    } catch {
      // localStorage unavailable
    }
  }, [isDark]);

  useEffect(() => {
    if (setupCheck.status !== 'ready') return;
    void api.getDataInventory().then((inv) => {
      const missing = inv.periods.filter(p => p.localStatus === 'missing').length;
      setMissingPeriods(missing);
    }).catch(() => {
      // ignore — S3 may not be configured yet
    });
  }, [api, view, setupCheck]);

  function handleNavClick(id: string) {
    switch (id) {
      case 'overview': setView({ page: 'overview' }); break;
      case 'trends': setView({ page: 'trends' }); break;
      case 'missing-tags': setView({ page: 'missing-tags' }); break;
      case 'savings': setView({ page: 'savings' }); break;
      case 'data': setView({ page: 'data' }); break;
    }
  }

  function handleEntityClick(entity: string, dimension: string) {
    setView({ page: 'entity-detail', entity, dimension });
  }

  function handleBack() {
    setView({ page: 'overview' });
  }

  function handleToggleTheme() {
    setIsDark(prev => !prev);
  }

  function handleSetupComplete() {
    setSetupCheck({ status: 'ready' });
    setView({ page: 'data' });
  }

  if (setupCheck.status === 'checking') {
    return (
      <CostApiProvider value={api}>
        <div className="min-h-screen bg-bg-primary" />
      </CostApiProvider>
    );
  }

  if (setupCheck.status === 'needs-setup') {
    return (
      <CostApiProvider value={api}>
        <SetupWizard onComplete={handleSetupComplete} />
      </CostApiProvider>
    );
  }

  return (
    <ErrorBoundary>
    <CostApiProvider value={api}>
      <div className="min-h-screen bg-bg-primary text-text-primary">
        {/* Title bar + nav */}
        <div className="sticky top-0 z-50 bg-bg-primary/80 backdrop-blur-sm border-b border-border">
          <div className="h-10 flex items-center justify-center gap-2 px-4 [-webkit-app-region:drag]">
            <img src="goblin.png" alt="" className="h-7 w-7 object-contain" />
            <span className="text-sm font-bold text-accent tracking-wider">CostGoblin</span>
          </div>
          <nav className="flex items-center justify-between px-4 pb-2">
            <div className="flex items-center gap-1">
              {LEFT_NAV.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => { handleNavClick(item.id); }}
                  className={[
                    'px-3 py-1.5 text-sm font-medium rounded-md transition-colors [-webkit-app-region:no-drag]',
                    view.page === item.id
                      ? 'bg-bg-tertiary text-text-primary'
                      : 'text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/50',
                  ].join(' ')}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1 [-webkit-app-region:no-drag]">
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
                onClick={() => { handleNavClick('data'); }}
                className={[
                  'relative px-3 py-1.5 text-sm font-medium rounded-md transition-colors',
                  view.page === 'data'
                    ? 'bg-bg-tertiary text-text-primary'
                    : 'text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/50',
                ].join(' ')}
              >
                Data
                {missingPeriods > 0 && view.page !== 'data' && (
                  <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-warning px-1 text-[10px] font-bold text-bg-primary">
                    {String(missingPeriods)}
                  </span>
                )}
              </button>
            </div>
          </nav>
        </div>

        {/* View content */}
        {view.page === 'overview' && <CostOverview />}
        {view.page === 'trends' && <CostTrends onEntityClick={handleEntityClick} />}
        {view.page === 'missing-tags' && <MissingTags />}
        {view.page === 'savings' && <Savings />}
        <div className={view.page === 'data' ? '' : 'hidden'}>
          <DataManagement />
        </div>
        {view.page === 'entity-detail' && (
          <EntityDetail
            entity={view.entity}
            dimension={view.dimension}
            onBack={handleBack}
          />
        )}
      </div>
    </CostApiProvider>
    </ErrorBoundary>
  );
}
