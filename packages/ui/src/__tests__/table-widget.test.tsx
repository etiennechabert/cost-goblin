import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import type { AggregatedTableParams, AggregatedTableResult, AggregatedTableRow, ExplorerSort, WidgetSpec } from '@costgoblin/core/browser';
import { asDateString } from '@costgoblin/core/browser';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { TableWidget } from '../widgets/table-widget.js';

const CURRENT = { start: asDateString('2026-02-01'), end: asDateString('2026-02-28') };
const PREVIOUS = { start: asDateString('2026-01-04'), end: asDateString('2026-01-31') };

const SPEC: WidgetSpec = { id: 'by-charge', type: 'table', size: 'full', enabledColumns: ['charge_category', 'cost'] };

function row(chargeCategory: string, cost: number): AggregatedTableRow {
  return { values: { charge_category: chargeCategory }, cost, listCost: cost, usageAmount: 0, rowCount: 1 };
}

// From a net-credit previous period, the credit grew (-$100 → -$150, a $50
// saving) and the adjustment shrank (-$100 → -$50, $50 more spend). Usage grew
// from a positive one; Purchase had $0 and Tax no row at all.
const CURRENT_ROWS = [
  row('Usage', 1_200), row('Purchase', 300), row('Tax', 250), row('Adjustment', -50), row('Credit', -150),
];
const PREVIOUS_ROWS = [row('Usage', 1_000), row('Purchase', 0), row('Adjustment', -100), row('Credit', -100)];

function compareRows(sort: ExplorerSort | undefined): (a: AggregatedTableRow, b: AggregatedTableRow) => number {
  const sign = sort?.direction === 'asc' ? 1 : -1;
  if (sort === undefined || sort.column === 'cost') return (a, b) => sign * (a.cost - b.cost);
  const column = sort.column;
  return (a, b) => sign * (a.values[column] ?? '').localeCompare(b.values[column] ?? '');
}

/** Answers like the desktop handler, over each period's own rows: in the
 *  asked order (else by cost, largest first), only the `rowKeys` groups when
 *  given, and at most `limit` rows. Records every request, holds the
 *  previous period's answers between `hold()` and `release()`, and fails
 *  them while `failPrevious` is set. */
class PeriodTableApi extends MockCostApi {
  readonly requests: AggregatedTableParams[] = [];
  failPrevious = false;
  private readonly current: readonly AggregatedTableRow[];
  private readonly previous: readonly AggregatedTableRow[];
  private readonly limit: number;
  private held: (() => void)[] | null = null;

  constructor(current: readonly AggregatedTableRow[], previous: readonly AggregatedTableRow[], limit = Number.POSITIVE_INFINITY) {
    super();
    this.current = current;
    this.previous = previous;
    this.limit = limit;
  }

  /** The base mock's method takes no parameters, so the override re-declares
   *  them as optional to stay override-compatible. */
  override queryAggregatedTable(params?: AggregatedTableParams): Promise<AggregatedTableResult> {
    if (params === undefined) return super.queryAggregatedTable();
    this.requests.push(params);
    const isPrevious = params.dateRange?.start === PREVIOUS.start;
    if (isPrevious && this.failPrevious) return Promise.reject(new Error('previous period failed'));
    const rows = isPrevious ? this.previous : this.current;
    const keys = params.rowKeys;
    const matched = keys === undefined
      ? rows
      : rows.filter(r => keys.some(k => Object.entries(r.values).every(([id, v]) => k[id] === v)));
    const ordered = [...matched].sort(compareRows(params.sort));
    const result: AggregatedTableResult = { rows: ordered.slice(0, this.limit), totalRows: matched.length, tagColumns: [] };
    const held = this.held;
    if (!isPrevious || held === null) return Promise.resolve(result);
    return new Promise(resolve => { held.push(() => { resolve(result); }); });
  }

  previousRequests(): AggregatedTableParams[] {
    return this.requests.filter(r => r.dateRange?.start === PREVIOUS.start);
  }

  hold(): void {
    this.held = [];
  }

  release(): void {
    const held = this.held ?? [];
    this.held = null;
    for (const answer of held) answer();
  }
}

function renderTable(api: MockCostApi) {
  return render(
    <CostApiProvider value={api}>
      <TableWidget
        spec={SPEC}
        dateRange={CURRENT}
        previousDateRange={PREVIOUS}
        compareEnabled
        granularity="daily"
        globalFilters={{}}
        dimensions={[]}
        onSetFilter={() => undefined}
      />
    </CostApiProvider>,
  );
}

/** The Δ% cell of the row naming `chargeCategory`. The column appears only
 *  once the previous period's rows load, so wait for both it and the row. */
async function deltaCell(chargeCategory: string): Promise<HTMLTableCellElement> {
  return waitFor(() => {
    const header = screen.getByText('Δ%').closest('th');
    const tr = screen.getByText(chargeCategory).closest('tr');
    const cell = header === null ? null : tr?.cells.item(header.cellIndex);
    if (cell === null || cell === undefined) throw new Error(`no Δ% cell for ${chargeCategory}`);
    return cell;
  });
}

/** The Δ% cell of the row naming `chargeCategory`, once it reads `text`. */
async function expectDelta(chargeCategory: string, text: string): Promise<HTMLTableCellElement> {
  return waitFor(async () => {
    const cell = await deltaCell(chargeCategory);
    expect(cell.textContent).toBe(text);
    return cell;
  });
}

/** The charge categories of the table's rows, top to bottom. */
function shownCategories(): string[] {
  return [...document.querySelectorAll('tbody tr')].map(tr => tr.querySelector('td')?.textContent ?? '');
}

function sortByChargeCategory(): void {
  const header = screen.getByText('Charge category').closest('button');
  if (header === null) throw new Error('no Charge category header');
  fireEvent.click(header);
}

describe('TableWidget Δ% column', () => {
  it('signs the change from a net-credit previous period like the dollar change', async () => {
    renderTable(new PeriodTableApi(CURRENT_ROWS, PREVIOUS_ROWS));

    const credit = await expectDelta('Credit', '↓50.0%');
    expect(credit.querySelector('.text-positive')).not.toBeNull();

    const adjustment = await expectDelta('Adjustment', '↑50.0%');
    expect(adjustment.querySelector('.text-negative')).not.toBeNull();
  });

  it('keeps the change from a positive period, and shows none without a previous cost', async () => {
    renderTable(new PeriodTableApi(CURRENT_ROWS, PREVIOUS_ROWS));

    const usage = await expectDelta('Usage', '↑20.0%');
    expect(usage.querySelector('.text-negative')).not.toBeNull();

    expect((await deltaCell('Purchase')).textContent).toBe('');
    expect((await deltaCell('Tax')).textContent).toBe('');
  });
});

describe('TableWidget previous-period rows', () => {
  // The previous period has more groups than fit the row limit (3 here). By
  // cost, the credits come last, so the top rows alone leave them out.
  const PREVIOUS_GROUPS = [row('Usage', 1_000), row('Purchase', 400), row('Tax', 200), row('Adjustment', -100), row('Credit', -100)];

  it('asks the previous period for the rows on screen, so a credit its top rows leave out keeps its Δ%', async () => {
    const api = new PeriodTableApi([row('Usage', 1_200), row('Adjustment', -50), row('Credit', -150)], PREVIOUS_GROUPS, 3);
    renderTable(api);

    await expectDelta('Credit', '↓50.0%');
    await expectDelta('Adjustment', '↑50.0%');
    await expectDelta('Usage', '↑20.0%');
    expect(api.previousRequests().map(r => r.rowKeys)).toEqual([
      [{ charge_category: 'Adjustment' }, { charge_category: 'Credit' }, { charge_category: 'Usage' }],
    ]);
  });

  it('asks again for the rows a re-sort brings on screen, keeping the costs it has meanwhile', async () => {
    const api = new PeriodTableApi(CURRENT_ROWS, PREVIOUS_GROUPS, 3);
    renderTable(api);
    await expectDelta('Purchase', '↓25.0%');

    api.hold();
    sortByChargeCategory();
    await waitFor(() => { expect(shownCategories()).toEqual(['Adjustment', 'Credit', 'Purchase']); });
    await waitFor(() => { expect(api.previousRequests()).toHaveLength(2); });
    expect((await deltaCell('Purchase')).textContent).toBe('↓25.0%');
    expect((await deltaCell('Credit')).textContent).toBe('');

    act(() => { api.release(); });
    await expectDelta('Credit', '↓50.0%');
    await expectDelta('Adjustment', '↑50.0%');
    expect(api.previousRequests().map(r => r.rowKeys)).toEqual([
      [{ charge_category: 'Purchase' }, { charge_category: 'Tax' }, { charge_category: 'Usage' }],
      [{ charge_category: 'Adjustment' }, { charge_category: 'Credit' }, { charge_category: 'Purchase' }],
    ]);
  });

  it('hides the column when the previous period fails for the rows a re-sort brings on screen', async () => {
    const api = new PeriodTableApi(CURRENT_ROWS, PREVIOUS_GROUPS, 3);
    renderTable(api);
    await expectDelta('Purchase', '↓25.0%');

    api.failPrevious = true;
    sortByChargeCategory();

    await waitFor(() => { expect(shownCategories()).toEqual(['Adjustment', 'Credit', 'Purchase']); });
    await waitFor(() => { expect(api.previousRequests()).toHaveLength(2); });
    await waitFor(() => { expect(screen.queryByText('Δ%')).toBeNull(); });
    expect(shownCategories()).toEqual(['Adjustment', 'Credit', 'Purchase']);
  });

  it('keeps the previous period when a re-sort shows the same rows', async () => {
    const api = new PeriodTableApi(CURRENT_ROWS, PREVIOUS_ROWS);
    renderTable(api);
    await expectDelta('Credit', '↓50.0%');

    sortByChargeCategory();

    await waitFor(() => { expect(shownCategories()).toEqual(['Adjustment', 'Credit', 'Purchase', 'Tax', 'Usage']); });
    // Let any previous-period refetch the new rows would trigger start.
    await act(() => new Promise(resolve => { setTimeout(resolve, 0); }));
    expect(api.previousRequests()).toHaveLength(1);
    await expectDelta('Credit', '↓50.0%');
  });

  it('keeps the previous period for a re-sort of groups that collation would tie', async () => {
    // localeCompare ignores a soft hyphen, so it ties these two names and
    // would leave their order in the request to the order they're shown in.
    const softHyphen = 'Cred\u00ADit';
    const api = new PeriodTableApi([row('Credit', -150), row(softHyphen, -20)], [row('Credit', -100), row(softHyphen, -10)]);
    renderTable(api);
    await expectDelta('Credit', '↓50.0%');

    sortByChargeCategory();

    await waitFor(() => { expect(api.requests.some(r => r.sort?.column === 'charge_category')).toBe(true); });
    await waitFor(() => { expect(shownCategories()).toHaveLength(2); });
    await act(() => new Promise(resolve => { setTimeout(resolve, 0); }));
    expect(api.previousRequests()).toHaveLength(1);
  });
});
