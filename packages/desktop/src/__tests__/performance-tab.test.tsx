import { act, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { PerformanceInfo, PerformanceSettings } from '@costgoblin/core/browser';
import { CostApiProvider, MockCostApi, UnsavedChangesProvider, useConfirmLeave } from '@costgoblin/ui';
import { PerformanceTab } from '../renderer/settings/performance-tab.js';

const AUTO: PerformanceSettings = { memoryLimitGB: null, threads: null, rollupConcurrency: null };

const INFO: PerformanceInfo = {
  defaultMemoryGB: 8,
  defaultThreads: 6,
  defaultRollupConcurrency: 2,
  totalMemoryGB: 16,
  maxThreads: 10,
  maxRollupConcurrency: 4,
  minMemoryGB: 1,
  maxMemoryGB: 24,
  current: AUTO,
};

/** The main process's perf handlers: `info` is what a read returns, and a
 *  save persists through `persist` (identity unless a test clamps). */
class PerfApi extends MockCostApi {
  info: PerformanceInfo = INFO;
  readonly saves: PerformanceSettings[] = [];
  saveOutcome: () => Promise<void> = () => Promise.resolve();
  persist: (requested: PerformanceSettings) => PerformanceSettings = (requested) => requested;

  override getPerformanceInfo(): Promise<PerformanceInfo> { return Promise.resolve(this.info); }
  override async setPerformanceSettings(perf?: PerformanceSettings): Promise<void> {
    if (perf === undefined) return;
    this.saves.push(perf);
    await this.saveOutcome();
    this.info = { ...this.info, current: this.persist(perf) };
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

async function renderTab(api: PerfApi): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  render(
    <CostApiProvider value={api}>
      <PerformanceTab />
    </CostApiProvider>,
  );
  await screen.findByRole('heading', { name: 'Performance' });
  return user;
}

function field(label: string): HTMLInputElement {
  const input = screen.getByLabelText(label);
  if (!(input instanceof HTMLInputElement)) throw new Error(`${label} is not an input`);
  return input;
}

const memory = (): HTMLInputElement => field('Memory limit (GB)');
const threads = (): HTMLInputElement => field('DuckDB threads');
const rollups = (): HTMLInputElement => field('Parallel rollup builds');

function button(name: string): HTMLButtonElement {
  const el = screen.getByRole('button', { name });
  if (!(el instanceof HTMLButtonElement)) throw new Error(`${name} is not a button`);
  return el;
}

describe('PerformanceTab', () => {
  it('shows a loading state until the settings arrive', async () => {
    render(<CostApiProvider value={new PerfApi()}><PerformanceTab /></CostApiProvider>);
    expect(screen.getByText('Loading…')).toBeDefined();
    expect(await screen.findByRole('heading', { name: 'Performance' })).toBeDefined();
  });

  it('stays on the loading state when the settings cannot be read', async () => {
    const api = new PerfApi();
    const read = vi.spyOn(api, 'getPerformanceInfo').mockRejectedValue(new Error('ipc down'));
    render(<CostApiProvider value={api}><PerformanceTab /></CostApiProvider>);
    await waitFor(() => { expect(read).toHaveBeenCalledOnce(); });
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText('Loading…')).toBeDefined();
  });

  it('leaves every field blank on Auto, naming the machine-derived default and range', async () => {
    await renderTab(new PerfApi());

    for (const input of [memory(), threads(), rollups()]) expect(input.value).toBe('');
    expect(memory().placeholder).toBe('Auto (8)');
    expect(threads().placeholder).toBe('Auto (6)');
    expect(rollups().placeholder).toBe('Auto (2)');
    expect(screen.getByText('Auto: 8 GB · range 1–16 · 16 GB detected')).toBeDefined();
    expect(screen.getByText('Auto: 6 · range 1–10 cores')).toBeDefined();
    expect(screen.getByText('Auto: 2 · range 1–4')).toBeDefined();
    // Nothing to save, nothing to reset.
    expect(button('Save changes').disabled).toBe(true);
    expect(button('Reset to Auto').disabled).toBe(true);
    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });

  it('caps the memory range at the configured maximum when it is below the machine total', async () => {
    const api = new PerfApi();
    api.info = { ...INFO, totalMemoryGB: 64, maxMemoryGB: 12 };
    await renderTab(api);
    expect(screen.getByText('Auto: 8 GB · range 1–12 · 64 GB detected')).toBeDefined();
    expect(memory().max).toBe('12');
    expect(memory().min).toBe('1');
  });

  it('pre-fills the saved overrides', async () => {
    const api = new PerfApi();
    api.info = { ...INFO, current: { memoryLimitGB: 12, threads: 4, rollupConcurrency: 3 } };
    await renderTab(api);
    expect(memory().value).toBe('12');
    expect(threads().value).toBe('4');
    expect(rollups().value).toBe('3');
    expect(button('Reset to Auto').disabled).toBe(false);
    expect(button('Save changes').disabled).toBe(true);
  });

  it('flags an edit as unsaved, and clean again once it is undone', async () => {
    const user = await renderTab(new PerfApi());

    await user.type(memory(), '12');
    expect(screen.getByText('Unsaved changes')).toBeDefined();
    expect(button('Save changes').disabled).toBe(false);

    await user.clear(memory());
    expect(screen.queryByText('Unsaved changes')).toBeNull();
    expect(button('Save changes').disabled).toBe(true);
  });

  it('treats a value that is not a positive whole number as Auto', async () => {
    const api = new PerfApi();
    api.info = { ...INFO, current: { memoryLimitGB: null, threads: 4, rollupConcurrency: null } };
    const user = await renderTab(api);

    // "0" against an Auto field changes nothing…
    await user.type(rollups(), '0');
    expect(screen.queryByText('Unsaved changes')).toBeNull();

    // …and replacing an override with it saves Auto.
    await user.clear(threads());
    await user.type(threads(), '0');
    await user.click(button('Save changes'));
    await screen.findByText('Applied');
    expect(api.saves).toEqual([AUTO]);
  });

  it('saves every field, then shows what was persisted', async () => {
    const api = new PerfApi();
    const save = deferred();
    api.saveOutcome = () => save.promise;
    const user = await renderTab(api);

    await user.type(memory(), '12');
    await user.type(threads(), '4');
    await user.type(rollups(), '3');
    await user.click(button('Save changes'));

    expect(api.saves).toEqual([{ memoryLimitGB: 12, threads: 4, rollupConcurrency: 3 }]);
    expect(button('Applying…').disabled).toBe(true);

    await act(async () => { save.resolve(); await save.promise; });
    expect(await screen.findByText('Applied')).toBeDefined();
    expect(screen.queryByText('Unsaved changes')).toBeNull();
    expect(button('Save changes').disabled).toBe(true);
  });

  it('replaces an out-of-range value with the one the backend clamped it to', async () => {
    const api = new PerfApi();
    api.persist = (requested) => ({ ...requested, threads: Math.min(requested.threads ?? INFO.defaultThreads, INFO.maxThreads) });
    const user = await renderTab(api);

    await user.type(threads(), '99');
    await user.click(button('Save changes'));

    await screen.findByText('Applied');
    expect(api.saves).toEqual([{ ...AUTO, threads: 99 }]);
    expect(threads().value).toBe('10');
    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });

  it('keeps the edit pending when the save fails', async () => {
    const api = new PerfApi();
    api.saveOutcome = () => Promise.reject(new Error('disk full'));
    const user = await renderTab(api);

    await user.type(memory(), '12');
    await user.click(button('Save changes'));

    await waitFor(() => { expect(button('Save changes').disabled).toBe(false); });
    expect(screen.queryByText('Applied')).toBeNull();
    expect(screen.getByText('Unsaved changes')).toBeDefined();
    expect(memory().value).toBe('12');
  });

  it('drops the "Applied" note as soon as any field is edited again', async () => {
    const api = new PerfApi();
    const user = await renderTab(api);
    await user.type(memory(), '12');
    await user.click(button('Save changes'));
    await screen.findByText('Applied');

    await user.type(rollups(), '2');
    expect(screen.queryByText('Applied')).toBeNull();
    expect(screen.getByText('Unsaved changes')).toBeDefined();
  });

  it('Reset to Auto blanks every override, which then still has to be saved', async () => {
    const api = new PerfApi();
    api.info = { ...INFO, current: { memoryLimitGB: 12, threads: 4, rollupConcurrency: 3 } };
    const user = await renderTab(api);

    await user.click(button('Reset to Auto'));

    for (const input of [memory(), threads(), rollups()]) expect(input.value).toBe('');
    expect(button('Reset to Auto').disabled).toBe(true);
    expect(screen.getByText('Unsaved changes')).toBeDefined();
    expect(api.saves).toEqual([]);

    await user.click(button('Save changes'));
    await screen.findByText('Applied');
    expect(api.saves).toEqual([AUTO]);
  });

  describe('leaving with unsaved edits', () => {
    function LeaveButton({ onLeft }: Readonly<{ onLeft: () => void }>): React.JSX.Element {
      const confirmLeave = useConfirmLeave();
      return <button type="button" onClick={() => { confirmLeave(onLeft); }}>Leave</button>;
    }

    async function renderGuarded(onLeft: () => void): Promise<ReturnType<typeof userEvent.setup>> {
      const user = userEvent.setup();
      render(
        <CostApiProvider value={new PerfApi()}>
          <UnsavedChangesProvider>
            <PerformanceTab />
            <LeaveButton onLeft={onLeft} />
          </UnsavedChangesProvider>
        </CostApiProvider>,
      );
      await screen.findByRole('heading', { name: 'Performance' });
      return user;
    }

    it('asks before discarding them', async () => {
      const onLeft = vi.fn();
      const user = await renderGuarded(onLeft);
      await user.type(threads(), '4');

      await user.click(button('Leave'));

      expect(screen.getByText('Discard changes in Performance?')).toBeDefined();
      expect(onLeft).not.toHaveBeenCalled();
      await user.click(button('Discard'));
      expect(onLeft).toHaveBeenCalledOnce();
    });

    it('lets a clean tab go without asking', async () => {
      const onLeft = vi.fn();
      const user = await renderGuarded(onLeft);

      await user.click(button('Leave'));

      expect(onLeft).toHaveBeenCalledOnce();
      expect(screen.queryByText('Discard changes in Performance?')).toBeNull();
    });
  });
});
