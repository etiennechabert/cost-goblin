import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asDimensionId, emptyRollupEstimate, tagSqlColumn } from '@costgoblin/core/browser';
import type { CostApi, DimensionsConfig, RollupDimEstimate, RollupGrainEstimate, TagDimension } from '@costgoblin/core/browser';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { DimensionsView } from '../views/dimensions.js';

/** The "Rollup impact" panel weighs the draft grain before it is applied:
 *  raw vs rollup size, compression, rebuild time, which dimensions inflate the
 *  grain, and the badges on the pills of the high-cardinality ones. These
 *  cases drive it with hand-built estimates to reach each readout. */

const TEAM: TagDimension = { tagName: 'team', label: 'Team' };

const CONFIG: DimensionsConfig = {
  builtIn: [
    { name: asDimensionId('account'), label: 'Account', field: 'account_id', displayField: 'account_name' },
    { name: asDimensionId('service'), label: 'Service', field: 'service' },
    { name: asDimensionId('charge_category'), label: 'Charge Category', field: 'charge_category' },
    { name: asDimensionId('region'), label: 'Region', field: 'region', enabled: false },
  ],
  tags: [TEAM],
};

function dim(column: string, over: Partial<RollupDimEstimate> = {}): RollupDimEstimate {
  return { column, cardinality: 10, rawOnly: false, marginalMultiplier: 1.5, marginalRows: 0, impactShare: 0.25, outlier: false, ...over };
}

interface EstimateShape {
  readonly raw?: { readonly rows: number; readonly bytes: number };
  readonly months?: number;
  readonly candidate?: { readonly rows: number; readonly bytes: number; readonly rebuildSeconds: number };
  readonly compressionRate?: number;
  readonly rawOnly?: { readonly recommended: boolean; readonly reason: string | null };
  readonly dims?: readonly RollupDimEstimate[];
}

function estimate(shape: EstimateShape = {}): RollupGrainEstimate {
  const candidate = shape.candidate ?? { rows: 120_000, bytes: 2_000_000, rebuildSeconds: 42 };
  return {
    probePeriod: '2026-04',
    months: shape.months ?? 12,
    lineItems: 100_000,
    raw: shape.raw ?? { rows: 1_200_000, bytes: 400_000_000 },
    current: null,
    currentMatchesCandidate: false,
    candidate: {
      ...candidate,
      perPartitionBytes: candidate.bytes,
      sizeBand: 'tiny',
      rebuildBand: 'fast',
      growthFactor: null,
    },
    compressionRate: shape.compressionRate ?? 10,
    rawOnly: shape.rawOnly ?? { recommended: false, reason: null },
    dims: shape.dims ?? [dim('service'), dim('account_id')],
  };
}

function makeApi(probe: () => Promise<RollupGrainEstimate>) {
  const api: CostApi = new MockCostApi();
  vi.spyOn(api, 'getDimensionsConfig').mockResolvedValue(CONFIG);
  const estimateSpy = vi.spyOn(api, 'estimateRollupGrain').mockImplementation(probe);
  return { api, estimateSpy };
}

function renderView(probe: () => Promise<RollupGrainEstimate>) {
  const { api, estimateSpy } = makeApi(probe);
  const user = userEvent.setup();
  render(
    <CostApiProvider value={api}>
      <DimensionsView />
    </CostApiProvider>,
  );
  return { estimateSpy, user };
}

function panel(): HTMLElement {
  const box = screen.getByRole('heading', { name: 'Rollup impact' }).closest('.rounded-xl');
  if (!(box instanceof HTMLElement)) throw new Error('no rollup impact panel');
  return box;
}

/** A stat's value and hint, by its label. */
function stat(label: string): { value: string; hint: string } {
  const labelEl = within(panel()).getByText(label);
  const value = labelEl.nextElementSibling;
  const hint = value?.nextElementSibling;
  return { value: value?.textContent ?? '', hint: hint?.textContent ?? '' };
}

/** The per-dimension impact list as [label, readout] pairs, top to bottom. */
function impactRows(): [string, string][] {
  return within(panel()).getAllByRole('listitem').map(li => [li.firstElementChild?.textContent ?? '', li.lastElementChild?.textContent ?? '']);
}

/** A pill in one of the two pill rows (the enabled-list rows below them
 *  start with the same label). */
function pill(row: 'Built-in dimensions' | 'Custom tag dimensions', name: RegExp): HTMLElement {
  const list = screen.getByRole('heading', { name: row }).nextElementSibling;
  if (!(list instanceof HTMLElement)) throw new Error(`no ${row} pills`);
  return within(list).getByRole('button', { name });
}

const SYNC_HINT = 'Sync billing data to estimate the rollup size for this grain.';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  cleanup();
});

describe('Rollup impact — no estimate to show', () => {
  it('asks to sync billing data when there is nothing to probe, also while a toggle settles', async () => {
    const { estimateSpy, user } = renderView(() => Promise.resolve(emptyRollupEstimate(null)));
    expect(await screen.findByText(SYNC_HINT)).toBeDefined();
    expect(within(panel()).queryByText('Estimated')).toBeNull();
    expect(within(panel()).queryByText('Actual')).toBeNull();
    const probes = estimateSpy.mock.calls.length;

    await user.click(screen.getByRole('button', { name: 'Charge Category' }));
    // Inside the settle window the grain is stale, but "no data" still stands.
    expect(screen.getByText(SYNC_HINT)).toBeDefined();
    expect(screen.queryByText('Estimating…')).toBeNull();

    await waitFor(() => { expect(estimateSpy.mock.calls.length).toBeGreaterThan(probes); });
    expect(await screen.findByText(SYNC_HINT)).toBeDefined();
  });

  it('says the estimate failed, rather than asking to sync', async () => {
    renderView(() => Promise.reject(new Error('probe timed out')));
    expect(await screen.findByText(/Couldn’t estimate the rollup size for this grain/)).toBeDefined();
    expect(screen.queryByText(SYNC_HINT)).toBeNull();
    expect(screen.queryByText('Estimating…')).toBeNull();
  });
});

describe('Rollup impact — readouts', () => {
  it('reads small figures exactly, and a grain that barely compresses as ~1×', async () => {
    renderView(() => Promise.resolve(estimate({
      months: 1,
      raw: { rows: 640, bytes: 2048 },
      candidate: { rows: 52, bytes: 4096, rebuildSeconds: 0.4 },
      compressionRate: 0.8,
    })));
    await screen.findByText('Est. rollup');
    expect(stat('Raw data').hint).toBe('640 line items · 1 mo');
    expect(stat('Est. rollup').hint).toBe('tiny · 52 rows');
    expect(stat('Compression')).toEqual({ value: '~1×', hint: 'smaller than raw · 0.8× fewer rows' });
    expect(stat('Rebuild').value).toBe('< 1s');
  });

  it.each([
    [42, '~42s'],
    [600, '~10 min'],
  ])('reads a %ss rebuild as %s', async (rebuildSeconds, shown) => {
    renderView(() => Promise.resolve(estimate({ candidate: { rows: 120_000, bytes: 2_000_000, rebuildSeconds } })));
    await screen.findByText('Est. rollup');
    expect(stat('Rebuild').value).toBe(shown);
    expect(stat('Compression').value).toBe('200.0×');
  });

  it('ranks the dimensions by how much each inflates the grain', async () => {
    renderView(() => Promise.resolve(estimate({
      dims: [
        dim('service', { marginalMultiplier: 1.01 }),
        dim('charge_category', { marginalMultiplier: 2 }),
        dim('account_id', { marginalMultiplier: 3, marginalRows: 12_000 }),
        // A column no configured dimension owns is named as-is.
        dim('usage_type', { marginalMultiplier: 1.2, marginalRows: 640 }),
      ],
    })));
    await screen.findByText('Per-dimension impact');
    expect(impactRows()).toEqual([
      ['Account', '×3.0 · +12k'],
      ['Charge Category', '×2.0'],
      ['usage_type', '×1.2 · +640'],
      ['Service', '~×1'],
    ]);
    expect(within(panel()).queryByText(/heavy for the rollup/)).toBeNull();
  });

  it('flags a heavy grain that no single dimension explains', async () => {
    renderView(() => Promise.resolve(estimate({ rawOnly: { recommended: true, reason: null } })));
    expect(await screen.findByText(/This grain is heavy for the rollup — it exceeds the size budget\./)).toBeDefined();
    expect(screen.queryByText(/multiplies the rollup/)).toBeNull();
  });

  it('gives the estimator\'s reason when it has one', async () => {
    renderView(() => Promise.resolve(estimate({ rawOnly: { recommended: true, reason: 'a monthly partition would be ~60 MB — over the 50 MB raw-only threshold' } })));
    expect(await screen.findByText(/heavy for the rollup — a monthly partition would be ~60 MB — over the 50 MB raw-only threshold\./)).toBeDefined();
  });
});

describe('Rollup impact — high-cardinality pills', () => {
  it('badges each enabled raw-only dimension with its distinct-value count', async () => {
    renderView(() => Promise.resolve(estimate({
      dims: [
        dim('charge_category', { rawOnly: true, cardinality: 12_000 }),
        dim('account_id', { rawOnly: true, cardinality: 640 }),
        dim(tagSqlColumn(TEAM), { rawOnly: true, cardinality: 0 }),
        // Region is disabled: its pill gets no badge.
        dim('region', { rawOnly: true, cardinality: 30 }),
        dim('service'),
      ],
    })));
    await screen.findByText('Per-dimension impact');

    const charge = pill('Built-in dimensions', /^Charge Category/);
    expect(within(charge).getByText('12k')).toBeDefined();
    expect(within(charge).getByTitle(/^High-cardinality \(~12k distinct values\)/)).toBeDefined();
    expect(within(pill('Built-in dimensions', /^Account/)).getByText('640')).toBeDefined();
    // No count to show: the badge just says raw.
    const team = pill('Custom tag dimensions', /^Team/);
    expect(within(team).getByText('raw')).toBeDefined();
    expect(within(team).getByTitle(/^High-cardinality — a primary driver/)).toBeDefined();

    expect(pill('Built-in dimensions', /^Region/).textContent).toBe('Region');
    expect(pill('Built-in dimensions', /^Service/).textContent).toBe('Service');
  });
});

describe('Rollup impact — progress', () => {
  function bar(): HTMLElement {
    const track = screen.getByText('Estimating…').nextElementSibling;
    const fill = track?.firstElementChild;
    if (!(fill instanceof HTMLElement)) throw new Error('no progress bar');
    return fill;
  }

  it('eases the bar toward the low 90s and holds there, never filling up on its own', async () => {
    vi.useFakeTimers();
    const { api } = makeApi(() => new Promise<RollupGrainEstimate>(() => undefined));
    render(
      <CostApiProvider value={api}>
        <DimensionsView />
      </CostApiProvider>,
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(bar().style.width).toBe('8%');

    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    const midway = Number.parseFloat(bar().style.width);
    expect(midway).toBeGreaterThan(8);
    expect(midway).toBeLessThan(92);

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    const settled = bar().style.width;
    expect(Number.parseFloat(settled)).toBeGreaterThanOrEqual(92);
    expect(Number.parseFloat(settled)).toBeLessThan(95);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(bar().style.width).toBe(settled);
  });
});
