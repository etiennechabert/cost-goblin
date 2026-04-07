import { useCostFocus, useCostFocusDispatch } from '../hooks/use-cost-focus.js';

export function FilterActiveBanner() {
  const focus = useCostFocus();
  const dispatch = useCostFocusDispatch();

  const hasEnvironment = focus.environment !== null;
  const hasDrill = focus.serviceDrill.depth !== 'none';

  if (!hasEnvironment && !hasDrill) return null;

  return (
    <div className="flex items-center justify-between rounded-lg border border-accent/30 bg-accent/5 px-4 py-3">
      <div className="flex flex-col gap-0.5 text-sm">
        <span className="font-medium text-text-primary">Filter active</span>
        <div className="flex flex-col gap-0.5 text-text-secondary">
          {hasDrill && (
            <span>
              {'Showing costs for '}
              <strong className="text-accent">{focus.serviceDrill.service}</strong>
              {focus.serviceDrill.depth === 'serviceFamily' && (
                <>
                  {' → '}
                  <strong className="text-accent">{focus.serviceDrill.family}</strong>
                </>
              )}
            </span>
          )}
          {hasEnvironment && (
            <span>
              {'Environment: '}
              <strong className="text-accent">{focus.environment}</strong>
            </span>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={() => { dispatch({ type: 'CLEAR_ALL' }); }}
        className="ml-4 rounded-md p-1.5 text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M1 1l12 12M13 1L1 13" />
        </svg>
      </button>
    </div>
  );
}
