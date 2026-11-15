import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueryEngineStatus } from '@costgoblin/core/browser';
import { QueryEngineNotice } from '../components/query-engine-notice.js';

const HEALTHY: QueryEngineStatus = { state: 'running', restartedAt: null, rollupBuildsPaused: false };
const RESTARTED_AT = 1_700_000_000_000;
const RESTARTED: QueryEngineStatus = { state: 'running', restartedAt: RESTARTED_AT, rollupBuildsPaused: false };
const STOPPED: QueryEngineStatus = { state: 'stopped', deaths: 3, windowMinutes: 10, rollupBuildsPaused: true };
const PAUSED: QueryEngineStatus = { state: 'running', restartedAt: 1_700_000_100_000, rollupBuildsPaused: true };

afterEach(() => { cleanup(); });

function setup(status: QueryEngineStatus) {
  const handlers = {
    onRestart: vi.fn<() => void>(),
    onResumeRollupBuilds: vi.fn<() => void>(),
    // Reloads at once, as the app does when the page holds no unsaved edit.
    onReload: vi.fn<(done: () => void) => void>((done) => { done(); }),
    onOpenPerformance: vi.fn<() => void>(),
  };
  const view = render(<QueryEngineNotice status={status} {...handlers} />);
  const show = (next: QueryEngineStatus): void => {
    view.rerender(<QueryEngineNotice status={next} {...handlers} />);
  };
  return { ...handlers, show, container: view.container };
}

describe('QueryEngineNotice', () => {
  it('shows nothing while the engine runs and has never stopped', () => {
    const { container } = setup(HEALTHY);
    expect(container.innerHTML).toBe('');
  });

  it('says the engine is restarting, without asking for anything', () => {
    setup({ state: 'restarting', rollupBuildsPaused: false });
    expect(screen.getByRole('status').textContent).toBe('The query engine stopped unexpectedly. Restarting it…');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('says the engine restarted and what that cost, and offers to run the view again', () => {
    const { onReload } = setup(RESTARTED);

    const notice = screen.getByRole('status');
    expect(notice.textContent).toContain('The query engine restarted');
    expect(notice.textContent).toContain('It stopped unexpectedly, so the queries that were running failed.');

    fireEvent.click(screen.getByRole('button', { name: 'Reload view' }));
    expect(onReload).toHaveBeenCalledTimes(1);
    // Reloading is the answer to the notice: nothing is left to say.
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('stays up when the reload was called off, for another try', () => {
    // The page held unsaved edits and the user chose to stay on it.
    const { onReload } = setup(RESTARTED);
    onReload.mockImplementation(() => undefined);

    fireEvent.click(screen.getByRole('button', { name: 'Reload view' }));

    expect(onReload).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').textContent).toContain('The query engine restarted');
    expect(screen.getByRole('button', { name: 'Reload view' })).toBeDefined();
  });

  it('stays dismissed for that restart, and comes back for the next one', () => {
    const { show, onReload } = setup(RESTARTED);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('status')).toBeNull();
    expect(onReload).not.toHaveBeenCalled();

    // The same restart, told again (another window event, a status pull).
    show({ ...RESTARTED });
    expect(screen.queryByRole('status')).toBeNull();

    show({ state: 'restarting', rollupBuildsPaused: false });
    show({ state: 'running', restartedAt: RESTARTED_AT + 60_000, rollupBuildsPaused: false });
    expect(screen.getByRole('status').textContent).toContain('The query engine restarted');
  });

  it('raises an alert when the engine was not restarted, with the way to start it again', () => {
    const { onRestart, onOpenPerformance } = setup(STOPPED);

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('The query engine stopped 3 times in 10 minutes');
    expect(alert.textContent).toContain('It was not restarted, so no query can run, and the automatic rollup build is paused. Your data is not affected.');
    // Not dismissible: nothing works until it is acted on.
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Restart the query engine' }));
    expect(onRestart).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Performance settings' }));
    expect(onOpenPerformance).toHaveBeenCalledTimes(1);
  });

  it('keeps saying the rollup build is paused once the engine runs again, until it is asked for', () => {
    const { onResumeRollupBuilds, onOpenPerformance, show } = setup(PAUSED);

    const notice = screen.getByRole('status');
    expect(notice.textContent).toContain('The rollup build is paused');
    expect(notice.textContent).toContain('Dashboards read your exports directly until it is rebuilt, which is slower.');
    expect(notice.textContent).toContain('If the query engine stops again, lower the memory limit or the rollup build parallelism first.');
    // The paused build outranks "restarted": it is what the user can act on.
    expect(notice.textContent).not.toContain('The query engine restarted');
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Performance settings' }));
    expect(onOpenPerformance).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild the rollup' }));
    expect(onResumeRollupBuilds).toHaveBeenCalledTimes(1);

    // Main says builds are on again: the restart the user already dealt with
    // does not come back as news.
    show({ ...PAUSED, rollupBuildsPaused: false });
    expect(screen.queryByRole('status')).toBeNull();
  });
});
