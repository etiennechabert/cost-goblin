import { useState } from 'react';
import type { QueryEngineStatus } from '@costgoblin/core/browser';
import { TriangleAlert, X } from 'lucide-react';

interface QueryEngineNoticeProps {
  readonly status: QueryEngineStatus;
  /** Start a stopped engine again. */
  readonly onRestart: () => void;
  /** Let the app build the rollup on its own again, starting now. */
  readonly onResumeRollupBuilds: () => void;
  /** Run the current view's queries again, then call `done`. Not calling it
   *  (the user chose to stay on a page with unsaved edits) leaves the notice
   *  up, for another try. */
  readonly onReload: (done: () => void) => void;
  readonly onOpenPerformance: () => void;
}

const ACTION = 'inline-flex shrink-0 items-center rounded-md px-2.5 py-1 text-xs font-medium transition-colors';
const PRIMARY = `${ACTION} bg-bg-tertiary text-text-primary hover:bg-bg-tertiary/70`;
const SECONDARY = `${ACTION} text-text-secondary hover:text-text-primary`;

/** App-wide notice about the query engine (the DuckDB process), in the header
 *  so it shows on every page and never covers one:
 *  - restarting / restarted: it stopped unexpectedly; the queries it was
 *    running failed, so the view can be reloaded. Dismissible, once per
 *    restart.
 *  - stopped: it kept stopping and was not restarted. Stays until the user
 *    restarts it: nothing can be queried meanwhile.
 *  - rollup build paused: what follows a restart from `stopped`. Stays until
 *    the user asks for the rollup, since nothing else brings it back short of
 *    a relaunch.
 *  Purely presentational: the parent owns the status and the actions. The
 *  status notices are `<output>` elements: an implicit status live region. */
export function QueryEngineNotice({ status, onRestart, onResumeRollupBuilds, onReload, onOpenPerformance }: Readonly<QueryEngineNoticeProps>): React.JSX.Element | null {
  // The restart (its time) the user has answered, by reloading or dismissing.
  const [answered, setAnswered] = useState<number | null>(null);

  if (status.state === 'stopped') {
    return (
      <div role="alert" className="flex items-center justify-between gap-4 border-b border-negative/40 bg-negative-muted px-4 py-2 [-webkit-app-region:no-drag]">
        <div className="flex min-w-0 items-start gap-2">
          <TriangleAlert size={15} className="mt-0.5 shrink-0 text-negative" aria-hidden="true" />
          <p className="text-xs text-text-secondary">
            <span className="font-medium text-text-primary">
              The query engine stopped {status.deaths} times in {status.windowMinutes} minutes.
            </span>
            {' '}It was not restarted, so no query can run, and the automatic rollup build is paused. Your data is not affected.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" className={SECONDARY} onClick={onOpenPerformance}>Performance settings</button>
          <button type="button" className={PRIMARY} onClick={onRestart}>Restart the query engine</button>
        </div>
      </div>
    );
  }

  if (status.state === 'restarting') {
    return (
      <output className="block border-b border-warning/40 bg-warning-muted px-4 py-1.5 text-xs text-text-secondary [-webkit-app-region:no-drag]">
        The query engine stopped unexpectedly. Restarting it…
      </output>
    );
  }

  if (status.rollupBuildsPaused) {
    const resume = (): void => {
      // The restart that led here is dealt with: once builds are on again,
      // it is not shown as news.
      setAnswered(status.restartedAt);
      onResumeRollupBuilds();
    };
    return (
      <output className="flex items-center justify-between gap-4 border-b border-warning/40 bg-warning-muted px-4 py-2 [-webkit-app-region:no-drag]">
        <p className="min-w-0 text-xs text-text-secondary">
          <span className="font-medium text-text-primary">The rollup build is paused.</span>
          {' '}Dashboards read your exports directly until it is rebuilt, which is slower. If the query engine stops again, lower the memory limit or the rollup build parallelism first.
        </p>
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" className={SECONDARY} onClick={onOpenPerformance}>Performance settings</button>
          <button type="button" className={PRIMARY} onClick={resume}>Rebuild the rollup</button>
        </div>
      </output>
    );
  }

  const { restartedAt } = status;
  if (restartedAt === null || restartedAt === answered) return null;
  return (
    <output className="flex items-center justify-between gap-4 border-b border-warning/40 bg-warning-muted px-4 py-1.5 [-webkit-app-region:no-drag]">
      <p className="min-w-0 text-xs text-text-secondary">
        <span className="font-medium text-text-primary">The query engine restarted.</span>
        {' '}It stopped unexpectedly, so the queries that were running failed.
      </p>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          className={PRIMARY}
          onClick={() => { onReload(() => { setAnswered(restartedAt); }); }}
        >
          Reload view
        </button>
        <button type="button" className={SECONDARY} aria-label="Dismiss" onClick={() => { setAnswered(restartedAt); }}>
          <X size={14} aria-hidden="true" />
        </button>
      </div>
    </output>
  );
}
