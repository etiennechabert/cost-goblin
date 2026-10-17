import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { BaselineDetail, BaselineDriftRow, BaselineRecord, BaselineSnapshot, BaselineUpdatePatch } from '@costgoblin/core/browser';
import { asDollars } from '@costgoblin/core/browser';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { BaselineDetailModal } from '../components/baseline-detail-modal.js';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { baselineDetail, baselineRecord, baselineSpec, dailySeries, deferred, point, rejectWith, snapshot } from './baseline-fixtures.js';

const ID = 'b-1';
const NOTE_PLACEHOLDER = 'Add a note (optional)…';

interface UpdateCall {
  readonly id: string | undefined;
  readonly patch: BaselineUpdatePatch | undefined;
}

/** Serves one baseline and records every call the modal makes. A successful
 *  status write is persisted, so the refetch that follows reflects it. */
class DetailApi extends MockCostApi {
  detail: BaselineDetail | null;
  detailResult: (() => Promise<BaselineDetail | null>) | null = null;
  driftRows: readonly BaselineDriftRow[] = [];
  driftResult: (() => Promise<readonly BaselineDriftRow[]>) | null = null;
  snapshots: readonly BaselineSnapshot[] = [];
  updateResult: () => Promise<BaselineRecord | null> = () => Promise.resolve(null);
  readonly getCalls: (string | undefined)[] = [];
  readonly driftCalls: { readonly id: string | undefined; readonly child: string | undefined }[] = [];
  readonly snapshotCalls: (string | undefined)[] = [];
  readonly updates: UpdateCall[] = [];

  constructor(detail: BaselineDetail | null) {
    super();
    this.detail = detail;
  }

  override getBaseline(id?: string): Promise<BaselineDetail | null> {
    this.getCalls.push(id);
    return this.detailResult?.() ?? Promise.resolve(this.detail);
  }

  override getBaselineDrift(id?: string, childDimension?: string): Promise<readonly BaselineDriftRow[]> {
    this.driftCalls.push({ id, child: childDimension });
    return this.driftResult?.() ?? Promise.resolve(this.driftRows);
  }

  override getBaselineSnapshots(id?: string): Promise<readonly BaselineSnapshot[]> {
    this.snapshotCalls.push(id);
    return Promise.resolve(this.snapshots);
  }

  override updateBaseline(id?: string, patch?: BaselineUpdatePatch): Promise<BaselineRecord | null> {
    this.updates.push({ id, patch });
    return this.updateResult().then((result) => {
      const status = patch?.triageStatus;
      if (status !== undefined && this.detail !== null) {
        this.detail = { ...this.detail, record: { ...this.detail.record, triageStatus: status } };
      }
      return result;
    });
  }

  patches(): (BaselineUpdatePatch | undefined)[] {
    return this.updates.map((u) => u.patch);
  }

  /** Each update rejects with the next reason, Error or not. */
  failWith(...reasons: unknown[]): void {
    const queue = [...reasons];
    this.updateResult = () => rejectWith(queue.shift());
  }
}

function apiFor(detail: BaselineDetail | null = baselineDetail(baselineRecord())): DetailApi {
  return new DetailApi(detail);
}

interface ModalOptions {
  readonly onNext?: () => void;
  readonly onPrev?: () => void;
  readonly position?: { readonly index: number; readonly total: number };
  readonly triageMode?: boolean;
}

function renderModal(api: DetailApi, options: ModalOptions = {}) {
  const onClose = vi.fn();
  const onChanged = vi.fn();
  const user = userEvent.setup();
  render(
    <CostApiProvider value={api}>
      <BaselineDetailModal
        id={ID}
        onClose={onClose}
        onChanged={onChanged}
        onNext={options.onNext}
        onPrev={options.onPrev}
        position={options.position}
        triageMode={options.triageMode}
      />
    </CostApiProvider>,
  );
  return { user, onClose, onChanged };
}

/** The detail body has rendered — the chart only exists inside it. */
async function bodyReady(): Promise<HTMLElement> {
  return screen.findByRole('img', { name: 'Daily cost history' });
}

/** A write that succeeds triggers a refetch of the baseline; wait for it to
 *  land and the body to render again. */
async function afterRefetch(api: DetailApi, fetches: number): Promise<void> {
  await waitFor(() => { expect(api.getCalls).toHaveLength(fetches); });
  await bodyReady();
}

function headerRow(): HTMLElement {
  const row = screen.getByRole('heading').parentElement?.parentElement;
  if (!(row instanceof HTMLElement)) throw new Error('header row not found');
  return row;
}

/** The $/day line of a run-rate stat card; its next sibling is the $/mo line. */
function statValue(label: string): HTMLElement {
  const value = screen.getByText(label, { selector: 'p' }).nextElementSibling;
  if (!(value instanceof HTMLElement)) throw new Error(`no value for "${label}"`);
  return value;
}

function bandLabel(edge: 'lower' | 'upper'): string | null {
  return screen.getByText(new RegExp(`^${edge} `)).textContent;
}

function statusButton(label: string): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(`^\\d\\s*${label}$`) });
}

function isHighlighted(button: HTMLElement): boolean {
  return button.className.includes('ring-current');
}

function saveButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Save changes' });
}

// The chart's viewBox geometry: 760 wide, plot area from x=56 spanning 688.
const CHART_W = 760;
const PLOT_LEFT = 56;
const PLOT_W = 688;

/** jsdom lays nothing out; give the chart the size of its viewBox so pointer
 *  positions map 1:1 onto chart coordinates. */
function sizeChart(svg: HTMLElement): void {
  svg.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: CHART_W, bottom: 240, width: CHART_W, height: 240, toJSON: () => ({}) });
}

function hoverDay(svg: HTMLElement, index: number, days: number): void {
  fireEvent.mouseMove(svg, { clientX: days <= 1 ? PLOT_LEFT : PLOT_LEFT + (index / (days - 1)) * PLOT_W });
}

function drift(child: string, delta: number): BaselineDriftRow {
  return { child, bandWindowCost: asDollars(0), currentCost: asDollars(0), delta: asDollars(delta) };
}

describe('BaselineDetailModal — loading', () => {
  it('shows a loader until the baseline arrives', async () => {
    const api = apiFor();
    const pending = deferred<BaselineDetail | null>();
    api.detailResult = () => pending.promise;
    renderModal(api);

    expect(within(await screen.findByRole('status')).getByText('Loading')).toBeDefined();
    expect(api.getCalls).toEqual([ID]);

    pending.resolve(baselineDetail(baselineRecord()));
    await bodyReady();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('says so when the baseline no longer exists', async () => {
    renderModal(apiFor(null));
    expect(await screen.findByText('Baseline not found.')).toBeDefined();
    expect(screen.queryByRole('img', { name: 'Daily cost history' })).toBeNull();
  });

  it('closes on Escape', async () => {
    const { user, onClose } = renderModal(apiFor());
    await bodyReady();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('BaselineDetailModal — header', () => {
  it('titles the dialog with the baseline name and describes its scope', async () => {
    renderModal(apiFor(baselineDetail(baselineRecord({ spec: baselineSpec({ name: 'RDS fleet' }), triageStatus: 'acting' }))));
    await bodyReady();
    expect(screen.getByRole('dialog', { name: 'RDS fleet' })).toBeDefined();
    expect(screen.getByText('Amazon RDS · discovered · drift: over')).toBeDefined();
    expect(within(headerRow()).getByText('Acting')).toBeDefined();
  });

  it('falls back to the scope label for an unnamed baseline', async () => {
    renderModal(apiFor());
    await bodyReady();
    expect(screen.getByRole('dialog', { name: 'Amazon RDS' })).toBeDefined();
    expect(within(headerRow()).getByText('New')).toBeDefined();
  });

  it('shows the position in the list and steps through it', async () => {
    const onNext = vi.fn();
    const onPrev = vi.fn();
    const { user } = renderModal(apiFor(), { onNext, onPrev, position: { index: 1, total: 5 } });
    await bodyReady();

    expect(within(headerRow()).getByText('2 / 5')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Next baseline (→)' }));
    expect(onNext).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Previous baseline (←)' }));
    expect(onPrev).toHaveBeenCalledTimes(1);
  });

  it('disables the arrows that have nowhere to go', async () => {
    renderModal(apiFor(), { position: { index: 0, total: 1 } });
    await bodyReady();
    expect(within(headerRow()).getByText('1 / 1')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Previous baseline (←)' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Next baseline (→)' })).toHaveProperty('disabled', true);
  });

  it('shows no position outside a list', async () => {
    renderModal(apiFor());
    await bodyReady();
    expect(screen.queryByRole('button', { name: 'Next baseline (→)' })).toBeNull();
  });
});

describe('BaselineDetailModal — run-rate summary', () => {
  it('flags the potential saving of a scope running above its band', async () => {
    renderModal(apiFor());
    await bodyReady();

    const current = statValue('Current');
    expect(current.textContent).toBe('$25.00/day');
    expect(current.nextElementSibling?.textContent).toBe('$750.00/mo');
    const potential = statValue('Potential');
    expect(potential.textContent).toBe('$15.00/day');
    expect(potential.className).toContain('text-warning');
    const realized = statValue('Realized');
    expect(realized.textContent).toBe('$0.00/day');
    expect(realized.className).not.toContain('text-positive');
  });

  it('credits the realized saving of a scope running under its band', async () => {
    renderModal(apiFor(baselineDetail(baselineRecord({ currentDaily: asDollars(5), status: 'under' }))));
    await bodyReady();

    const potential = statValue('Potential');
    expect(potential.textContent).toBe('$0.00/day');
    expect(potential.className).not.toContain('text-warning');
    const realized = statValue('Realized');
    expect(realized.textContent).toBe('$15.00/day');
    expect(realized.className).toContain('text-positive');
    expect(realized.nextElementSibling?.textContent).toBe('$450.00/mo');
  });
});

describe('BaselineDetailModal — history chart', () => {
  it('shows the day, its cost and the 30-day average under the pointer', async () => {
    renderModal(apiFor());
    const svg = await bodyReady();
    sizeChart(svg);

    hoverDay(svg, 2, 5);
    expect(screen.getByText('Jan 3, 2026')).toBeDefined();
    expect(screen.getByText('cost $30.00/day')).toBeDefined();
    // Average of the first three days: (10 + 20 + 30) / 3.
    expect(screen.getByText('30-day avg $20.00/day')).toBeDefined();

    fireEvent.mouseLeave(svg);
    expect(screen.queryByText('Jan 3, 2026')).toBeNull();
  });

  it('keeps the tooltip inside the chart at its left edge', async () => {
    renderModal(apiFor());
    const svg = await bodyReady();
    sizeChart(svg);

    fireEvent.mouseMove(svg, { clientX: 0 });
    expect(screen.getByText('Jan 1, 2026').parentElement?.style.left).toBe('12%');
  });

  it('orders the stored days and zero-fills the ones it skips', async () => {
    // Stored sparse and out of order: discovery emits no row for a $0 day.
    renderModal(apiFor(baselineDetail(baselineRecord(), [point('2026-02-02', 80), point('2026-01-30', 40)])));
    const svg = await bodyReady();
    expect(within(svg).getByText('Jan')).toBeDefined();
    expect(within(svg).getByText('Feb')).toBeDefined();
    sizeChart(svg);

    hoverDay(svg, 1, 4);
    expect(screen.getByText('Jan 31, 2026')).toBeDefined();
    expect(screen.getByText('cost $0.00/day')).toBeDefined();
    expect(screen.getByText('30-day avg $20.00/day')).toBeDefined();
  });

  it('ignores the pointer until the chart has been laid out', async () => {
    renderModal(apiFor());
    const svg = await bodyReady();
    // Unsized, as jsdom leaves it: 0px wide.
    fireEvent.mouseMove(svg, { clientX: 400 });
    expect(screen.queryByText(/^cost /)).toBeNull();
  });

  it('draws a single-day history and its tooltip', async () => {
    renderModal(apiFor(baselineDetail(baselineRecord(), [point('2026-03-15', 12)])));
    const svg = await bodyReady();
    expect(within(svg).getByText('Mar')).toBeDefined();
    sizeChart(svg);

    hoverDay(svg, 0, 1);
    expect(screen.getByText('Mar 15, 2026')).toBeDefined();
    expect(screen.getByText('cost $12.00/day')).toBeDefined();
  });

  it('renders an empty history with no tooltip and no breakdown', async () => {
    const api = apiFor(baselineDetail(baselineRecord(), []));
    renderModal(api);
    const svg = await bodyReady();
    sizeChart(svg);

    fireEvent.mouseMove(svg, { clientX: 400 });
    expect(screen.queryByText(/^cost /)).toBeNull();
    expect(api.driftCalls).toEqual([]);
    expect(screen.queryByText(/What changed/)).toBeNull();
  });
});

describe('BaselineDetailModal — what changed', () => {
  it('shows a placeholder while the breakdown loads', async () => {
    const api = apiFor();
    api.driftResult = () => deferred<readonly BaselineDriftRow[]>().promise;
    renderModal(api);
    expect(await screen.findByText('Loading what changed…')).toBeDefined();
  });

  it('lists the five biggest resource movers with signed deltas', async () => {
    const api = apiFor();
    api.driftRows = [
      drift('i-web', 5), drift('db-main', -3), drift('noise', 0.004), drift('', 2),
      drift('cache', 1), drift('queue', 0.5), drift('bucket', 0.25),
    ];
    renderModal(api);

    const items = await screen.findAllByRole('listitem');
    // Sub-cent movement is noise; an unnamed resource shows as a dash; only
    // the first five movers are listed.
    expect(items.map((li) => li.textContent)).toEqual([
      'i-web+$5.00/day', 'db-main$-3.00/day', '—+$2.00/day', 'cache+$1.00/day', 'queue+$0.50/day',
    ]);
    const [grew, shrank] = items;
    if (grew === undefined || shrank === undefined) throw new Error('movers missing');
    expect(within(grew).getByText('+$5.00/day').className).toContain('text-warning');
    expect(within(shrank).getByText('$-3.00/day').className).toContain('text-positive');
    expect(api.driftCalls).toEqual([{ id: ID, child: 'resource_id' }]);
    expect(api.snapshotCalls).toEqual([ID]);
  });

  it('reports a worsening trend when no single resource drives it', async () => {
    const api = apiFor();
    api.snapshots = [snapshot('2026-01-01', 10), snapshot('2026-01-08', 15)];
    renderModal(api);

    const trend = await screen.findByText('trend: ▲ worsening (+$5.00/day)');
    expect(trend.className).toContain('text-warning');
    expect(screen.getByText('No single driver — the change is spread evenly.')).toBeDefined();
  });

  it('reports an improving trend', async () => {
    const api = apiFor();
    api.snapshots = [snapshot('2026-01-01', 15), snapshot('2026-01-04', 12), snapshot('2026-01-08', 10)];
    renderModal(api);

    const trend = await screen.findByText('trend: ▼ improving ($-5.00/day)');
    expect(trend.className).toContain('text-positive');
  });

  it('reports a flat trend under a cent of movement', async () => {
    const api = apiFor();
    api.snapshots = [snapshot('2026-01-01', 10), snapshot('2026-01-08', 10.004)];
    renderModal(api);
    expect(await screen.findByText('trend: flat')).toBeDefined();
  });

  it('stays hidden with no real movers and a single snapshot', async () => {
    const api = apiFor();
    api.driftRows = [drift('noise', 0.001)];
    api.snapshots = [snapshot('2026-01-01', 10)];
    renderModal(api);

    await waitFor(() => { expect(api.driftCalls).toHaveLength(1); });
    await waitFor(() => { expect(screen.queryByText('Loading what changed…')).toBeNull(); });
    expect(screen.queryByText(/What changed/)).toBeNull();
  });
});

describe('BaselineDetailModal — band override', () => {
  it('starts on the automated band, in dollars, with nothing to save', async () => {
    renderModal(apiFor());
    await bodyReady();

    expect(bandLabel('lower')).toBe('lower $10.00');
    expect(bandLabel('upper')).toBe('upper $20.00');
    // The dollar slider spans up to the costliest day.
    expect(screen.getByRole('slider', { name: 'Maximum' }).getAttribute('aria-valuemax')).toBe('50');
    expect(saveButton()).toHaveProperty('disabled', true);
    expect(screen.queryByRole('button', { name: 'Reset to automated' })).toBeNull();
    expect(screen.queryByText('Activity')).toBeNull();
  });

  it('previews percentile edges against the run-rate series', async () => {
    const { user } = renderModal(apiFor());
    await bodyReady();

    await user.click(screen.getByRole('button', { name: 'Percentile' }));
    // Over $10..$50: P10 of the non-zero days, P90 of all days.
    expect(bandLabel('lower')).toBe('lower P10 ($14.00)');
    expect(bandLabel('upper')).toBe('upper P90 ($46.00)');
    expect(statValue('Potential').textContent).toBe('$11.00/day');
    expect(statValue('Realized').textContent).toBe('$21.00/day');
    expect(screen.getByRole('slider', { name: 'Maximum' }).getAttribute('aria-valuemax')).toBe('100');
    expect(saveButton()).toHaveProperty('disabled', false);
  });

  it('resolves the extreme percentiles to the cheapest and costliest days', async () => {
    const { user } = renderModal(apiFor());
    await bodyReady();
    await user.click(screen.getByRole('button', { name: 'Percentile' }));

    act(() => { screen.getByRole('slider', { name: 'Minimum' }).focus(); });
    await user.keyboard('{Home}');
    expect(bandLabel('lower')).toBe('lower P0 ($10.00)');
    await user.keyboard('{End}');
    expect(bandLabel('upper')).toBe('upper P100 ($50.00)');
  });

  it('never previews the upper edge below the lower one', async () => {
    const { user } = renderModal(apiFor(baselineDetail(baselineRecord(), dailySeries('2026-01-01', [0, 0, 0, 0, 50]))));
    await bodyReady();
    await user.click(screen.getByRole('button', { name: 'Percentile' }));

    // A mostly idle scope: P10 skips the idle days ($50), P90 over every day
    // is only $30 — so the upper edge is held at the lower one.
    expect(bandLabel('lower')).toBe('lower P10 ($50.00)');
    expect(bandLabel('upper')).toBe('upper P90 ($50.00)');
  });

  it('prices an always-idle scope at zero', async () => {
    const { user } = renderModal(apiFor(baselineDetail(baselineRecord(), dailySeries('2026-01-01', [0, 0, 0]))));
    await bodyReady();
    await user.click(screen.getByRole('button', { name: 'Percentile' }));

    expect(bandLabel('lower')).toBe('lower P10 ($0.00)');
    expect(bandLabel('upper')).toBe('upper P90 ($0.00)');
  });

  it('amortizes a history shorter than the run-rate window', async () => {
    const { user } = renderModal(apiFor(baselineDetail(baselineRecord(), dailySeries('2026-01-01', [10, 20, 30, 40, 50]), 30)));
    await bodyReady();
    await user.click(screen.getByRole('button', { name: 'Percentile' }));

    // Five days under a 30-day window resolve to their single average, $30.
    expect(bandLabel('lower')).toBe('lower P10 ($30.00)');
    expect(bandLabel('upper')).toBe('upper P90 ($30.00)');
  });

  it('restores the automated band when switching back to dollars', async () => {
    const { user } = renderModal(apiFor());
    await bodyReady();
    await user.click(screen.getByRole('button', { name: 'Percentile' }));
    await user.click(screen.getByRole('button', { name: 'Absolute $' }));

    expect(bandLabel('lower')).toBe('lower $10.00');
    expect(bandLabel('upper')).toBe('upper $20.00');
  });

  it('opens on a saved percentile override and offers to reset it', async () => {
    renderModal(apiFor(baselineDetail(baselineRecord({ spec: baselineSpec({ manualBand: { mode: 'percentile' } }) }))));
    await bodyReady();

    expect(bandLabel('lower')).toBe('lower P10 ($14.00)');
    expect(bandLabel('upper')).toBe('upper P90 ($46.00)');
    expect(screen.getByRole('button', { name: 'Reset to automated' })).toBeDefined();
    expect(saveButton()).toHaveProperty('disabled', true);
  });

  it('opens on a saved dollar override', async () => {
    renderModal(apiFor(baselineDetail(baselineRecord({ spec: baselineSpec({ manualBand: { mode: 'absolute', lower: 12, upper: 30 } }) }))));
    await bodyReady();
    expect(bandLabel('lower')).toBe('lower $12.00');
    expect(bandLabel('upper')).toBe('upper $30.00');
  });

  it('fills an edge a partial override leaves unset from the automated band', async () => {
    renderModal(apiFor(baselineDetail(baselineRecord({ spec: baselineSpec({ manualBand: { mode: 'absolute', upper: 30 } }) }))));
    await bodyReady();
    expect(bandLabel('lower')).toBe('lower $10.00');
    expect(bandLabel('upper')).toBe('upper $30.00');
  });

  it('nudges a band edge from the keyboard without leaving the baseline', async () => {
    const onNext = vi.fn();
    const { user } = renderModal(apiFor(), { onNext });
    await bodyReady();

    act(() => { screen.getByRole('slider', { name: 'Minimum' }).focus(); });
    // The slider owns its arrow keys: one step of $50 / 200.
    await user.keyboard('{ArrowRight}');
    expect(bandLabel('lower')).toBe('lower $10.25');
    expect(onNext).not.toHaveBeenCalled();
    expect(saveButton()).toHaveProperty('disabled', false);
  });
});

describe('BaselineDetailModal — saving', () => {
  it('saves just the band when only the band changed', async () => {
    const api = apiFor();
    const { user, onChanged } = renderModal(api);
    await bodyReady();

    await user.click(screen.getByRole('button', { name: 'Percentile' }));
    await user.click(saveButton());
    await afterRefetch(api, 2);
    expect(api.updates).toEqual([{ id: ID, patch: { manualBand: { mode: 'percentile', lower: 10, upper: 90 } } }]);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('saves a note on its own and clears the box', async () => {
    const api = apiFor();
    const { user } = renderModal(api);
    await bodyReady();

    await user.type(screen.getByPlaceholderText(NOTE_PLACEHOLDER), 'Checked with the DB team');
    expect(saveButton()).toHaveProperty('disabled', false);
    await user.click(saveButton());
    await afterRefetch(api, 2);
    expect(api.patches()).toEqual([{ note: { text: 'Checked with the DB team' } }]);
    expect(screen.getByPlaceholderText(NOTE_PLACEHOLDER)).toHaveProperty('value', '');
  });

  it('saves the band and a note together', async () => {
    const api = apiFor();
    const { user } = renderModal(api);
    await bodyReady();

    await user.click(screen.getByRole('button', { name: 'Percentile' }));
    await user.type(screen.getByPlaceholderText(NOTE_PLACEHOLDER), 'Seasonal');
    await user.click(saveButton());
    await afterRefetch(api, 2);
    expect(api.patches()).toEqual([{ manualBand: { mode: 'percentile', lower: 10, upper: 90 }, note: { text: 'Seasonal' } }]);
  });

  it('keeps the edit and shows why when saving fails', async () => {
    const api = apiFor();
    api.failWith(new Error('Disk full'), 'IPC channel closed');
    const { user, onChanged } = renderModal(api);
    await bodyReady();

    const note = screen.getByPlaceholderText(NOTE_PLACEHOLDER);
    await user.type(note, 'Retry later');
    await user.click(saveButton());
    expect(await screen.findByText('Disk full')).toBeDefined();
    expect(note).toHaveProperty('value', 'Retry later');
    expect(saveButton()).toHaveProperty('disabled', false);

    // A rejection that is not an Error is shown as-is.
    await user.click(saveButton());
    expect(await screen.findByText('IPC channel closed')).toBeDefined();
    expect(screen.queryByText('Disk full')).toBeNull();
    expect(onChanged).not.toHaveBeenCalled();
    expect(api.getCalls).toHaveLength(1);
  });

  it('locks the editor while a save is in flight', async () => {
    const api = apiFor();
    const pending = deferred<BaselineRecord | null>();
    api.updateResult = () => pending.promise;
    const { user, onChanged } = renderModal(api);
    await bodyReady();

    await user.type(screen.getByPlaceholderText(NOTE_PLACEHOLDER), 'x');
    await user.click(saveButton());
    expect(saveButton()).toHaveProperty('disabled', true);
    expect(statusButton('Tracking')).toHaveProperty('disabled', true);

    pending.resolve(null);
    await afterRefetch(api, 2);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('resets an override to the automated band', async () => {
    const api = apiFor(baselineDetail(baselineRecord({ spec: baselineSpec({ manualBand: { mode: 'absolute', lower: 12, upper: 30 } }) })));
    const { user, onChanged } = renderModal(api);
    await bodyReady();

    await user.click(screen.getByRole('button', { name: 'Reset to automated' }));
    await afterRefetch(api, 2);
    expect(api.updates).toEqual([{ id: ID, patch: { manualBand: null, note: { text: 'Reset to automated band' } } }]);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('shows why a reset failed', async () => {
    const api = apiFor(baselineDetail(baselineRecord({ spec: baselineSpec({ manualBand: { mode: 'percentile' } }) })));
    api.failWith(new Error('Baseline is locked'), 'busy');
    const { user, onChanged } = renderModal(api);
    await bodyReady();

    const reset = screen.getByRole('button', { name: 'Reset to automated' });
    await user.click(reset);
    expect(await screen.findByText('Baseline is locked')).toBeDefined();
    expect(reset).toHaveProperty('disabled', false);
    await user.click(reset);
    expect(await screen.findByText('busy')).toBeDefined();
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe('BaselineDetailModal — triage status', () => {
  it('highlights the current status and saves a new one in place', async () => {
    const onNext = vi.fn();
    const api = apiFor();
    const { user, onChanged } = renderModal(api, { onNext });
    await bodyReady();

    expect(isHighlighted(statusButton('New'))).toBe(true);
    expect(isHighlighted(statusButton('Tracking'))).toBe(false);
    await user.click(statusButton('Tracking'));
    await afterRefetch(api, 2);

    expect(api.updates).toEqual([{ id: ID, patch: { triageStatus: 'tracking' } }]);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(isHighlighted(statusButton('Tracking'))).toBe(true);
    expect(within(headerRow()).getByText('Tracking')).toBeDefined();
    // An open status keeps the case on screen.
    expect(onNext).not.toHaveBeenCalled();
  });

  it('moves on to the next case after a closing status', async () => {
    const onNext = vi.fn();
    const api = apiFor();
    const { user } = renderModal(api, { onNext });
    await bodyReady();

    await user.click(statusButton('Resolved'));
    await waitFor(() => { expect(onNext).toHaveBeenCalledTimes(1); });
    expect(api.patches()).toEqual([{ triageStatus: 'resolved' }]);
  });

  it('stays on the last case after a closing status', async () => {
    const api = apiFor();
    const { user, onChanged } = renderModal(api);
    await bodyReady();

    await user.click(statusButton('Ignored'));
    await afterRefetch(api, 2);
    expect(api.patches()).toEqual([{ triageStatus: 'ignored' }]);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(isHighlighted(statusButton('Ignored'))).toBe(true);
  });

  it('restores the previous highlight when the write fails', async () => {
    const onNext = vi.fn();
    const api = apiFor();
    api.failWith(new Error('Read-only workspace'), 'offline');
    const { user } = renderModal(api, { onNext });
    await bodyReady();

    await user.click(statusButton('Dismissed'));
    expect(await screen.findByText('Read-only workspace')).toBeDefined();
    expect(isHighlighted(statusButton('New'))).toBe(true);
    expect(isHighlighted(statusButton('Dismissed'))).toBe(false);

    await user.click(statusButton('Tracking'));
    expect(await screen.findByText('offline')).toBeDefined();
    expect(isHighlighted(statusButton('New'))).toBe(true);
    expect(onNext).not.toHaveBeenCalled();
  });

  it('sets a status from its number key', async () => {
    const onNext = vi.fn();
    const api = apiFor();
    const { user } = renderModal(api, { onNext });
    await bodyReady();

    await user.keyboard('3');
    await afterRefetch(api, 2);
    expect(api.patches()).toEqual([{ triageStatus: 'acting' }]);
    expect(onNext).not.toHaveBeenCalled();

    await user.keyboard('5');
    await waitFor(() => { expect(onNext).toHaveBeenCalledTimes(1); });
    expect(api.patches()).toEqual([{ triageStatus: 'acting' }, { triageStatus: 'dismissed' }]);
  });

  it('ignores digits outside 1–6, other keys and modified shortcuts', async () => {
    const onNext = vi.fn();
    const onPrev = vi.fn();
    const api = apiFor();
    const { user } = renderModal(api, { onNext, onPrev });
    await bodyReady();

    await user.keyboard('07x');
    await user.keyboard('{Control>}2{/Control}{Meta>}2{/Meta}{Alt>}2{/Alt}');
    await user.keyboard('{Control>}{ArrowRight}{/Control}{Alt>}{ArrowLeft}{/Alt}');
    expect(api.updates).toEqual([]);
    expect(onNext).not.toHaveBeenCalled();
    expect(onPrev).not.toHaveBeenCalled();
  });

  it('ignores shortcuts typed into the note', async () => {
    const onNext = vi.fn();
    const api = apiFor();
    const { user } = renderModal(api, { onNext });
    await bodyReady();

    const note = screen.getByPlaceholderText(NOTE_PLACEHOLDER);
    await user.type(note, '2n');
    expect(note).toHaveProperty('value', '2n');
    expect(api.updates).toEqual([]);
    expect(onNext).not.toHaveBeenCalled();
  });

  it('steps through the list with the arrow and n/p keys', async () => {
    const onNext = vi.fn();
    const onPrev = vi.fn();
    const { user } = renderModal(apiFor(), { onNext, onPrev });
    await bodyReady();

    expect(screen.getByText('— press 1–6 to set; ← / → to move between baselines')).toBeDefined();
    await user.keyboard('{ArrowRight}n');
    expect(onNext).toHaveBeenCalledTimes(2);
    await user.keyboard('{ArrowLeft}p');
    expect(onPrev).toHaveBeenCalledTimes(2);
  });

  it('drops the arrow hint, and the arrows do nothing, without neighbours', async () => {
    const api = apiFor();
    const { user } = renderModal(api);
    await bodyReady();

    expect(screen.getByText('— press 1–6 to set')).toBeDefined();
    await user.keyboard('{ArrowRight}{ArrowLeft}np');
    expect(api.updates).toEqual([]);
    expect(screen.getByRole('img', { name: 'Daily cost history' })).toBeDefined();
  });

  it('ignores a second status key while the first is still saving', async () => {
    const api = apiFor();
    const pending = deferred<BaselineRecord | null>();
    api.updateResult = () => pending.promise;
    const { user } = renderModal(api);
    await bodyReady();

    await user.keyboard('2');
    await user.keyboard('3');
    expect(api.patches()).toEqual([{ triageStatus: 'tracking' }]);

    pending.resolve(null);
    await afterRefetch(api, 2);
    expect(isHighlighted(statusButton('Tracking'))).toBe(true);
  });
});

describe('BaselineDetailModal — activity', () => {
  it('lists notes newest first with their status changes and tickets', async () => {
    const now = Date.now();
    const record = baselineRecord({
      triage: {
        notes: [
          { at: new Date(now - 3 * 86_400_000).toISOString(), text: 'Discovered' },
          { at: new Date(now - 2 * 3_600_000).toISOString(), text: 'Watching the replicas', statusChange: { from: 'new', to: 'tracking' }, ticket: 'FIN-42' },
        ],
      },
    });
    renderModal(apiFor(baselineDetail(record)));
    await bodyReady();

    const activity = screen.getByText('Activity').parentElement;
    if (activity === null) throw new Error('activity section not found');
    expect(within(activity).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      '2h ago · [New → Tracking] Watching the replicas (FIN-42)',
      '3d ago · Discovered',
    ]);
  });
});

describe('BaselineDetailModal — triage mode', () => {
  it('replaces the editors with the four swipe actions', async () => {
    const record = baselineRecord({ triage: { notes: [{ at: new Date().toISOString(), text: 'Discovered' }] } });
    renderModal(apiFor(baselineDetail(record)), { triageMode: true });
    await bodyReady();

    for (const name of [/Dismiss/, /Skip/, /Act now/, /Track/]) {
      expect(screen.getByRole('button', { name })).toBeDefined();
    }
    expect(screen.getByText('Triage — each choice saves and advances to the next')).toBeDefined();
    expect(screen.queryByText('Band override')).toBeNull();
    expect(screen.queryByText(/^Triage status/)).toBeNull();
    expect(screen.queryByText('Activity')).toBeNull();
  });

  it('explains the actions on demand', async () => {
    const { user } = renderModal(apiFor(), { triageMode: true });
    await bodyReady();

    const help = screen.getByRole('button', { name: 'What do these actions mean?' });
    expect(screen.queryByText(/keep the baseline on your Open list/)).toBeNull();
    await user.click(help);
    expect(screen.getByText(/keep the baseline on your Open list/)).toBeDefined();
    expect(help.className).toContain('border-accent');
    await user.click(help);
    expect(screen.queryByText(/keep the baseline on your Open list/)).toBeNull();
    expect(help.className).not.toContain('border-accent');
  });

  it('dismisses a case and advances', async () => {
    const onNext = vi.fn();
    const api = apiFor();
    const { user, onChanged } = renderModal(api, { triageMode: true, onNext });
    await bodyReady();

    await user.click(screen.getByRole('button', { name: /Dismiss/ }));
    await waitFor(() => { expect(onNext).toHaveBeenCalledTimes(1); });
    expect(api.updates).toEqual([{ id: ID, patch: { triageStatus: 'dismissed' } }]);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('tracks or acts on a case and advances', async () => {
    const onNext = vi.fn();
    const api = apiFor();
    const { user } = renderModal(api, { triageMode: true, onNext });
    await bodyReady();

    await user.click(screen.getByRole('button', { name: /Track/ }));
    await afterRefetch(api, 2);
    await user.click(screen.getByRole('button', { name: /Act now/ }));
    await waitFor(() => { expect(onNext).toHaveBeenCalledTimes(2); });
    expect(api.patches()).toEqual([{ triageStatus: 'tracking' }, { triageStatus: 'acting' }]);
  });

  it('skips a case without saving', async () => {
    const onNext = vi.fn();
    const api = apiFor();
    const { user } = renderModal(api, { triageMode: true, onNext });
    await bodyReady();

    await user.click(screen.getByRole('button', { name: /Skip/ }));
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(api.updates).toEqual([]);
  });

  it('classifies from the arrow keys and skips on down or space', async () => {
    const onNext = vi.fn();
    const api = apiFor();
    const { user } = renderModal(api, { triageMode: true, onNext });
    await bodyReady();

    await user.keyboard('{ArrowLeft}');
    await afterRefetch(api, 2);
    await user.keyboard('{ArrowRight}');
    await afterRefetch(api, 3);
    await user.keyboard('{ArrowUp}');
    await afterRefetch(api, 4);
    await user.keyboard('{ArrowDown}');
    await user.keyboard(' ');
    await user.keyboard('x');

    expect(api.patches()).toEqual([{ triageStatus: 'dismissed' }, { triageStatus: 'tracking' }, { triageStatus: 'acting' }]);
    expect(onNext).toHaveBeenCalledTimes(5);
  });

  it('advances after any number-key status', async () => {
    const onNext = vi.fn();
    const api = apiFor();
    const { user } = renderModal(api, { triageMode: true, onNext });
    await bodyReady();

    // Tracking is an open status — in browse mode it would not advance.
    await user.keyboard('2');
    await waitFor(() => { expect(onNext).toHaveBeenCalledTimes(1); });
    expect(api.patches()).toEqual([{ triageStatus: 'tracking' }]);
  });

  it('stays on the case and shows why when a swipe fails', async () => {
    const onNext = vi.fn();
    const api = apiFor();
    api.failWith(new Error('Offline'), 'timeout');
    const { user } = renderModal(api, { triageMode: true, onNext });
    await bodyReady();

    await user.keyboard('{ArrowLeft}');
    expect(await screen.findByText('Offline')).toBeDefined();
    await user.keyboard('{ArrowUp}');
    expect(await screen.findByText('timeout')).toBeDefined();
    expect(onNext).not.toHaveBeenCalled();
  });

  it('ignores further swipes while one is saving', async () => {
    const onNext = vi.fn();
    const api = apiFor();
    const pending = deferred<BaselineRecord | null>();
    api.updateResult = () => pending.promise;
    const { user } = renderModal(api, { triageMode: true, onNext });
    await bodyReady();

    await user.keyboard('{ArrowLeft}');
    await user.keyboard('{ArrowRight}{ArrowDown}');
    expect(screen.getByRole('button', { name: /Track/ })).toHaveProperty('disabled', true);
    expect(api.patches()).toEqual([{ triageStatus: 'dismissed' }]);
    expect(onNext).not.toHaveBeenCalled();

    pending.resolve(null);
    await waitFor(() => { expect(onNext).toHaveBeenCalledTimes(1); });
  });

  it('saves without advancing at the end of the queue', async () => {
    const api = apiFor();
    const { user, onChanged } = renderModal(api, { triageMode: true });
    await bodyReady();

    await user.click(screen.getByRole('button', { name: /Skip/ }));
    expect(api.updates).toEqual([]);
    await user.click(screen.getByRole('button', { name: /Dismiss/ }));
    await afterRefetch(api, 2);
    expect(api.patches()).toEqual([{ triageStatus: 'dismissed' }]);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
});
