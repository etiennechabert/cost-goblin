import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CostApi, SyncLogLevel, SyncLogLine } from '@costgoblin/core/browser';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { SyncLogPanel } from '../views/data-management-logs.js';

function line(seq: number, level: SyncLogLevel, message: string): SyncLogLine {
  return { seq, level, message, ts: Date.UTC(2026, 9, 1, 12, 0, seq % 60) };
}

function time(l: SyncLogLine): string {
  return new Date(l.ts).toLocaleTimeString(undefined, { hour12: false });
}

const BACKLOG: readonly SyncLogLine[] = [
  line(1, 'info', 'Manual sync — checking S3'),
  line(2, 'debug', 'aws s3 sync started'),
  line(3, 'warn', 'aws-main/hourly: S3 check failed'),
  line(4, 'error', 'aws-main/daily: sync failed'),
];

interface LogApi {
  readonly api: CostApi;
  /** Deliver a pushed line, as the main process does on append. */
  readonly push: (l: SyncLogLine) => void;
  readonly unsubscribed: () => boolean;
}

/** The mock's sync log is empty and push-less; these tests drive both. */
function logApi(backlog: Promise<readonly SyncLogLine[]> = Promise.resolve(BACKLOG)): LogApi {
  const api: CostApi = new MockCostApi();
  let listener: (l: SyncLogLine) => void = () => undefined;
  let unsubscribed = false;
  api.getSyncLog = () => backlog;
  api.subscribeSyncLog = (next) => {
    listener = next;
    return () => { unsubscribed = true; };
  };
  return {
    api,
    push: (l) => { act(() => { listener(l); }); },
    unsubscribed: () => unsubscribed,
  };
}

function renderPanel(api: CostApi, active?: boolean) {
  const user = userEvent.setup();
  const view = render(
    <CostApiProvider value={api}>
      <SyncLogPanel {...(active === undefined ? {} : { active })} />
    </CostApiProvider>,
  );
  return { user, ...view };
}

function toggle(): HTMLElement {
  return screen.getByRole('button', { name: /^Activity log/ });
}

function logBody(): HTMLElement {
  const body = document.querySelector('.font-mono.max-h-64');
  if (!(body instanceof HTMLElement)) throw new Error('log body not rendered');
  return body;
}

/** Message spans, top to bottom, of the expanded log. */
function messages(): string[] {
  return [...logBody().querySelectorAll('div > span:last-child')].map(s => s.textContent);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  cleanup();
});

describe('SyncLogPanel', () => {
  it('starts collapsed with the backlog count, and expands to the lines in order', async () => {
    const { api } = logApi();
    const { user } = renderPanel(api);
    expect(await screen.findByText('(4)')).toBeDefined();
    expect(toggle().textContent).toContain('▸');
    expect(screen.queryByText('Manual sync — checking S3')).toBeNull();

    await user.click(toggle());
    expect(toggle().textContent).toContain('▾');
    expect(messages()).toEqual(BACKLOG.map(l => l.message));
    expect(screen.getByText(time(line(1, 'info', '')))).toBeDefined();
  });

  it('colours each line by level', async () => {
    const { api } = logApi();
    const { user } = renderPanel(api);
    await screen.findByText('(4)');
    await user.click(toggle());
    expect(screen.getByText('Manual sync — checking S3').className).toBe('text-text-secondary');
    expect(screen.getByText('aws s3 sync started').className).toBe('text-text-muted');
    expect(screen.getByText('aws-main/hourly: S3 check failed').className).toBe('text-warning');
    expect(screen.getByText('aws-main/daily: sync failed').className).toBe('text-negative');
  });

  it('filters to warnings (warnings and errors) or errors only', async () => {
    const { api } = logApi();
    const { user } = renderPanel(api);
    await screen.findByText('(4)');
    await user.click(toggle());

    await user.click(screen.getByRole('button', { name: 'Warnings' }));
    expect(messages()).toEqual(['aws-main/hourly: S3 check failed', 'aws-main/daily: sync failed']);
    expect(screen.getByRole('button', { name: 'Warnings' }).className).toContain('bg-bg-tertiary');

    await user.click(screen.getByRole('button', { name: 'Errors' }));
    expect(messages()).toEqual(['aws-main/daily: sync failed']);

    await user.click(screen.getByRole('button', { name: 'All' }));
    expect(messages()).toHaveLength(4);
  });

  it('shows the empty state with Copy and Clear disabled, also when a filter matches nothing', async () => {
    const empty = logApi(Promise.resolve([]));
    const { user } = renderPanel(empty.api);
    await user.click(toggle());
    expect(screen.getByText(/No sync activity yet/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Copy' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Clear' })).toHaveProperty('disabled', true);
    cleanup();

    const infoOnly = logApi(Promise.resolve([line(1, 'info', 'all good')]));
    const second = renderPanel(infoOnly.api);
    await screen.findByText('(1)');
    await second.user.click(toggle());
    await second.user.click(screen.getByRole('button', { name: 'Errors' }));
    expect(screen.getByText(/No sync activity yet/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Copy' })).toHaveProperty('disabled', true);
    // The lines are only filtered out, so they can still be cleared.
    expect(screen.getByRole('button', { name: 'Clear' })).toHaveProperty('disabled', false);
  });

  it('appends pushed lines live, and stops listening on unmount', async () => {
    const log = logApi();
    const { user, unmount } = renderPanel(log.api);
    await screen.findByText('(4)');
    await user.click(toggle());

    log.push(line(5, 'info', 'aws-main/daily: up to date'));
    expect(screen.getByText('(5)')).toBeDefined();
    expect(messages().at(-1)).toBe('aws-main/daily: up to date');

    unmount();
    expect(log.unsubscribed()).toBe(true);
  });

  it('reconciles lines pushed before the backlog arrived, without duplicates', async () => {
    let deliver: (lines: readonly SyncLogLine[]) => void = () => undefined;
    const log = logApi(new Promise<readonly SyncLogLine[]>((resolve) => { deliver = resolve; }));
    const { user } = renderPanel(log.api);
    await user.click(toggle());

    // Two appends race ahead of the backlog read, which then repeats one.
    log.push(line(5, 'info', 'fifth'));
    log.push(line(6, 'info', 'sixth'));
    await act(async () => { deliver([line(4, 'info', 'fourth'), line(5, 'info', 'fifth')]); await Promise.resolve(); });

    expect(messages()).toEqual(['fourth', 'fifth', 'sixth']);
    expect(screen.getByText('(3)')).toBeDefined();
  });

  it('keeps only the newest 1000 lines', async () => {
    const many = Array.from({ length: 1001 }, (_, i) => line(i, 'info', `line ${String(i)}`));
    const log = logApi(Promise.resolve(many));
    renderPanel(log.api);
    expect(await screen.findByText('(1000)')).toBeDefined();
  });

  it('ignores a backlog read that fails', async () => {
    const log = logApi(Promise.reject(new Error('ipc closed')));
    const { user } = renderPanel(log.api);
    await user.click(toggle());
    expect(screen.getByText(/No sync activity yet/)).toBeDefined();
    // Pushes still arrive.
    log.push(line(1, 'warn', 'late warning'));
    expect(screen.getByText('late warning')).toBeDefined();
  });

  it('pulses the dot while a sync is active', async () => {
    const { api } = logApi();
    renderPanel(api, true);
    await screen.findByText('(4)');
    expect(toggle().querySelector('.animate-pulse')).not.toBeNull();
    cleanup();

    renderPanel(logApi().api, false);
    await screen.findByText('(4)');
    expect(toggle().querySelector('.animate-pulse')).toBeNull();
  });

  it('copies the filtered lines with their times, then resets the label', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { api } = logApi();
    const user = userEvent.setup({ advanceTimers: (ms) => { vi.advanceTimersByTime(ms); } });
    render(<CostApiProvider value={api}><SyncLogPanel /></CostApiProvider>);
    await screen.findByText('(4)');
    await user.click(toggle());
    await user.click(screen.getByRole('button', { name: 'Errors' }));

    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeDefined();
    const errorLine = BACKLOG[3];
    if (errorLine === undefined) throw new Error('fixture changed');
    expect(await navigator.clipboard.readText()).toBe(`${time(errorLine)} aws-main/daily: sync failed`);

    // A second copy restarts the timer rather than racing the first one.
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await user.click(screen.getByRole('button', { name: 'Copied' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.getByRole('button', { name: 'Copied' })).toBeDefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(screen.getByRole('button', { name: 'Copy' })).toBeDefined();
  });

  it('leaves the label alone when the clipboard refuses the copy', async () => {
    const { api } = logApi();
    const { user } = renderPanel(api);
    const refuse = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    await screen.findByText('(4)');
    await user.click(toggle());
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => { expect(refuse).toHaveBeenCalledTimes(1); });
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull();
  });

  it('cancels a pending label reset when it unmounts', async () => {
    const { api } = logApi();
    const { user, unmount } = renderPanel(api);
    await screen.findByText('(4)');
    await user.click(toggle());
    const setTimer = vi.spyOn(globalThis, 'setTimeout');
    const clearTimer = vi.spyOn(globalThis, 'clearTimeout');
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    await screen.findByRole('button', { name: 'Copied' });
    const resetCall = setTimer.mock.calls.findIndex(([, ms]) => ms === 1500);
    const resetTimer: unknown = setTimer.mock.results[resetCall]?.value;
    expect(resetTimer).toBeDefined();

    unmount();
    expect(clearTimer.mock.calls.some(([id]) => id === resetTimer)).toBe(true);
  });

  it('clears the log here and in the main process, even if the main process call fails', async () => {
    const { api } = logApi();
    const clear = vi.spyOn(api, 'clearSyncLog').mockRejectedValue(new Error('ipc closed'));
    const { user } = renderPanel(api);
    await screen.findByText('(4)');
    await user.click(toggle());
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(clear).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/No sync activity yet/)).toBeDefined();
    expect(within(toggle()).queryByText('(4)')).toBeNull();
  });

  it('follows new lines while scrolled to the bottom, and stays put once scrolled up', async () => {
    const log = logApi();
    const { user } = renderPanel(log.api);
    await screen.findByText('(4)');
    await user.click(toggle());

    const body = logBody();
    let top = 0;
    let height = 400;
    Object.defineProperty(body, 'scrollHeight', { configurable: true, get: () => height });
    Object.defineProperty(body, 'clientHeight', { configurable: true, get: () => 100 });
    Object.defineProperty(body, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => { top = v; } });

    // At the bottom (the default): a new line scrolls the tail into view.
    log.push(line(5, 'info', 'fifth'));
    expect(top).toBe(400);

    // The user scrolls up to read: new lines no longer yank the view.
    top = 50;
    fireEvent.scroll(body);
    height = 450;
    log.push(line(6, 'info', 'sixth'));
    expect(top).toBe(50);

    // Back at the bottom, following resumes.
    top = 350;
    fireEvent.scroll(body);
    height = 500;
    log.push(line(7, 'info', 'seventh'));
    expect(top).toBe(500);
  });
});
