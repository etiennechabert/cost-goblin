import { act, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type {
  BaselineCreateInput,
  BaselineDetail,
  BaselineRecomputeStatus,
  BaselineRecord,
  BaselinesConfigState,
  BaselinesDiscoveryConfig,
  BaselinesListParams,
  BaselinesListResult,
  BaselineTriageStatus,
  BaselineUpdatePatch,
  DimensionsConfig,
} from '@costgoblin/core/browser';
import { asDimensionId, asDollars, asEntityRef, asTagValue, OPEN_TRIAGE_STATUSES } from '@costgoblin/core/browser';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { Baselines } from '../views/baselines.js';
import { baselineDetail, baselineRecord, baselineSpec, deferred, rejectWith } from './baseline-fixtures.js';

function row(id: string, scopeLabel: string, triageStatus: BaselineTriageStatus, potential: number, realized: number, extra: Partial<BaselineRecord> = {}): BaselineRecord {
  return baselineRecord({
    spec: baselineSpec({ id }),
    scopeLabel,
    triageStatus,
    savings: {
      potentialDaily: asDollars(potential / 30),
      realizedDaily: asDollars(realized / 30),
      potentialMonthly: asDollars(potential),
      realizedMonthly: asDollars(realized),
    },
    ...extra,
  });
}

// Listed by potential saving, descending — the table's default sort.
const RDS = row('rds', 'Amazon RDS', 'new', 900, 0, { spec: baselineSpec({ id: 'rds', name: 'RDS fleet' }), ownerPath: [asEntityRef('platform'), asEntityRef('backend')] });
const S3 = row('s3', 'Amazon S3', 'tracking', 300, 150, { spec: baselineSpec({ id: 's3', source: 'manual' }) });
const CLOUDFRONT = row('cf', 'Amazon CloudFront', 'new', 100, 0, { ownerPath: [] });
const LAMBDA = row('lambda', 'AWS Lambda', 'dismissed', 50, 0);
const EC2 = row('ec2', 'Amazon EC2', 'acting', 0, 600, { status: 'under' });
const ALL = [RDS, S3, CLOUDFRONT, LAMBDA, EC2];

const DIMS: DimensionsConfig = {
  builtIn: [
    { name: asDimensionId('service'), label: 'Service', field: 'service' },
    { name: asDimensionId('region'), label: 'Region', field: 'region', description: 'Cloud region' },
    { name: asDimensionId('resource_id'), label: 'Resource', field: 'resource_id', description: 'High cardinality: one value per resource' },
    { name: asDimensionId('sku'), label: 'SKU', field: 'sku', enabled: false },
  ],
  tags: [],
};

const DISCOVERY: BaselinesDiscoveryConfig = {
  lookbackDays: 365, windowDays: 30, lowerPct: 10, upperPct: 90,
  minMonthlyCost: asDollars(100), minSavings: asDollars(0), reopenPct: 15, grainDimensions: [],
};

const OPEN = new Set<BaselineTriageStatus>(OPEN_TRIAGE_STATUSES);

function inFilter(record: BaselineRecord, triage: BaselinesListParams['triage']): boolean {
  if (triage === undefined) return true;
  if (triage === 'open') return OPEN.has(record.triageStatus);
  return record.triageStatus === triage;
}

/** What the backend answers: the filtered partition, its savings totals, and
 *  filter-independent counts. */
function listFor(all: readonly BaselineRecord[], params: BaselinesListParams): BaselinesListResult {
  const items = all.filter((r) => inFilter(r, params.triage));
  const count = (status: BaselineTriageStatus): number => all.filter((r) => r.triageStatus === status).length;
  return {
    items,
    totalPotentialMonthly: asDollars(items.reduce((s, r) => s + r.savings.potentialMonthly, 0)),
    totalRealizedMonthly: asDollars(items.reduce((s, r) => s + r.savings.realizedMonthly, 0)),
    total: items.length,
    counts: {
      all: all.length,
      open: all.filter((r) => OPEN.has(r.triageStatus)).length,
      new: count('new'), tracking: count('tracking'), acting: count('acting'),
      resolved: count('resolved'), dismissed: count('dismissed'), ignored: count('ignored'),
    },
  };
}

/** A stateful baselines backend: status writes persist, so refetches reflect
 *  them. Every call the view makes is recorded. */
class BaselinesApi extends MockCostApi {
  items: readonly BaselineRecord[];
  listResult: ((params: BaselinesListParams) => Promise<BaselinesListResult>) | null = null;
  createResult: (() => Promise<BaselineRecord>) | null = null;
  dims: DimensionsConfig = DIMS;
  dimsResult: (() => Promise<DimensionsConfig>) | null = null;
  grain: BaselinesDiscoveryConfig['grainDimensions'] = [];
  configResult: (() => Promise<BaselinesConfigState>) | null = null;
  setConfigResult: (() => Promise<BaselinesConfigState>) | null = null;
  recomputeResult: (() => Promise<void>) | null = null;
  readonly listCalls: BaselinesListParams[] = [];
  readonly getCalls: string[] = [];
  dimsCalls = 0;
  configCalls = 0;
  readonly updates: { readonly id: string; readonly patch: BaselineUpdatePatch }[] = [];
  readonly created: BaselineCreateInput[] = [];
  readonly configSaves: BaselinesDiscoveryConfig[] = [];
  readonly recomputes: ({ readonly startFresh?: boolean } | undefined)[] = [];

  constructor(items: readonly BaselineRecord[] = ALL) {
    super();
    this.items = items;
  }

  override listBaselines(params?: BaselinesListParams): Promise<BaselinesListResult> {
    const p = params ?? {};
    this.listCalls.push(p);
    return this.listResult?.(p) ?? Promise.resolve(listFor(this.items, p));
  }

  override getBaseline(id?: string): Promise<BaselineDetail | null> {
    if (id !== undefined) this.getCalls.push(id);
    const record = this.items.find((r) => r.spec.id === id);
    return Promise.resolve(record === undefined ? null : baselineDetail(record));
  }

  override updateBaseline(id?: string, patch?: BaselineUpdatePatch): Promise<BaselineRecord | null> {
    if (id === undefined || patch === undefined) return Promise.resolve(null);
    this.updates.push({ id, patch });
    const status = patch.triageStatus;
    if (status !== undefined) {
      this.items = this.items.map((r) => (r.spec.id === id ? { ...r, triageStatus: status } : r));
    }
    return Promise.resolve(this.items.find((r) => r.spec.id === id) ?? null);
  }

  override createBaseline(input: BaselineCreateInput): Promise<BaselineRecord> {
    this.created.push(input);
    return this.createResult?.() ?? super.createBaseline(input);
  }

  override getDimensionsConfig(): Promise<DimensionsConfig> {
    this.dimsCalls += 1;
    return this.dimsResult?.() ?? Promise.resolve(this.dims);
  }

  override getBaselinesConfig(): Promise<BaselinesConfigState> {
    this.configCalls += 1;
    return this.configResult?.() ?? Promise.resolve({ config: { ...DISCOVERY, grainDimensions: this.grain }, isCustom: this.grain.length > 0 });
  }

  override setBaselinesConfig(config: BaselinesDiscoveryConfig): Promise<BaselinesConfigState> {
    this.configSaves.push(config);
    return this.setConfigResult?.() ?? Promise.resolve({ config, isCustom: true });
  }

  override recomputeBaselines(opts?: { readonly startFresh?: boolean }): Promise<void> {
    this.recomputes.push(opts);
    return this.recomputeResult?.() ?? Promise.resolve();
  }
}

function renderView(api: BaselinesApi, baselineStatus?: BaselineRecomputeStatus) {
  const user = userEvent.setup();
  const view = render(
    <CostApiProvider value={api}>
      <Baselines baselineStatus={baselineStatus} />
    </CostApiProvider>,
  );
  function rerender(status: BaselineRecomputeStatus | undefined): void {
    view.rerender(
      <CostApiProvider value={api}>
        <Baselines baselineStatus={status} />
      </CostApiProvider>,
    );
  }
  return { user, rerender };
}

async function listReady(): Promise<void> {
  await screen.findByRole('button', { name: 'RDS fleet' });
}

/** A filter chip, whatever count badge it carries. */
function chip(label: string): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(`^${label}\\s*\\d*$`) });
}

function tableRow(scope: string | RegExp): HTMLElement {
  const tr = screen.getByRole('button', { name: scope }).closest('tr');
  if (tr === null) throw new Error('row not found');
  return tr;
}

function kpi(label: string): string | null | undefined {
  return screen.getByText(label).nextElementSibling?.textContent;
}

function checkbox(label: string): HTMLElement {
  return screen.getByRole('checkbox', { name: new RegExp(`^${label}`) });
}

const RUNNING: BaselineRecomputeStatus = { state: 'running', phase: 'discovering', done: 0, total: 0 };

describe('Baselines — list', () => {
  it('lists the open baselines with their savings totals', async () => {
    const api = new BaselinesApi();
    renderView(api);
    await listReady();

    expect(api.listCalls).toEqual([{ triage: 'open' }]);
    expect(screen.getByText('5 baselines')).toBeDefined();
    expect(kpi('Potential savings')).toBe('$1.3k/mo');
    expect(kpi('Realized savings')).toBe('$750.00/mo');
    // Counted over every baseline, not just the open ones.
    expect(kpi('Baselines')).toBe('5');
    expect(screen.queryByRole('button', { name: 'AWS Lambda' })).toBeNull();
  });

  it('shows each row with its owner, triage status and savings', async () => {
    renderView(new BaselinesApi());
    await listReady();

    const rds = tableRow('RDS fleet');
    expect(within(rds).getByText('platform / backend')).toBeDefined();
    expect(within(rds).getByText('New')).toBeDefined();
    expect(within(rds).getByText('$900.00').className).toContain('text-warning');
    expect(within(rds).getByText('$0.00').className).toContain('text-text-muted');

    const s3 = tableRow(/^Amazon S3/);
    expect(within(s3).getByText('(manual)')).toBeDefined();
    expect(within(s3).getByText('—')).toBeDefined();
    expect(within(s3).getByText('Tracking')).toBeDefined();
    expect(within(s3).getByText('$150.00').className).toContain('text-positive');

    // An empty owner path reads as no owner too.
    expect(within(tableRow('Amazon CloudFront')).getByText('—')).toBeDefined();
    const ec2 = tableRow('Amazon EC2');
    expect(within(ec2).getByText('$0.00').className).toContain('text-text-muted');
    expect(within(ec2).getByText('$600.00').className).toContain('text-positive');
    expect(within(tableRow('RDS fleet')).queryByText('(manual)')).toBeNull();
  });

  it('shows every status count on the filter chips', async () => {
    renderView(new BaselinesApi());
    await listReady();

    const expected: readonly (readonly [string, string])[] = [
      ['Open', '4'], ['All', '5'], ['New', '2'], ['Tracking', '1'], ['Acting', '1'], ['Resolved', '0'], ['Dismissed', '1'], ['Ignored', '0'],
    ];
    for (const [label, count] of expected) {
      expect(within(chip(label)).getByText(count)).toBeDefined();
    }
    // The meta filters carry no status dot; the statuses do.
    expect(chip('Open').querySelector('[aria-hidden="true"]')).toBeNull();
    expect(chip('All').querySelector('[aria-hidden="true"]')).toBeNull();
    expect(chip('Acting').querySelector('[aria-hidden="true"]')?.className).toContain('bg-warning');
    expect(chip('Open').className).toContain('bg-accent/15');
  });

  it('re-queries and re-tints when another filter is picked', async () => {
    const api = new BaselinesApi();
    const { user } = renderView(api);
    await listReady();

    await user.click(chip('All'));
    expect(await screen.findByRole('button', { name: 'AWS Lambda' })).toBeDefined();
    expect(api.listCalls.at(-1)).toEqual({});
    expect(chip('All').className).toContain('bg-accent/15');
    expect(chip('Open').className).not.toContain('bg-accent/15');

    await user.click(chip('Acting'));
    await waitFor(() => { expect(screen.queryByRole('button', { name: 'RDS fleet' })).toBeNull(); });
    expect(screen.getByRole('button', { name: 'Amazon EC2' })).toBeDefined();
    expect(api.listCalls.at(-1)).toEqual({ triage: 'acting' });
    expect(chip('Acting').className).toContain('bg-warning/15');

    await user.click(chip('Dismissed'));
    expect(await screen.findByRole('button', { name: 'AWS Lambda' })).toBeDefined();
    expect(chip('Dismissed').className).toContain('border-text-muted/60');
  });

  it('keeps the counts on screen while a new filter loads', async () => {
    const api = new BaselinesApi();
    const { user } = renderView(api);
    await listReady();

    const pending = deferred<BaselinesListResult>();
    api.listResult = () => pending.promise;
    await user.click(chip('New'));

    expect(await screen.findByRole('status')).toBeDefined();
    expect(screen.getByText('5 baselines')).toBeDefined();
    expect(within(chip('Open')).getByText('4')).toBeDefined();
    expect(screen.queryByText('Potential savings')).toBeNull();

    pending.resolve(listFor(ALL, { triage: 'new' }));
    expect(await screen.findByRole('button', { name: 'Amazon CloudFront' })).toBeDefined();
    expect(screen.queryByRole('button', { name: /^Amazon S3/ })).toBeNull();
  });

  it('shows a loader, without counts, until the first list arrives', async () => {
    const api = new BaselinesApi();
    api.listResult = () => deferred<BaselinesListResult>().promise;
    renderView(api);

    expect(await screen.findByRole('status')).toBeDefined();
    expect(chip('Open').textContent).toBe('Open');
    expect(screen.queryByText(/^\d+ baselines$/)).toBeNull();
  });

  it('shows why the list failed to load', async () => {
    const api = new BaselinesApi();
    api.listResult = () => rejectWith(new Error('Database is locked'));
    renderView(api);

    expect(await screen.findByText('Database is locked')).toBeDefined();
    expect(screen.queryByText('Potential savings')).toBeNull();
  });

  it('explains how baselines appear when there are none yet', async () => {
    renderView(new BaselinesApi([]));

    expect(await screen.findByText(/No baselines yet\. They are discovered automatically after a sync/)).toBeDefined();
    expect(screen.getByText('0 baselines')).toBeDefined();
    expect(kpi('Potential savings')).toBe('$0.00/mo');
  });
});

describe('Baselines — recompute status', () => {
  it('shows discovery as an indeterminate bar and locks recompute', async () => {
    renderView(new BaselinesApi(), RUNNING);
    await listReady();

    expect(screen.getByRole('button', { name: 'Discovering baselines…' })).toHaveProperty('disabled', true);
    const banner = screen.getByText('Discovering baselines…', { selector: 'span' }).closest('.rounded-lg');
    expect(banner?.querySelector('.animate-pulse')).not.toBeNull();
    expect(screen.queryByText(/^\d+%$/)).toBeNull();
  });

  it('shows computing progress as a percentage', async () => {
    renderView(new BaselinesApi(), { state: 'running', phase: 'computing', done: 3, total: 12 });
    await listReady();

    expect(screen.getByRole('button', { name: 'Computing 3 / 12' })).toHaveProperty('disabled', true);
    const fill = screen.getByText('25%').closest('.rounded-lg')?.querySelector<HTMLElement>('.h-full');
    expect(fill?.style.width).toBe('25%');
  });

  it('shows no percentage before the computation is sized', async () => {
    renderView(new BaselinesApi(), { state: 'running', phase: 'computing', done: 0, total: 0 });
    await listReady();

    expect(screen.getByRole('button', { name: 'Computing 0 / 0' })).toBeDefined();
    expect(screen.queryByText(/^\d+%$/)).toBeNull();
  });

  it('shows a failed recompute and lets you retry', async () => {
    renderView(new BaselinesApi(), { state: 'error', message: 'DuckDB ran out of memory', lastRun: null });
    await listReady();

    expect(screen.getByText('Recompute failed: DuckDB ran out of memory')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Recompute…' })).toHaveProperty('disabled', false);
  });

  it('refreshes the list once a recompute finishes', async () => {
    const api = new BaselinesApi();
    const { rerender } = renderView(api, RUNNING);
    await listReady();
    expect(api.listCalls).toHaveLength(1);

    rerender({ state: 'idle', lastRun: '2026-10-17T09:00:00.000Z' });
    await waitFor(() => { expect(api.listCalls).toHaveLength(2); });
  });

  it('does not refresh when a recompute fails', async () => {
    const api = new BaselinesApi();
    const { user, rerender } = renderView(api, RUNNING);
    await listReady();

    rerender({ state: 'error', message: 'boom', lastRun: null });
    expect(await screen.findByText('Recompute failed: boom')).toBeDefined();
    await user.click(chip('All'));
    expect(await screen.findByRole('button', { name: 'AWS Lambda' })).toBeDefined();
    // Only the initial load and the filter change.
    expect(api.listCalls).toEqual([{ triage: 'open' }, {}]);
  });
});

describe('Baselines — detail', () => {
  it('opens a baseline from its row and steps through the list', async () => {
    const api = new BaselinesApi();
    const { user } = renderView(api);
    await listReady();

    await user.click(screen.getByRole('button', { name: 'RDS fleet' }));
    const first = await screen.findByRole('dialog', { name: 'RDS fleet' });
    expect(within(first).getByText('1 / 4')).toBeDefined();
    expect(within(first).getByRole('button', { name: 'Previous baseline (←)' })).toHaveProperty('disabled', true);

    await user.click(within(first).getByRole('button', { name: 'Next baseline (→)' }));
    const second = await screen.findByRole('dialog', { name: 'Amazon S3' });
    expect(within(second).getByText('2 / 4')).toBeDefined();

    await user.click(within(second).getByRole('button', { name: 'Previous baseline (←)' }));
    expect(await screen.findByRole('dialog', { name: 'RDS fleet' })).toBeDefined();
    expect(api.getCalls).toEqual(['rds', 's3', 'rds']);

    await user.keyboard('{Escape}');
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
  });

  it('has nowhere further to go from the last row', async () => {
    const { user } = renderView(new BaselinesApi());
    await listReady();

    await user.click(screen.getByRole('button', { name: 'Amazon EC2' }));
    const dialog = await screen.findByRole('dialog', { name: 'Amazon EC2' });
    expect(within(dialog).getByText('4 / 4')).toBeDefined();
    expect(within(dialog).getByRole('button', { name: 'Next baseline (→)' })).toHaveProperty('disabled', true);
    expect(within(dialog).getByRole('button', { name: 'Previous baseline (←)' })).toHaveProperty('disabled', false);
  });

  it('refreshes the list when a baseline changes in the detail', async () => {
    const api = new BaselinesApi();
    const { user } = renderView(api);
    await listReady();

    await user.click(screen.getByRole('button', { name: 'RDS fleet' }));
    const dialog = await screen.findByRole('dialog', { name: 'RDS fleet' });
    await user.click(within(dialog).getByRole('button', { name: /^\d\s*Tracking$/ }));
    await waitFor(() => { expect(api.listCalls).toHaveLength(2); });
    expect(api.updates).toEqual([{ id: 'rds', patch: { triageStatus: 'tracking' } }]);

    await user.keyboard('{Escape}');
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
    expect(within(tableRow('RDS fleet')).getByText('Tracking')).toBeDefined();
  });

  it('moves to the next row after closing a baseline out', async () => {
    const api = new BaselinesApi();
    const { user } = renderView(api);
    await listReady();

    await user.click(screen.getByRole('button', { name: 'RDS fleet' }));
    const dialog = await screen.findByRole('dialog', { name: 'RDS fleet' });
    await user.click(within(dialog).getByRole('button', { name: /^\d\s*Dismissed$/ }));

    // RDS leaves the Open list, so S3 is now first of three.
    const next = await screen.findByRole('dialog', { name: 'Amazon S3' });
    expect(await within(next).findByText('1 / 3')).toBeDefined();
  });

  it('drops the position once the open baseline leaves the list', async () => {
    const api = new BaselinesApi();
    const { user } = renderView(api);
    await listReady();

    await user.click(screen.getByRole('button', { name: 'Amazon EC2' }));
    const dialog = await screen.findByRole('dialog', { name: 'Amazon EC2' });
    await user.click(within(dialog).getByRole('button', { name: /^\d\s*Dismissed$/ }));

    await waitFor(() => { expect(api.listCalls).toHaveLength(2); });
    await waitFor(() => { expect(screen.queryByRole('button', { name: 'Next baseline (→)' })).toBeNull(); });
    expect(screen.getByRole('dialog', { name: 'Amazon EC2' })).toBeDefined();
  });
});

describe('Baselines — triage', () => {
  it('walks the new baselines one by one, then refreshes the list', async () => {
    const api = new BaselinesApi();
    const { user } = renderView(api);
    await listReady();

    await user.click(screen.getByRole('button', { name: 'Triage new' }));
    const first = await screen.findByRole('dialog', { name: 'RDS fleet' });
    expect(api.listCalls).toContainEqual({ triage: 'new' });
    expect(within(first).getByText('1 / 2')).toBeDefined();
    expect(within(first).getByRole('button', { name: 'Previous baseline (←)' })).toHaveProperty('disabled', true);

    await user.click(within(first).getByRole('button', { name: /Track/ }));
    const second = await screen.findByRole('dialog', { name: 'Amazon CloudFront' });
    expect(within(second).getByText('2 / 2')).toBeDefined();
    expect(api.updates).toEqual([{ id: 'rds', patch: { triageStatus: 'tracking' } }]);

    await user.click(within(second).getByRole('button', { name: 'Previous baseline (←)' }));
    const back = await screen.findByRole('dialog', { name: 'RDS fleet' });
    await user.click(within(back).getByRole('button', { name: 'Next baseline (→)' }));
    const last = await screen.findByRole('dialog', { name: 'Amazon CloudFront' });

    const listCallsBefore = api.listCalls.length;
    await user.click(within(last).getByRole('button', { name: /Skip/ }));
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
    await waitFor(() => { expect(api.listCalls).toHaveLength(listCallsBefore + 1); });
  });

  it('ends triage on Escape and refreshes the list', async () => {
    const api = new BaselinesApi();
    const { user } = renderView(api);
    await listReady();

    await user.click(screen.getByRole('button', { name: 'Triage new' }));
    await screen.findByRole('dialog', { name: 'RDS fleet' });
    const listCallsBefore = api.listCalls.length;
    await user.keyboard('{Escape}');

    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
    await waitFor(() => { expect(api.listCalls).toHaveLength(listCallsBefore + 1); });
  });

  it('does nothing when nothing is new', async () => {
    const api = new BaselinesApi([S3, LAMBDA, EC2]);
    const { user } = renderView(api);
    await screen.findByRole('button', { name: /^Amazon S3/ });

    await user.click(screen.getByRole('button', { name: 'Triage new' }));
    await waitFor(() => { expect(api.listCalls).toContainEqual({ triage: 'new' }); });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Baselines — new baseline', () => {
  async function openDialog(api: BaselinesApi) {
    const view = renderView(api);
    await screen.findByRole('button', { name: 'New baseline' });
    await view.user.click(screen.getByRole('button', { name: 'New baseline' }));
    await screen.findByRole('dialog', { name: 'New baseline' });
    return view;
  }

  it('offers the enabled built-in dimensions, the first one picked', async () => {
    await openDialog(new BaselinesApi());

    const select = await screen.findByRole('combobox', { name: 'Dimension' });
    await waitFor(() => { expect(within(select).getAllByRole('option')).toHaveLength(3); });
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Service', 'Region', 'Resource']);
    expect(select).toHaveProperty('value', 'service');
  });

  it('creates a baseline for the value typed, then refreshes the list', async () => {
    const api = new BaselinesApi();
    const { user } = await openDialog(api);
    await waitFor(() => { expect(screen.getByRole('combobox', { name: 'Dimension' })).toHaveProperty('value', 'service'); });

    await user.type(screen.getByRole('textbox', { name: 'Value' }), 'Amazon RDS');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
    expect(api.created).toEqual([{ scope: { kind: 'filter', filters: { [asDimensionId('service')]: [asTagValue('Amazon RDS')] } } }]);
    await waitFor(() => { expect(api.listCalls).toHaveLength(2); });
  });

  it('scopes the baseline to the dimension picked', async () => {
    const api = new BaselinesApi();
    const { user } = await openDialog(api);
    const select = screen.getByRole('combobox', { name: 'Dimension' });
    await waitFor(() => { expect(within(select).getAllByRole('option')).toHaveLength(3); });

    await user.selectOptions(select, 'region');
    await user.type(screen.getByRole('textbox', { name: 'Value' }), 'eu-west-1');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => { expect(api.created).toHaveLength(1); });
    expect(api.created[0]?.scope).toEqual({ kind: 'filter', filters: { [asDimensionId('region')]: [asTagValue('eu-west-1')] } });
  });

  it('asks for a value before creating', async () => {
    const api = new BaselinesApi();
    const { user } = await openDialog(api);

    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(screen.getByText('Pick a dimension and a value.')).toBeDefined();
    expect(api.created).toEqual([]);
  });

  it('cannot create without an enabled built-in dimension', async () => {
    const api = new BaselinesApi();
    const dims = deferred<DimensionsConfig>();
    api.dimsResult = () => dims.promise;
    const { user } = await openDialog(api);
    // Settle the request inside act so the empty list has rendered before
    // Create is pressed.
    await waitFor(() => { expect(api.dimsCalls).toBe(1); });
    await act(async () => {
      dims.resolve({ builtIn: DIMS.builtIn.map((d) => ({ ...d, enabled: false })), tags: [] });
      await dims.promise;
    });

    await user.type(screen.getByRole('textbox', { name: 'Value' }), 'Amazon RDS');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(screen.getByText('Pick a dimension and a value.')).toBeDefined();
    expect(within(screen.getByRole('combobox', { name: 'Dimension' })).queryAllByRole('option')).toEqual([]);
    expect(api.created).toEqual([]);
  });

  it('shows why creation failed and keeps the dialog open', async () => {
    const api = new BaselinesApi();
    const reasons: unknown[] = [new Error('A baseline already covers this scope'), 'backend unavailable'];
    api.createResult = () => rejectWith(reasons.shift());
    const { user } = await openDialog(api);

    await user.type(screen.getByRole('textbox', { name: 'Value' }), 'Amazon RDS');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('A baseline already covers this scope')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('backend unavailable')).toBeDefined();
    expect(screen.getByRole('dialog', { name: 'New baseline' })).toBeDefined();
    expect(api.listCalls).toHaveLength(1);
  });

  it('closes on Cancel without creating anything', async () => {
    const api = new BaselinesApi();
    const { user } = await openDialog(api);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
    expect(api.created).toEqual([]);
  });
});

describe('Baselines — recompute dialog', () => {
  async function openDialog(api: BaselinesApi) {
    const view = renderView(api);
    await screen.findByRole('button', { name: 'Recompute…' });
    await view.user.click(screen.getByRole('button', { name: 'Recompute…' }));
    await screen.findByRole('dialog', { name: 'Recompute baselines' });
    return view;
  }

  function runButton(name: string | RegExp = 'Recompute'): HTMLElement {
    return screen.getByRole('button', { name });
  }

  it('waits for both the config and the dimensions before allowing a run', async () => {
    const api = new BaselinesApi();
    const config = deferred<BaselinesConfigState>();
    const dims = deferred<DimensionsConfig>();
    api.configResult = () => config.promise;
    api.dimsResult = () => dims.promise;
    await openDialog(api);

    expect(screen.getByText('Loading dimensions…')).toBeDefined();
    expect(runButton()).toHaveProperty('disabled', true);
    await waitFor(() => { expect(api.configCalls).toBe(1); });

    // The config alone is not enough to draw the checklist. (Settling it
    // inside act commits its result before the dimensions arrive.)
    await act(async () => {
      config.resolve({ config: DISCOVERY, isCustom: false });
      await config.promise;
    });
    expect(screen.getByText('Loading dimensions…')).toBeDefined();
    expect(runButton()).toHaveProperty('disabled', true);

    dims.resolve(DIMS);
    expect(await screen.findByRole('checkbox', { name: /^Service/ })).toBeDefined();
    expect(runButton()).toHaveProperty('disabled', false);
  });

  it('pre-selects the automatic grain: enabled dimensions minus high-cardinality ones', async () => {
    await openDialog(new BaselinesApi());
    await screen.findByRole('checkbox', { name: /^Service/ });

    expect(checkbox('Service')).toHaveProperty('checked', true);
    expect(checkbox('Region')).toHaveProperty('checked', true);
    expect(checkbox('Resource')).toHaveProperty('checked', false);
    expect(screen.getByText('high cardinality')).toBeDefined();
    expect(screen.queryByRole('checkbox', { name: /^SKU/ })).toBeNull();
  });

  it('starts from a custom grain when one is saved', async () => {
    const api = new BaselinesApi();
    api.grain = [asDimensionId('region')];
    await openDialog(api);
    await screen.findByRole('checkbox', { name: /^Service/ });

    expect(checkbox('Service')).toHaveProperty('checked', false);
    expect(checkbox('Region')).toHaveProperty('checked', true);
    expect(checkbox('Resource')).toHaveProperty('checked', false);
  });

  it('recomputes without saving a grain when the checklist is untouched', async () => {
    const api = new BaselinesApi();
    const { user } = await openDialog(api);
    await screen.findByRole('checkbox', { name: /^Service/ });

    expect(screen.getByText(/Untouched baselines that no longer match/)).toBeDefined();
    await user.click(runButton());
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
    expect(api.recomputes).toEqual([{ startFresh: false }]);
    expect(api.configSaves).toEqual([]);
  });

  it('wipes and rediscovers when starting fresh', async () => {
    const api = new BaselinesApi();
    const { user } = await openDialog(api);
    await screen.findByRole('checkbox', { name: /^Service/ });

    await user.click(checkbox('Start fresh'));
    expect(screen.queryByText(/Untouched baselines that no longer match/)).toBeNull();
    await user.click(runButton('Wipe & recompute'));
    await waitFor(() => { expect(api.recomputes).toEqual([{ startFresh: true }]); });
  });

  it('saves an edited grain before recomputing', async () => {
    const api = new BaselinesApi();
    const { user } = await openDialog(api);
    await screen.findByRole('checkbox', { name: /^Service/ });

    await user.click(checkbox('Region'));
    await user.click(checkbox('Resource'));
    expect(checkbox('Region')).toHaveProperty('checked', false);
    expect(checkbox('Resource')).toHaveProperty('checked', true);
    await user.click(runButton());

    await waitFor(() => { expect(api.recomputes).toEqual([{ startFresh: false }]); });
    expect(api.configSaves).toEqual([{ ...DISCOVERY, grainDimensions: [asDimensionId('service'), asDimensionId('resource_id')] }]);
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
  });

  it('requires at least one dimension', async () => {
    const api = new BaselinesApi();
    const { user } = await openDialog(api);
    await screen.findByRole('checkbox', { name: /^Service/ });

    await user.click(checkbox('Service'));
    await user.click(checkbox('Region'));
    await user.click(runButton());

    expect(screen.getByText('Pick at least one dimension.')).toBeDefined();
    expect(runButton()).toHaveProperty('disabled', false);
    expect(api.configSaves).toEqual([]);
    expect(api.recomputes).toEqual([]);
  });

  it('shows the run starting while the grain saves', async () => {
    const api = new BaselinesApi();
    const pending = deferred<BaselinesConfigState>();
    api.setConfigResult = () => pending.promise;
    const { user } = await openDialog(api);
    await screen.findByRole('checkbox', { name: /^Service/ });

    await user.click(checkbox('Region'));
    await user.click(runButton());
    expect(runButton('Starting…')).toHaveProperty('disabled', true);
    expect(api.recomputes).toEqual([]);

    pending.resolve({ config: DISCOVERY, isCustom: true });
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
    expect(api.recomputes).toEqual([{ startFresh: false }]);
  });

  it('shows why saving the grain failed and allows a retry', async () => {
    const api = new BaselinesApi();
    const reasons: unknown[] = [new Error('Config is read-only'), 'permission denied'];
    api.setConfigResult = () => rejectWith(reasons.shift());
    const { user } = await openDialog(api);
    await screen.findByRole('checkbox', { name: /^Service/ });

    await user.click(checkbox('Region'));
    await user.click(runButton());
    expect(await screen.findByText('Config is read-only')).toBeDefined();
    expect(runButton()).toHaveProperty('disabled', false);

    await user.click(runButton());
    expect(await screen.findByText('permission denied')).toBeDefined();
    expect(api.recomputes).toEqual([]);
    expect(screen.getByRole('dialog', { name: 'Recompute baselines' })).toBeDefined();
  });

  it('falls back to the current settings when the config cannot be read', async () => {
    const api = new BaselinesApi();
    api.configResult = () => rejectWith(new Error('Config unreadable'));
    const { user } = await openDialog(api);

    expect(await screen.findByText("Couldn't load dimensions (Config unreadable). Recompute will use the current settings.")).toBeDefined();
    expect(screen.queryByRole('checkbox', { name: /^Service/ })).toBeNull();
    await user.click(runButton());
    await waitFor(() => { expect(api.recomputes).toEqual([{ startFresh: false }]); });
    expect(api.configSaves).toEqual([]);
  });

  it('warns when the dimensions cannot be read', async () => {
    const api = new BaselinesApi();
    api.dimsResult = () => rejectWith(new Error('Dimensions unreadable'));
    await openDialog(api);

    expect(await screen.findByText("Couldn't load dimensions (Dimensions unreadable). Recompute will use the current settings.")).toBeDefined();
    expect(screen.queryByRole('checkbox', { name: /^Service/ })).toBeNull();
  });

  it('closes once the run is started, even if the recompute later fails', async () => {
    const api = new BaselinesApi();
    api.recomputeResult = () => rejectWith(new Error('recompute crashed'));
    const { user } = await openDialog(api);
    await screen.findByRole('checkbox', { name: /^Service/ });

    await user.click(runButton());
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
    expect(api.recomputes).toHaveLength(1);
    expect(screen.queryByText(/recompute crashed/)).toBeNull();
  });

  it('closes on Cancel without recomputing', async () => {
    const api = new BaselinesApi();
    const { user } = await openDialog(api);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
    expect(api.recomputes).toEqual([]);
  });
});
