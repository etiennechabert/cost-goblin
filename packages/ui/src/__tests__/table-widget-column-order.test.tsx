import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { asDateString } from '@costgoblin/core/browser';
import type {
  AggregatedTableParams,
  AggregatedTableResult,
  AggregatedTableRow,
  DateRange,
  ExplorerOverviewResult,
  WidgetSpec,
} from '@costgoblin/core/browser';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { TableWidget } from '../widgets/table-widget.js';

const RANGE: DateRange = { start: asDateString('2026-03-01'), end: asDateString('2026-03-31') };
const PREV_RANGE: DateRange = { start: asDateString('2026-01-29'), end: asDateString('2026-02-28') };

const OVERVIEW: ExplorerOverviewResult = {
  windowDays: 31,
  startDate: '2026-03-01',
  endDate: '2026-03-31',
  dailyTotals: [],
  totalRows: 510,
  totalCost: 1_500,
  tagColumns: [{ id: 'tag_team', label: 'Team' }],
};

const ROWS: readonly AggregatedTableRow[] = [
  { values: { service: 'Amazon EC2', region: 'eu-central-1', account_name: 'prod', tag_team: 'platform' }, cost: 1_200, listCost: 1_500, usageAmount: 24, rowCount: 500 },
  { values: { service: 'Amazon S3', region: 'us-east-1', account_name: 'dev', tag_team: 'data' }, cost: 300, listCost: 300, usageAmount: 1_000, rowCount: 10 },
];

/** Answers each rows query with the fixture grouped by exactly the columns
 *  asked for, like the real handler. */
class ColumnsApi extends MockCostApi {
  readonly rowsCalls: AggregatedTableParams[] = [];
  overview: () => Promise<ExplorerOverviewResult> = () => Promise.resolve(OVERVIEW);

  override queryExplorerOverview(): Promise<ExplorerOverviewResult> {
    return this.overview();
  }

  override queryAggregatedTable(params?: AggregatedTableParams): Promise<AggregatedTableResult> {
    if (params === undefined) return Promise.reject(new Error('queryAggregatedTable called without params'));
    this.rowsCalls.push(params);
    const rows = ROWS.map(r => ({ ...r, values: Object.fromEntries(params.groupByColumns.map(c => [c, r.values[c] ?? ''])) }));
    return Promise.resolve({ rows, totalRows: rows.length, tagColumns: [] });
  }
}

// Configured out of the usual column order: Service first, Region last.
const SPEC: WidgetSpec = {
  id: 'tbl',
  type: 'table',
  size: 'full',
  enabledColumns: ['service', 'cost', 'list_cost', 'usage_amount', 'region'],
};
const CONFIGURED = ['Service', 'Cost', 'List', 'Usage', 'Region'];
// The columns the view leaves out, in their usual order.
const OTHERS = ['Date', 'Account', 'Charge category', 'Service category', 'SKU meter', 'Operation', 'Team', 'Resource', 'Description'];

function renderTable(spec: WidgetSpec = SPEC, api: ColumnsApi = new ColumnsApi()) {
  const user = userEvent.setup();
  render(
    <CostApiProvider value={api}>
      <TableWidget
        spec={spec}
        dateRange={RANGE}
        previousDateRange={PREV_RANGE}
        compareEnabled={false}
        granularity="daily"
        globalFilters={{}}
        dimensions={[]}
        onSetFilter={() => undefined}
      />
    </CostApiProvider>,
  );
  return { api, user };
}

/** Hold the overview back, as while it loads, until the returned function
 *  releases it. */
function holdOverview(api: ColumnsApi): () => Promise<void> {
  let resolve: (value: ExplorerOverviewResult) => void = () => undefined;
  api.overview = () => new Promise((res) => { resolve = res; });
  return () => act(async () => { resolve(OVERVIEW); await Promise.resolve(); });
}

/** The table's column headers, left to right. */
function headers(): string[] {
  const table = screen.getAllByRole('table')[0];
  if (table === undefined) throw new Error('no table rendered');
  const head = table.querySelector('thead');
  if (head === null) throw new Error('table has no head');
  return within(head).getAllByRole('columnheader').map(th => th.textContent.replace(/[↑↓↕]/g, '').trim());
}

async function expectHeaders(expected: readonly string[]): Promise<void> {
  await waitFor(() => { expect(headers()).toEqual(expected); });
}

async function openPicker(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: /^Columns/ }));
}

function pickerPanel(): HTMLElement {
  const panel = screen.getByText('Drag to reorder').closest('.absolute');
  if (!(panel instanceof HTMLElement)) throw new Error('column picker is not open');
  return panel;
}

/** The picker's entry for a column, found by its label. */
function pickerEntry(label: string): HTMLElement {
  const entry = within(pickerPanel()).getByText(label, { selector: 'span' }).closest('label');
  if (entry === null) throw new Error(`no picker entry for ${label}`);
  return entry;
}

/** The picker's entries, top to bottom. */
function pickerLabels(): string[] {
  return [...pickerPanel().querySelectorAll('label span.truncate')].map(span => span.textContent);
}

async function toggle(user: ReturnType<typeof userEvent.setup>, label: string): Promise<void> {
  await user.click(within(pickerEntry(label)).getByRole('checkbox'));
}

/** Drag one picker entry onto another. */
function drag(label: string, onto: string): void {
  const transfer = { effectAllowed: 'none', dropEffect: 'none', setData: () => undefined };
  fireEvent.dragStart(pickerEntry(label), { dataTransfer: transfer });
  fireEvent.dragOver(pickerEntry(onto), { dataTransfer: transfer });
  fireEvent.drop(pickerEntry(onto), { dataTransfer: transfer });
}

describe('TableWidget — showing and hiding columns', () => {
  it('adds a shown column after the configured ones instead of re-sorting them', async () => {
    const { user } = renderTable();
    await expectHeaders(CONFIGURED);

    await openPicker(user);
    await toggle(user, 'Account');

    await expectHeaders([...CONFIGURED, 'Account']);
  });

  it('puts a column back where it was when it is shown again', async () => {
    const { user } = renderTable();
    await expectHeaders(CONFIGURED);
    await openPicker(user);

    await toggle(user, 'Cost');
    await expectHeaders(['Service', 'List', 'Usage', 'Region']);

    await toggle(user, 'Cost');
    await expectHeaders(CONFIGURED);
  });

  it('keeps the order through Show all and Hide all', async () => {
    const { user } = renderTable();
    await expectHeaders(CONFIGURED);
    await openPicker(user);

    await user.click(screen.getByRole('button', { name: 'Show all' }));
    await expectHeaders([...CONFIGURED, ...OTHERS]);

    await user.click(screen.getByRole('button', { name: 'Hide all' }));
    expect(await screen.findByText(/All columns are hidden/)).not.toBeNull();

    await toggle(user, 'Region');
    await toggle(user, 'Service');
    await expectHeaders(['Service', 'Region']);
  });

  it('keeps a configured column the table cannot list yet', async () => {
    // Tag columns come from the overview. Until it loads, the widget doesn't
    // know Team, and toggling another column mustn't drop it.
    const api = new ColumnsApi();
    const releaseOverview = holdOverview(api);
    const { user } = renderTable({ id: 'tbl', type: 'table', size: 'full', enabledColumns: ['service', 'cost', 'tag_team'] }, api);
    await waitFor(() => { expect(api.rowsCalls).toHaveLength(1); });

    await openPicker(user);
    await toggle(user, 'Cost');
    await releaseOverview();

    await expectHeaders(['Service', 'Team']);
    expect(api.rowsCalls.at(-1)?.groupByColumns).toEqual(['service', 'tag_team']);
  });
});

describe('TableWidget — column order', () => {
  it('lists the columns in the table’s order, the hidden ones after them', async () => {
    const { user } = renderTable();
    await expectHeaders(CONFIGURED);

    await openPicker(user);

    expect(pickerLabels()).toEqual([...CONFIGURED, ...OTHERS]);
  });

  it('reorders the table by dragging a column in the picker, without querying again', async () => {
    const { api, user } = renderTable();
    await expectHeaders(CONFIGURED);
    const queries = api.rowsCalls.length;
    await openPicker(user);

    drag('Region', 'Service');

    expect(headers()).toEqual(['Region', 'Service', 'Cost', 'List', 'Usage']);
    expect(pickerLabels().slice(0, 5)).toEqual(['Region', 'Service', 'Cost', 'List', 'Usage']);
    expect(api.rowsCalls).toHaveLength(queries);
  });

  it('shows a hidden column where it was dragged to', async () => {
    const { user } = renderTable();
    await expectHeaders(CONFIGURED);
    await openPicker(user);

    drag('Account', 'Cost');
    expect(headers()).toEqual(CONFIGURED);

    await toggle(user, 'Account');
    await expectHeaders(['Service', 'Account', 'Cost', 'List', 'Usage', 'Region']);
  });

  it('keeps a configured column it cannot list yet in place through a drag', async () => {
    // Team leads the view, but the widget only learns of it from the overview.
    const api = new ColumnsApi();
    const releaseOverview = holdOverview(api);
    const { user } = renderTable({ id: 'tbl', type: 'table', size: 'full', enabledColumns: ['tag_team', 'service', 'cost'] }, api);
    await waitFor(() => { expect(api.rowsCalls).toHaveLength(1); });

    await openPicker(user);
    drag('Cost', 'Service');
    await releaseOverview();

    await expectHeaders(['Team', 'Cost', 'Service']);
  });

  it('resets to the view’s configured order', async () => {
    const { user } = renderTable();
    await expectHeaders(CONFIGURED);
    await openPicker(user);
    drag('Region', 'Service');
    await toggle(user, 'Account');
    await expectHeaders(['Region', 'Service', 'Cost', 'List', 'Usage', 'Account']);

    await user.click(screen.getByRole('button', { name: 'Reset order' }));

    // The configured columns lead in their configured order; the one shown
    // since keeps its usual place after them.
    expect(headers()).toEqual([...CONFIGURED, 'Account']);
  });
});
