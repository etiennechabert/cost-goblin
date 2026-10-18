import { act, render, renderHook, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DebugPanel, useDebugBadge } from '../renderer/debug-panel.js';
import { fakeDebug } from './helpers/renderer-bridges.js';

const STARTED_AT = Date.UTC(2026, 0, 15, 9, 30, 0);
const STARTED_TIME = new Date(STARTED_AT).toLocaleTimeString();

/** A completed, uncached query; `fields` overrides any of it. */
function logEntry(fields: Partial<DebugQueryLogEntry> & Pick<DebugQueryLogEntry, 'id' | 'sql'>): DebugQueryLogEntry {
  return {
    paramCount: 0,
    status: 'success',
    startedAt: STARTED_AT,
    durationMs: 12,
    rowCount: 1,
    error: null,
    materialized: false,
    cached: false,
    origin: null,
    ...fields,
  };
}

function renderPanel(onClose: () => void = vi.fn()): { user: ReturnType<typeof userEvent.setup> } {
  const user = userEvent.setup();
  render(<DebugPanel onClose={onClose} topOffset={72} />);
  return { user };
}

/** The summary row (a button) of the query whose SQL mentions `table`. */
function row(table: string): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(table) });
}

function originFilter(): HTMLSelectElement {
  const select = screen.getByRole('combobox');
  if (!(select instanceof HTMLSelectElement)) throw new Error('origin filter is not a <select>');
  return select;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('DebugPanel', () => {
  it('shows an empty state until a query is logged', async () => {
    renderPanel();
    expect(await screen.findByText('No queries yet')).toBeDefined();
    expect(screen.getByRole('option', { name: 'all (0)' })).toBeDefined();
  });

  it('sits flush below the header it is given', async () => {
    renderPanel();
    const heading = await screen.findByRole('heading', { name: 'Query Log' });
    expect(heading.closest('[style]')?.getAttribute('style')).toContain('top: 72px');
  });

  it('labels each query with where it was served from', async () => {
    fakeDebug.queryLog = [
      // CACHE wins over every other marker, even a rollup path in the SQL.
      logEntry({ id: 1, sql: "SELECT * FROM read_parquet('/data/aws/rollup/x.parquet') AS cached_q", cached: true, materialized: true }),
      logEntry({ id: 2, sql: 'SELECT * FROM cost_base AS mem_q', materialized: true }),
      logEntry({ id: 3, sql: "SELECT * FROM read_parquet('/data/aws/rollup/daily-2026-01/*.parquet') AS rollup_q" }),
      logEntry({ id: 4, sql: "SELECT * FROM read_parquet('/data/aws/raw/daily-2026-01/*.parquet') AS raw_q" }),
      logEntry({ id: 5, sql: 'SELECT 42 AS plain_q' }),
    ];
    renderPanel();
    await screen.findByRole('button', { name: /cached_q/ });

    expect(within(row('cached_q')).getByText('CACHE')).toBeDefined();
    expect(within(row('cached_q')).queryByText('MEM')).toBeNull();
    expect(within(row('cached_q')).queryByText('ROLLUP')).toBeNull();
    expect(within(row('mem_q')).getByText('MEM')).toBeDefined();
    expect(within(row('rollup_q')).getByText('ROLLUP')).toBeDefined();
    expect(within(row('raw_q')).getByText('RAW')).toBeDefined();
    const plain = row('plain_q');
    for (const badge of ['CACHE', 'MEM', 'ROLLUP', 'RAW']) {
      expect(within(plain).queryByText(badge)).toBeNull();
    }
  });

  it('shows duration, row and param counts, errors and origin for each query', async () => {
    fakeDebug.queryLog = [
      logEntry({ id: 1, sql: 'SELECT * FROM slow_q WHERE a = $1 AND b = $2', durationMs: 1500, rowCount: 42, paramCount: 2, origin: 'dashboard:overview' }),
      logEntry({ id: 2, sql: 'SELECT * FROM broken_q', status: 'error', durationMs: 3, rowCount: null, error: 'Binder Error: column x not found' }),
    ];
    renderPanel();
    await screen.findByRole('button', { name: /slow_q/ });

    const slow = within(row('slow_q'));
    expect(slow.getByText('1.50s')).toBeDefined();
    expect(slow.getByText('42 rows')).toBeDefined();
    expect(slow.getByText('2 params')).toBeDefined();
    expect(slow.getByText('dashboard:overview')).toBeDefined();
    expect(slow.getByText(STARTED_TIME)).toBeDefined();

    const broken = within(row('broken_q'));
    expect(broken.getByText('3ms')).toBeDefined();
    expect(broken.getByText('Binder Error: column x not found')).toBeDefined();
    expect(broken.queryByText(/rows$/)).toBeNull();
    expect(broken.queryByText(/params$/)).toBeNull();
  });

  it('collapses whitespace in the SQL preview and truncates it at 100 characters', async () => {
    const longSql = `SELECT ${'very_long_column_name, '.repeat(8)}id FROM wide_q`;
    fakeDebug.queryLog = [
      logEntry({ id: 1, sql: 'SELECT a,\n       b\n  FROM   multiline_q' }),
      logEntry({ id: 2, sql: longSql }),
    ];
    renderPanel();
    await screen.findByRole('button', { name: /multiline_q/ });

    // Compared on the raw text: RTL's matcher would collapse whitespace itself.
    const previews = screen.getAllByText(/^SELECT/).map(el => el.textContent);
    const truncated = longSql.replaceAll(/\s+/g, ' ').slice(0, 100);
    expect(previews).toEqual(['SELECT a, b FROM multiline_q', `${truncated}...`]);
  });

  it('lists running, then queued, then finished queries slowest first, and counts the active ones', async () => {
    fakeDebug.queryLog = [
      logEntry({ id: 1, sql: 'SELECT * FROM q_fast', durationMs: 10 }),
      logEntry({ id: 2, sql: 'SELECT * FROM q_running', status: 'running', durationMs: null, rowCount: null }),
      logEntry({ id: 3, sql: 'SELECT * FROM q_slow', durationMs: 900 }),
      logEntry({ id: 4, sql: 'SELECT * FROM q_queued', status: 'queued', durationMs: null, rowCount: null }),
      logEntry({ id: 5, sql: 'SELECT * FROM q_failed', status: 'error', durationMs: 50, error: 'boom' }),
    ];
    renderPanel();
    await screen.findByRole('button', { name: /q_fast/ });

    const order = screen.getAllByRole('button', { name: /FROM q_/ })
      .map(b => within(b).getByText(/^SELECT/).textContent);
    expect(order).toEqual([
      'SELECT * FROM q_running',
      'SELECT * FROM q_queued',
      'SELECT * FROM q_slow',
      'SELECT * FROM q_failed',
      'SELECT * FROM q_fast',
    ]);

    // An unfinished query has no duration yet — a queued one says so.
    expect(within(row('q_running')).getByText('...')).toBeDefined();
    expect(within(row('q_queued')).getByText('queued')).toBeDefined();
    expect(screen.getByText('1 running').parentElement?.textContent).toBe('1 running, 1 queued');
  });

  it('counts running queries alone when none are queued, and the other way round', async () => {
    fakeDebug.queryLog = [
      logEntry({ id: 1, sql: 'SELECT * FROM run_a', status: 'running', durationMs: null }),
      logEntry({ id: 2, sql: 'SELECT * FROM run_b', status: 'running', durationMs: null }),
    ];
    renderPanel();
    const running = await screen.findByText('2 running');
    expect(running.parentElement?.textContent).toBe('2 running');

    fakeDebug.queryLog = [logEntry({ id: 3, sql: 'SELECT * FROM wait_a', status: 'queued', durationMs: null })];
    const queued = await screen.findByText('1 queued');
    expect(queued.parentElement?.textContent).toBe('1 queued');

    // Finished work leaves the header quiet.
    fakeDebug.queryLog = [logEntry({ id: 4, sql: 'SELECT * FROM done_a' })];
    await screen.findByRole('button', { name: /done_a/ });
    expect(screen.queryByText(/queued$/)).toBeNull();
    expect(screen.queryByText(/running$/)).toBeNull();
  });

  it('filters by origin, ranking origins by query count and grouping queries without one', async () => {
    fakeDebug.queryLog = [
      logEntry({ id: 1, sql: 'SELECT * FROM dash_1', origin: 'dashboard' }),
      logEntry({ id: 2, sql: 'SELECT * FROM dash_2', origin: 'dashboard' }),
      logEntry({ id: 3, sql: 'SELECT * FROM dash_3', origin: 'dashboard' }),
      logEntry({ id: 4, sql: 'SELECT * FROM none_1' }),
      logEntry({ id: 5, sql: 'SELECT * FROM none_2' }),
      logEntry({ id: 6, sql: 'SELECT * FROM b_only', origin: 'b-view' }),
      logEntry({ id: 7, sql: 'SELECT * FROM a_only', origin: 'a-view' }),
    ];
    const { user } = renderPanel();
    await screen.findByRole('button', { name: /dash_1/ });

    // Most frequent first; equal counts fall back to the origin's name.
    expect(within(originFilter()).getAllByRole('option').map(o => o.textContent)).toEqual([
      'all (7)',
      'dashboard (3)',
      '(no origin) (2)',
      'a-view (1)',
      'b-view (1)',
    ]);

    await user.selectOptions(originFilter(), 'a-view');
    expect(screen.getAllByRole('button', { name: /FROM / })).toHaveLength(1);
    expect(row('a_only')).toBeDefined();

    await user.selectOptions(originFilter(), '(no origin) (2)');
    expect(screen.queryByRole('button', { name: /dash_1/ })).toBeNull();
    expect(row('none_1')).toBeDefined();
    expect(row('none_2')).toBeDefined();

    await user.selectOptions(originFilter(), 'all (7)');
    expect(screen.getAllByRole('button', { name: /FROM / })).toHaveLength(7);
  });

  it('expands a row to the full SQL and toggles it closed again', async () => {
    fakeDebug.queryLog = [logEntry({ id: 1, sql: 'SELECT a,\n  b\nFROM expand_q' })];
    const { user } = renderPanel();
    await user.click(await screen.findByRole('button', { name: /expand_q/ }));

    const full = screen.getByText((_, el) => el?.tagName === 'PRE' && el.textContent === 'SELECT a,\n  b\nFROM expand_q');
    expect(full).toBeDefined();

    await user.click(row('expand_q'));
    expect(screen.queryByRole('button', { name: 'EXPLAIN ANALYZE' })).toBeNull();
  });

  it('runs EXPLAIN ANALYZE for the expanded query and shows the plan', async () => {
    fakeDebug.queryLog = [logEntry({ id: 7, sql: 'SELECT * FROM explain_q' })];
    const plan = deferred<string>();
    const runExplain = vi.spyOn(fakeDebug, 'runExplain').mockReturnValue(plan.promise);
    const { user } = renderPanel();
    await user.click(await screen.findByRole('button', { name: /explain_q/ }));

    await user.click(screen.getByRole('button', { name: 'EXPLAIN ANALYZE' }));
    expect(runExplain).toHaveBeenCalledWith(7);
    const busy = screen.getByRole('button', { name: 'Running...' });
    expect(busy).toHaveProperty('disabled', true);

    await act(async () => { plan.resolve('PHYSICAL_PLAN\n  SEQ_SCAN explain_q'); await plan.promise; });
    expect(screen.getByText((_, el) => el?.tagName === 'PRE' && el.textContent === 'PHYSICAL_PLAN\n  SEQ_SCAN explain_q')).toBeDefined();
    expect(screen.getByRole('button', { name: 'EXPLAIN ANALYZE' })).toHaveProperty('disabled', false);
  });

  it.each([
    { status: 'running' as const },
    { status: 'queued' as const },
  ])('cannot EXPLAIN a query that is still $status', async ({ status }) => {
    fakeDebug.queryLog = [logEntry({ id: 1, sql: 'SELECT * FROM busy_q', status, durationMs: null })];
    const { user } = renderPanel();
    await user.click(await screen.findByRole('button', { name: /busy_q/ }));
    expect(screen.getByRole('button', { name: 'EXPLAIN ANALYZE' })).toHaveProperty('disabled', true);
  });

  it('picks up queries logged after it opened', async () => {
    renderPanel();
    await screen.findByText('No queries yet');
    fakeDebug.queryLog = [logEntry({ id: 1, sql: 'SELECT * FROM late_q' })];
    expect(await screen.findByRole('button', { name: /late_q/ })).toBeDefined();
    expect(screen.queryByText('No queries yet')).toBeNull();
  });

  it('Clear empties the log in the main process and on screen', async () => {
    fakeDebug.queryLog = [logEntry({ id: 1, sql: 'SELECT * FROM doomed_q' })];
    const clearLog = vi.spyOn(fakeDebug, 'clearLog');
    const { user } = renderPanel();
    await screen.findByRole('button', { name: /doomed_q/ });

    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(clearLog).toHaveBeenCalledOnce();
    expect(await screen.findByText('No queries yet')).toBeDefined();
    expect(fakeDebug.queryLog).toEqual([]);
  });

  it('Copy puts every query, with its status, timing and errors, on the clipboard', async () => {
    fakeDebug.queryLog = [
      logEntry({ id: 1, sql: 'SELECT * FROM ok_q', durationMs: 1500, rowCount: 3, origin: 'dashboard' }),
      logEntry({ id: 2, sql: 'SELECT * FROM run_q', status: 'running', durationMs: null, rowCount: null }),
      logEntry({ id: 3, sql: 'SELECT * FROM que_q', status: 'queued', durationMs: null, rowCount: null }),
      logEntry({ id: 4, sql: 'SELECT * FROM err_q', status: 'error', durationMs: 8, rowCount: null, error: 'Out of memory' }),
    ];
    const { user } = renderPanel();
    await screen.findByRole('button', { name: /ok_q/ });

    await user.click(screen.getByRole('button', { name: 'Copy' }));

    // Copied in log order (not the on-screen sort), one block per query.
    expect(await navigator.clipboard.readText()).toBe([
      `[OK] ${STARTED_TIME}  1.50s  3 rows  origin=dashboard\nSELECT * FROM ok_q`,
      `[RUN] ${STARTED_TIME}  ...  \nSELECT * FROM run_q`,
      `[QUE] ${STARTED_TIME}  ...  \nSELECT * FROM que_q`,
      `[ERR] ${STARTED_TIME}  8ms  \nSELECT * FROM err_q\nError: Out of memory`,
    ].join('\n\n---\n\n'));
  });

  it('Export downloads the same text as a timestamped .txt file', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-15T09:31:05.250Z'));
    fakeDebug.queryLog = [logEntry({ id: 1, sql: 'SELECT * FROM export_q', origin: 'explorer' })];
    const blobs: Blob[] = [];
    const revoked: string[] = [];
    const created = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const revoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: (blob: Blob): string => { blobs.push(blob); return 'blob:query-log'; },
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: (url: string): void => { revoked.push(url); },
    });
    try {
      // The download is a programmatic <a download> click — record it rather
      // than letting jsdom attempt a navigation.
      const click = vi.spyOn(HTMLElement.prototype, 'click').mockImplementation(() => undefined);
      const { user } = renderPanel();
      await screen.findByRole('button', { name: /export_q/ });

      await user.click(screen.getByRole('button', { name: 'Export' }));

      const link = click.mock.contexts[0];
      if (!(link instanceof HTMLAnchorElement)) throw new Error('no download link was clicked');
      expect(link.download).toBe('query-log-2026-01-15T09-31-05.txt');
      expect(link.href).toBe('blob:query-log');
      const blob = blobs[0];
      if (blob === undefined) throw new Error('no blob was created');
      expect(blob.type).toBe('text/plain');
      expect(await blob.text()).toBe(`[OK] ${STARTED_TIME}  12ms  1 rows  origin=explorer\nSELECT * FROM export_q`);
      // The object URL is released straight after the click.
      expect(revoked).toEqual(['blob:query-log']);
    } finally {
      for (const [key, original] of [['createObjectURL', created], ['revokeObjectURL', revoke]] as const) {
        if (original === undefined) Reflect.deleteProperty(URL, key);
        else Object.defineProperty(URL, key, original);
      }
    }
  });

  it('shows the IPC calls in flight', async () => {
    fakeDebug.inFlightCount = 3;
    renderPanel();
    const count = await screen.findByText('3');
    expect(count.parentElement?.textContent).toBe('3 IPC in-flight');
  });

  it('calls onClose from its close button', async () => {
    const onClose = vi.fn();
    const { user } = renderPanel(onClose);
    await screen.findByText('No queries yet');
    // The icon-only close button is the one without an accessible name.
    await user.click(screen.getByRole('button', { name: '' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('stops polling the query log once closed', () => {
    vi.useFakeTimers();
    const getQueryLog = vi.spyOn(fakeDebug, 'getQueryLog');
    const { unmount } = render(<DebugPanel onClose={vi.fn()} topOffset={0} />);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(getQueryLog).toHaveBeenCalledTimes(3);

    unmount();
    act(() => { vi.advanceTimersByTime(5000); });
    expect(getQueryLog).toHaveBeenCalledTimes(3);
  });
});

describe('useDebugBadge', () => {
  it('reports the in-flight IPC count, refreshed every 300ms', () => {
    vi.useFakeTimers();
    fakeDebug.inFlightCount = 2;
    const { result } = renderHook(() => useDebugBadge());
    expect(result.current).toBe(0);

    act(() => { vi.advanceTimersByTime(300); });
    expect(result.current).toBe(2);

    fakeDebug.inFlightCount = 0;
    act(() => { vi.advanceTimersByTime(300); });
    expect(result.current).toBe(0);
  });

  it('stops polling on unmount', () => {
    vi.useFakeTimers();
    const getInFlightCount = vi.spyOn(fakeDebug, 'getInFlightCount');
    const { unmount } = renderHook(() => useDebugBadge());
    act(() => { vi.advanceTimersByTime(900); });
    expect(getInFlightCount).toHaveBeenCalledTimes(3);

    unmount();
    act(() => { vi.advanceTimersByTime(3000); });
    expect(getInFlightCount).toHaveBeenCalledTimes(3);
  });
});
