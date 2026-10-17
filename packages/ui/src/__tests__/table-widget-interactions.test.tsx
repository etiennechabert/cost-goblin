import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { asDateString, asDimensionId, asTagValue } from '@costgoblin/core/browser';
import type {
  AggregatedTableParams,
  AggregatedTableResult,
  AggregatedTableRow,
  DateRange,
  Dimension,
  DimensionId,
  ExplorerOverviewResult,
  FilterMap,
  TagValue,
  WidgetSpec,
} from '@costgoblin/core/browser';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { TableWidget } from '../widgets/table-widget.js';

const RANGE: DateRange = { start: asDateString('2026-03-01'), end: asDateString('2026-03-31') };
const PREV_RANGE: DateRange = { start: asDateString('2026-01-29'), end: asDateString('2026-02-28') };
const FILTERS: FilterMap = { [asDimensionId('account')]: [asTagValue('prod')] };

// Only service and account are configured dimensions: their columns are
// click-to-filter, while region (not a dimension here) stays inert.
const DIMS: readonly Dimension[] = [
  { name: asDimensionId('service'), label: 'Service', field: 'service' },
  { name: asDimensionId('account'), label: 'Account', field: 'account_id', displayField: 'account_name' },
];

const OVERVIEW: ExplorerOverviewResult = {
  windowDays: 31,
  startDate: '2026-03-01',
  endDate: '2026-03-31',
  dailyTotals: [],
  totalRows: 54_012,
  totalCost: 1_570,
  tagColumns: [{ id: 'tag_team', label: 'Team' }],
};

interface FixtureRow {
  readonly values: Readonly<Record<string, string>>;
  readonly cost: number;
  readonly listCost: number;
  readonly usageAmount: number;
  readonly rowCount: number;
  readonly previousCost?: number;
}

// One row per delta case: increase, decrease, no change, previous of zero, and
// no previous row at all. RDS is a credit (negative cost).
const FIXTURE: readonly FixtureRow[] = [
  { values: { service: 'Amazon EC2', region: 'eu-central-1', account_name: 'prod', tag_team: 'platform' }, cost: 1_200, listCost: 1_500, usageAmount: 24.123456, rowCount: 500, previousCost: 1_000 },
  { values: { service: 'Amazon S3', region: 'eu-central-1', account_name: 'prod', tag_team: 'data' }, cost: 300, listCost: 300, usageAmount: 1_000, rowCount: 10, previousCost: 400 },
  { values: { service: 'AWS Lambda', region: 'us-east-1', account_name: 'dev', tag_team: 'data' }, cost: 80, listCost: 90, usageAmount: 0, rowCount: 1_234, previousCost: 80 },
  { values: { service: 'Amazon RDS', region: 'us-east-1', account_name: 'prod', tag_team: 'platform' }, cost: -50, listCost: -60, usageAmount: 12, rowCount: 2, previousCost: 0 },
  { values: { service: 'Amazon CloudFront', region: '', account_name: 'dev', tag_team: '' }, cost: 40, listCost: 40, usageAmount: 5, rowCount: 3 },
];

/** Aggregate like the real handler: each returned row is keyed by exactly the
 *  requested group-by columns. */
function project(rows: readonly FixtureRow[], columns: readonly string[], cost: (r: FixtureRow) => number | undefined): AggregatedTableRow[] {
  const out: AggregatedTableRow[] = [];
  for (const r of rows) {
    const c = cost(r);
    if (c === undefined) continue;
    const values: Record<string, string> = {};
    for (const col of columns) values[col] = r.values[col] ?? '';
    out.push({ values, cost: c, listCost: r.listCost, usageAmount: r.usageAmount, rowCount: r.rowCount });
  }
  return out;
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

type TableHandler = (params: AggregatedTableParams) => Promise<AggregatedTableResult>;

/** Records every aggregated-table query and routes it by purpose: the visible
 *  rows, the previous-period rows, or a row's expanded line items. */
class TableApi extends MockCostApi {
  readonly calls: AggregatedTableParams[] = [];
  overview: () => Promise<ExplorerOverviewResult> = () => Promise.resolve(OVERVIEW);
  current: TableHandler = (p) => Promise.resolve({ rows: project(FIXTURE, p.groupByColumns, r => r.cost), totalRows: 1_234, tagColumns: [] });
  previous: TableHandler = (p) => Promise.resolve({ rows: project(FIXTURE, p.groupByColumns, r => r.previousCost), totalRows: 4, tagColumns: [] });
  detail: TableHandler = () => Promise.resolve({ rows: [], totalRows: 0, tagColumns: [] });

  override queryExplorerOverview(): Promise<ExplorerOverviewResult> {
    return this.overview();
  }

  override queryAggregatedTable(params?: AggregatedTableParams): Promise<AggregatedTableResult> {
    if (params === undefined) return Promise.reject(new Error('queryAggregatedTable called without params'));
    this.calls.push(params);
    if (params.rowFilters !== undefined) return this.detail(params);
    if (params.origin === 'widget:table:rows/prev') return this.previous(params);
    return this.current(params);
  }

  callsFor(origin: string): AggregatedTableParams[] {
    return this.calls.filter(c => c.origin === origin);
  }

  lastRowsCall(): AggregatedTableParams {
    const last = this.callsFor('widget:table:rows').at(-1);
    if (last === undefined) throw new Error('no rows query yet');
    return last;
  }
}

const TABLE_SPEC: WidgetSpec = {
  id: 'tbl',
  type: 'table',
  size: 'full',
  title: 'Breakdown',
  enabledColumns: ['service', 'cost', 'list_cost', 'usage_amount', 'region'],
};

interface RenderOptions {
  readonly spec?: WidgetSpec;
  readonly compareEnabled?: boolean;
  readonly api?: TableApi;
}

function renderTable(opts: RenderOptions = {}) {
  const api = opts.api ?? new TableApi();
  const onSetFilter = vi.fn<(dim: DimensionId, value: TagValue) => void>();
  const user = userEvent.setup();
  const utils = render(
    <CostApiProvider value={api}>
      <TableWidget
        spec={opts.spec ?? TABLE_SPEC}
        dateRange={RANGE}
        previousDateRange={PREV_RANGE}
        compareEnabled={opts.compareEnabled ?? false}
        granularity="daily"
        globalFilters={FILTERS}
        dimensions={DIMS}
        onSetFilter={onSetFilter}
      />
    </CostApiProvider>,
  );
  return { api, onSetFilter, user, ...utils };
}

/** The widget's own table — the first one; an expanded row nests another. */
async function mainTable(): Promise<HTMLElement> {
  const tables = await screen.findAllByRole('table');
  const first = tables[0];
  if (first === undefined) throw new Error('no table rendered');
  return first;
}

async function headers(): Promise<string[]> {
  const table = await mainTable();
  const head = table.querySelector('thead');
  if (head === null) throw new Error('table has no head');
  return within(head).getAllByRole('columnheader').map(th => th.textContent.replace(/[↑↓↕]/g, '').trim());
}

/** The data row whose cells include `text`, as its cells' text. */
function rowCells(text: string): string[] {
  const row = screen.getByText(text).closest('tr');
  if (row === null) throw new Error(`no row containing ${text}`);
  return within(row).getAllByRole('cell').map(td => td.textContent);
}

/** Click a plain (non-filter) cell of the row containing `text`: the Cost
 *  cell, column 1 in the spec's column order. Expands the row. */
async function expandRow(user: ReturnType<typeof userEvent.setup>, text: string): Promise<void> {
  const row = (await screen.findByText(text)).closest('tr');
  if (row === null) throw new Error(`no row containing ${text}`);
  const costCell = within(row).getAllByRole('cell')[1];
  if (costCell === undefined) throw new Error('row has no cost cell');
  await user.click(costCell);
}

describe('TableWidget — rows and formatting', () => {
  it('renders aggregated rows in the configured column order with formatted money and usage', async () => {
    const { api } = renderTable();

    await screen.findByText('Amazon EC2');
    expect(screen.getByRole('heading', { name: 'Breakdown' })).toBeDefined();
    expect(await headers()).toEqual(['Service', 'Cost', 'List', 'Usage', 'Region']);

    const usage = (24.123456).toLocaleString(undefined, { maximumFractionDigits: 4 });
    expect(rowCells('Amazon EC2')).toEqual(['Amazon EC2', '$1.2k', '$1.5k', usage, 'eu-central-1']);
    // A credit renders with a leading minus and the warning colour.
    expect(rowCells('Amazon RDS')).toEqual(['Amazon RDS', '-$50.00', '-$60.00', '12', 'us-east-1']);
    expect(screen.getByText('-$50.00').className).toContain('text-warning');
    expect(screen.getByText('$300.00', { selector: 'span' }).className).not.toContain('text-warning');
    // Zero usage is blank rather than "0".
    expect(rowCells('AWS Lambda')[3]).toBe('');

    // Server-side aggregation grouped by the enabled dimension columns only,
    // in canonical column order, with the dashboard filters and cost scope.
    const call = api.lastRowsCall();
    expect(call.groupByColumns).toEqual(['service', 'region']);
    expect(call.rowLimit).toBe(500);
    expect(call.applyCostScope).toBe(true);
    expect(call.filters).toEqual({ account: ['prod'] });
    expect(call.dateRange).toEqual(RANGE);
    expect('sort' in call).toBe(false);

    // The count reports the aggregate total, not just the rows returned.
    expect(screen.getByText(/Showing/).textContent).toBe(`Showing 5 of ${(1_234).toLocaleString()} rows`);
  });

  it('filters on a dimension cell and leaves other cells inert', async () => {
    const { user, onSetFilter } = renderTable();

    await user.click(await screen.findByRole('button', { name: 'Amazon EC2' }));
    expect(onSetFilter).toHaveBeenCalledWith(asDimensionId('service'), asTagValue('Amazon EC2'));

    // Region is not a configured dimension, and cost is not a dimension at all.
    expect(screen.queryByRole('button', { name: 'eu-central-1' })).toBeNull();
    expect(screen.queryByRole('button', { name: '$1.2k' })).toBeNull();
  });

  it('defaults to the seed columns when the spec names none', async () => {
    const { api } = renderTable({ spec: { id: 'tbl', type: 'table', size: 'full' } });

    expect(await headers()).toEqual(['Cost', 'Resource', 'Description']);
    expect(api.lastRowsCall().groupByColumns).toEqual(['resource_id', 'description']);
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('renders nothing for a spec that is not a table', () => {
    const { container } = renderTable({ spec: { id: 's', type: 'summary', size: 'small' } });
    expect(container.innerHTML).toBe('');
  });
});

describe('TableWidget — loading and errors', () => {
  it('shows the loader until both the overview and the rows have arrived', async () => {
    const api = new TableApi();
    const overview = deferred<ExplorerOverviewResult>();
    api.overview = () => overview.promise;
    renderTable({ api });

    await waitFor(() => { expect(api.callsFor('widget:table:rows')).toHaveLength(1); });
    expect(screen.getByRole('status')).toBeDefined();
    expect(screen.queryByRole('table')).toBeNull();

    overview.resolve(OVERVIEW);
    expect(await screen.findByText('Amazon EC2')).toBeDefined();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('surfaces a failed rows query', async () => {
    const api = new TableApi();
    api.current = () => Promise.reject(new Error('DuckDB ran out of memory'));
    renderTable({ api });

    expect(await screen.findByText('DuckDB ran out of memory')).toBeDefined();
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('TableWidget — sorting', () => {
  it('sorts on the server through the column headers', async () => {
    const { api, user } = renderTable();
    await screen.findByText('Amazon EC2');
    // Each new sort re-queries, and the table shows the loader until the
    // re-sorted rows arrive — so wait for the header to come back each time.
    const costHeader = () => screen.findByRole('button', { name: /^Cost/ });

    // Numeric columns sort descending first, then ascending, then not at all.
    await user.click(await costHeader());
    await waitFor(() => { expect(api.lastRowsCall().sort).toEqual({ column: 'cost', direction: 'desc' }); });
    expect((await costHeader()).textContent).toContain('↓');

    await user.click(await costHeader());
    await waitFor(() => { expect(api.lastRowsCall().sort).toEqual({ column: 'cost', direction: 'asc' }); });
    expect((await costHeader()).textContent).toContain('↑');

    const before = api.callsFor('widget:table:rows').length;
    await user.click(await costHeader());
    await waitFor(() => { expect(api.callsFor('widget:table:rows').length).toBeGreaterThan(before); });
    expect('sort' in api.lastRowsCall()).toBe(false);
    expect((await costHeader()).textContent).not.toMatch(/[↑↓]/);
  });
});

describe('TableWidget — previous-period comparison', () => {
  it('adds a Δ% column after Cost comparing each row with the previous period', async () => {
    const { api } = renderTable({ compareEnabled: true });

    await screen.findByText('Δ%');
    expect(await headers()).toEqual(['Service', 'Cost', 'Δ%', 'List', 'Usage', 'Region']);

    expect(rowCells('Amazon EC2')[2]).toBe('↑20.0%');
    expect(screen.getByText('↑20.0%').className).toContain('text-negative');
    expect(rowCells('Amazon S3')[2]).toBe('↓25.0%');
    expect(screen.getByText('↓25.0%').className).toContain('text-positive');
    expect(rowCells('AWS Lambda')[2]).toBe('↑0.0%');
    expect(screen.getByText('↑0.0%').className).toContain('text-text-secondary');
    // No meaningful ratio against a zero or missing previous cost.
    expect(rowCells('Amazon RDS')[2]).toBe('');
    expect(rowCells('Amazon CloudFront')[2]).toBe('');

    const prev = api.callsFor('widget:table:rows/prev');
    expect(prev).toHaveLength(1);
    expect(prev[0]?.dateRange).toEqual(PREV_RANGE);
    expect(prev[0]?.groupByColumns).toEqual(['service', 'region']);
  });

  it('has no Δ% column, and no previous-period query, when compare is off', async () => {
    const { api } = renderTable();

    await screen.findByText('Amazon EC2');
    expect(screen.queryByText('Δ%')).toBeNull();
    expect(api.callsFor('widget:table:rows/prev')).toHaveLength(0);
  });

  it('has no Δ% column when the previous period returned no rows', async () => {
    const api = new TableApi();
    const pending = deferred<AggregatedTableResult>();
    api.previous = () => pending.promise;
    renderTable({ api, compareEnabled: true });

    await screen.findByText('Amazon EC2');
    await waitFor(() => { expect(api.callsFor('widget:table:rows/prev')).toHaveLength(1); });
    await act(async () => {
      pending.resolve({ rows: [], totalRows: 0, tagColumns: [] });
      await pending.promise;
    });
    expect(screen.queryByText('Δ%')).toBeNull();
  });
});

describe('TableWidget — column picker', () => {
  /** Toggle a column in the open picker by its header label. */
  async function toggleColumn(user: ReturnType<typeof userEvent.setup>, label: string): Promise<void> {
    const picker = screen.getByText('Drag to reorder').closest('.absolute');
    if (!(picker instanceof HTMLElement)) throw new Error('column picker is not open');
    const row = within(picker).getByText(label).closest('label');
    if (row === null) throw new Error(`no picker entry for ${label}`);
    await user.click(within(row).getByRole('checkbox'));
  }

  it('shows and hides columns, regrouping the query to match', async () => {
    const { api, user } = renderTable();
    await screen.findByText('Amazon EC2');

    await user.click(screen.getByTitle('Choose and reorder columns'));

    await toggleColumn(user, 'Account');
    await waitFor(() => { expect(api.lastRowsCall().groupByColumns).toEqual(['service', 'account_name', 'region']); });
    await waitFor(async () => { expect(await headers()).toContain('Account'); });

    await toggleColumn(user, 'Region');
    await waitFor(() => { expect(api.lastRowsCall().groupByColumns).toEqual(['service', 'account_name']); });

    // Tag columns come from the overview's tag list.
    await toggleColumn(user, 'Team');
    await waitFor(() => { expect(api.lastRowsCall().groupByColumns).toEqual(['service', 'account_name', 'tag_team']); });
    const shown = await headers();
    expect([...shown].sort()).toEqual(['Account', 'Cost', 'List', 'Service', 'Team', 'Usage']);
  });
});

describe('TableWidget — expanded row detail', () => {
  it('loads the clicked row’s line items, scoped to that row', async () => {
    const api = new TableApi();
    const detail = deferred<AggregatedTableResult>();
    api.detail = () => detail.promise;
    const { user } = renderTable({ api });

    await expandRow(user, 'Amazon EC2');

    // The row summary shows straight away; the line items load.
    expect(await screen.findByText('Line Items')).toBeDefined();
    expect(screen.getByText('500')).toBeDefined();
    expect(screen.getByRole('status')).toBeDefined();

    const call = api.calls.find(c => c.origin === 'widget:table:expand');
    expect(call?.rowFilters).toEqual({ service: 'Amazon EC2', region: 'eu-central-1' });
    expect(call?.rowLimit).toBe(100);
    expect(call?.groupByColumns).toEqual([
      'usage_date', 'service', 'account_name', 'charge_category', 'region',
      'service_category', 'sku_meter', 'operation', 'tag_team', 'resource_id', 'description',
    ]);

    detail.resolve({
      rows: [
        { values: { usage_date: '2026-03-02', service: 'Amazon EC2', resource_id: 'i-0abc', description: 'On Demand t3.medium', not_a_column: 'x' }, cost: 700, listCost: 800, usageAmount: 12, rowCount: 300 },
        { values: { service: 'Amazon EC2', resource_id: 'i-0def' }, cost: -20, listCost: 0, usageAmount: 0, rowCount: 1 },
        { values: { resource_id: 'i-0xyz' }, cost: 5, listCost: 5, usageAmount: 1, rowCount: 1 },
      ],
      totalRows: 3,
      tagColumns: [],
    });

    await waitFor(() => { expect(screen.getAllByRole('table')).toHaveLength(2); });
    const nested = screen.getAllByRole('table')[1];
    if (nested === undefined) throw new Error('detail table did not render');
    await waitFor(() => { expect(screen.queryByRole('status')).toBeNull(); });

    // Columns follow the detail rows' keys, with Cost second; unknown keys drop.
    const detailHeaders = within(nested).getAllByRole('columnheader').map(th => th.textContent);
    expect(detailHeaders).toEqual(['Date', 'Cost', 'Service', 'Resource', 'Description']);
    expect(within(nested).getByText('Cost').className).toContain('text-right');

    const resource = within(nested).getByText('i-0abc');
    expect(resource.getAttribute('title')).toBe('i-0abc');
    expect(resource.className).toContain('text-ellipsis');
    expect(within(nested).getByText('$700.00').className).toContain('text-right');
    // A line item without a date or description leaves those cells blank.
    const second = within(nested).getByText('i-0def').closest('tr');
    if (second === null) throw new Error('second detail row missing');
    expect(within(second).getAllByRole('cell').map(td => td.textContent)).toEqual(['', '-$20.00', 'Amazon EC2', 'i-0def', '']);
    const third = within(nested).getByText('i-0xyz').closest('tr');
    if (third === null) throw new Error('third detail row missing');
    expect(within(third).getAllByRole('cell').map(td => td.textContent)).toEqual(['', '$5.00', '', 'i-0xyz', '']);
  });

  it('summarises the row’s own values, labelling them by column', async () => {
    const { user } = renderTable();

    await expandRow(user, 'Amazon CloudFront');

    const summary = (await screen.findByText('Line Items')).closest('.grid');
    if (!(summary instanceof HTMLElement)) throw new Error('row summary missing');
    // The empty region is left out; cost and line-item count close the list.
    expect(within(summary).getByText('Service')).toBeDefined();
    expect(within(summary).getByTitle('Amazon CloudFront')).toBeDefined();
    expect(within(summary).queryByText('Region')).toBeNull();
    expect(within(summary).getByText('$40.00')).toBeDefined();
    expect(within(summary).getByText('3')).toBeDefined();
    expect(await screen.findByText('No detail rows available.')).toBeDefined();
  });

  it('labels a value by its raw key when the column is unknown', async () => {
    const api = new TableApi();
    // Without the overview, the widget knows no tag columns — yet a row can
    // still carry one.
    api.overview = () => Promise.reject(new Error('overview unavailable'));
    api.current = () => Promise.resolve({
      rows: [{ values: { service: 'Amazon EC2', tag_team: 'platform' }, cost: 10, listCost: 10, usageAmount: 1, rowCount: 4 }],
      totalRows: 1,
      tagColumns: [],
    });
    const { user } = renderTable({ api });

    await expandRow(user, 'Amazon EC2');

    const summary = (await screen.findByText('Line Items')).closest('.grid');
    if (!(summary instanceof HTMLElement)) throw new Error('row summary missing');
    expect(within(summary).getByText('tag_team')).toBeDefined();
    expect(within(summary).getByTitle('platform')).toBeDefined();
  });

  it('treats a failed line-item query as having no detail', async () => {
    const api = new TableApi();
    api.detail = () => Promise.reject(new Error('detail failed'));
    const { user } = renderTable({ api });

    await expandRow(user, 'Amazon S3');

    expect(await screen.findByText('No detail rows available.')).toBeDefined();
    expect(screen.queryByText('detail failed')).toBeNull();
  });
});
