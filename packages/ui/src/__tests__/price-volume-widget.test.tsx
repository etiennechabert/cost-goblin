import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import type { AggregatedTableParams, AggregatedTableResult, AggregatedTableRow, DateRange, ExplorerSort, WidgetSpec } from '@costgoblin/core/browser';
import { asDateString, asDimensionId } from '@costgoblin/core/browser';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { PaletteProvider } from '../hooks/use-palette.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { PriceVolumeWidget } from '../widgets/price-volume-widget.js';

const CURRENT = { start: asDateString('2026-02-01'), end: asDateString('2026-02-28') };
const PREVIOUS = { start: asDateString('2026-01-04'), end: asDateString('2026-01-31') };

const SPEC: WidgetSpec = { id: 'pv', type: 'priceVolume', size: 'large', groupBy: asDimensionId('service'), topN: 6 };

/** A service that used `usage` units at `rate` dollars each. */
function service(name: string, usage: number, rate: number): AggregatedTableRow {
  return { values: { service: name }, cost: usage * rate, listCost: usage * rate, usageAmount: usage, rowCount: 1 };
}

/** A team tag's group that used `usage` units at $10 each. */
function team(value: string, usage: number): AggregatedTableRow {
  return { values: { tag_team: value }, cost: usage * 10, listCost: usage * 10, usageAmount: usage, rowCount: 1 };
}

/** A credit: a negative cost with no usage. */
function credit(name: string, cost: number): AggregatedTableRow {
  return { values: { service: name }, cost, listCost: 0, usageAmount: 0, rowCount: 1 };
}

// With a row limit of 2, each period's top rows leave out a group the other
// period's hold: RDS ($180) from the previous period, Lambda ($190) from the
// current one. EC2 used more units (+$50 volume), RDS cost $1 more a unit on
// the same usage (+$20 rate), Lambda used fewer units (-$30 volume).
const CURRENT_ROWS = [service('EC2', 30, 10), service('RDS', 20, 10), service('Lambda', 19, 10)];
const PREVIOUS_ROWS = [service('EC2', 25, 10), service('Lambda', 22, 10), service('RDS', 20, 9)];

function compareRows(sort: ExplorerSort | undefined): (a: AggregatedTableRow, b: AggregatedTableRow) => number {
  const sign = sort?.direction === 'asc' ? 1 : -1;
  if (sort?.column === 'abs_cost') return (a, b) => sign * (Math.abs(a.cost) - Math.abs(b.cost));
  return (a, b) => sign * (a.cost - b.cost);
}

/** Answers like the desktop handler, over each period's own rows: largest
 *  first, by size for `abs_cost` and by cost otherwise; only the `rowKeys`
 *  groups when given; at most `limit` rows. Records every request, holds the
 *  keyed ones between `hold()` and `release()`, and fails them while
 *  `failKeyed` is set. */
class PeriodGroupsApi extends MockCostApi {
  readonly requests: AggregatedTableParams[] = [];
  failKeyed = false;
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
    const keys = params.rowKeys;
    if (keys !== undefined && this.failKeyed) return Promise.reject(new Error('keyed request failed'));
    const rows = params.dateRange?.start === PREVIOUS.start ? this.previous : this.current;
    const matched = keys === undefined
      ? rows
      : rows.filter(r => keys.some(k => Object.entries(r.values).every(([id, v]) => k[id] === v)));
    const ordered = [...matched].sort(compareRows(params.sort));
    const result: AggregatedTableResult = { rows: ordered.slice(0, Math.min(this.limit, params.rowLimit)), totalRows: matched.length, tagColumns: [] };
    const held = this.held;
    if (keys === undefined || held === null) return Promise.resolve(result);
    return new Promise(resolve => { held.push(() => { resolve(result); }); });
  }

  /** The groups each keyed request asked `period` for. */
  keyedRequests(period: DateRange): (readonly Readonly<Record<string, string>>[])[] {
    return this.requests.flatMap(r => (r.rowKeys !== undefined && r.dateRange?.start === period.start ? [r.rowKeys] : []));
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

function renderWidget(api: MockCostApi, spec: WidgetSpec = SPEC) {
  return render(
    <CostApiProvider value={api}>
      <PaletteProvider>
        <PriceVolumeWidget
          spec={spec}
          dateRange={CURRENT}
          previousDateRange={PREVIOUS}
          compareEnabled
          granularity="daily"
          globalFilters={{}}
          dimensions={[]}
          onSetFilter={() => undefined}
        />
      </PaletteProvider>
    </CostApiProvider>,
  );
}

/** The chart's tooltip for one bar, e.g. "RDS — Rate +$20.00". */
async function expectBar(text: string): Promise<void> {
  await waitFor(() => { expect(screen.getByText(text)).toBeDefined(); });
}

describe('PriceVolumeWidget pairing', () => {
  it('decomposes a group cut from one period’s top rows against its real cost there', async () => {
    const api = new PeriodGroupsApi(CURRENT_ROWS, PREVIOUS_ROWS, 2);
    renderWidget(api);

    // Not +$200 of new spend: RDS cost $180 the period before.
    await expectBar('RDS — Rate +$20.00');
    await expectBar('RDS — Volume +$0.00');
    // Not -$220 of spend gone: Lambda still cost $190.
    await expectBar('Lambda — Volume $-30.00');
    await expectBar('Lambda — Rate +$0.00');
    await expectBar('EC2 — Volume +$50.00');

    // Each period is asked only for the groups its own top rows left out.
    expect(api.keyedRequests(PREVIOUS)).toEqual([[{ service: 'RDS' }]]);
    expect(api.keyedRequests(CURRENT)).toEqual([[{ service: 'Lambda' }]]);
  });

  it('totals the exact changes, and says when the row limit leaves groups out', async () => {
    renderWidget(new PeriodGroupsApi(CURRENT_ROWS, PREVIOUS_ROWS, 2));

    await waitFor(() => {
      expect(screen.getByText('Net +$40.00 · Vol +$20.00 / Rate +$20.00 · top 500 per period')).toBeDefined();
    });
  });

  it('ranks each period’s groups by size, so a credit the top rows by cost leave out still competes', async () => {
    // By cost, each period's top 2 rows are EC2 and RDS, and the credit
    // (-$250 → -$100) never shows. By size, it ranks second in February.
    const api = new PeriodGroupsApi(
      [service('EC2', 30, 10), credit('Credits', -250), service('RDS', 20, 10)],
      [service('EC2', 25, 10), service('RDS', 20, 9), credit('Credits', -100)],
      2,
    );
    renderWidget(api);

    await expectBar('Credits — Volume $-150.00 (mixed)');
    await expectBar('RDS — Rate +$20.00');
    expect(api.requests.filter(r => r.rowKeys === undefined).map(r => r.sort)).toEqual([
      { column: 'abs_cost', direction: 'desc' },
      { column: 'abs_cost', direction: 'desc' },
    ]);
  });

  it('asks for no other groups when each period’s top rows hold all its groups', async () => {
    const api = new PeriodGroupsApi([service('EC2', 30, 10), service('RDS', 20, 10)], [service('EC2', 25, 10), service('Lambda', 22, 10)]);
    renderWidget(api);

    // RDS is new and Lambda gone: no previous or current row at all.
    await expectBar('RDS — Volume +$200.00 (mixed)');
    await expectBar('Lambda — Volume $-220.00 (mixed)');
    await waitFor(() => { expect(screen.getByText('Net +$30.00 · Vol +$30.00 / Rate +$0.00')).toBeDefined(); });
    expect(api.requests).toHaveLength(2);
    expect(api.requests.every(r => r.rowKeys === undefined)).toBe(true);
  });

  it('shows no decomposition until the groups a period left out load', async () => {
    const api = new PeriodGroupsApi(CURRENT_ROWS, PREVIOUS_ROWS, 2);
    api.hold();
    renderWidget(api);

    await waitFor(() => { expect(api.requests.filter(r => r.rowKeys !== undefined)).toHaveLength(2); });
    expect(screen.queryByText(/^RDS — /)).toBeNull();
    expect(screen.queryByText(/^Net /)).toBeNull();

    act(() => { api.release(); });
    await expectBar('RDS — Rate +$20.00');
  });

  it('adds up the groups that read as the same value', async () => {
    // An untagged NULL group and an empty-value group both read as ''. Both
    // are in the current top rows; the previous period is asked for '' and
    // answers with both.
    const api = new PeriodGroupsApi(
      [team('platform', 50), team('', 10), team('', 5)],
      [team('platform', 50), team('data', 40), team('ops', 30), team('', 8), team('', 4)],
      3,
    );
    renderWidget(api, { id: 'pv-team', type: 'priceVolume', size: 'large', groupBy: asDimensionId('tag_team') });

    // 15 units against 12, not each side's last row (5 against 4).
    await expectBar('— Volume +$30.00');
    expect(api.keyedRequests(PREVIOUS)).toEqual([[{ tag_team: '' }]]);
  });

  it('asks a capped period for \'\' again when its top rows hold only one of those groups', async () => {
    // February's top 3 rows hold the 10-unit '' group but cut the 5-unit one.
    const api = new PeriodGroupsApi(
      [team('platform', 50), team('', 10), team('data', 9), team('', 5)],
      [team('platform', 50), team('data', 40), team('ops', 30), team('', 12)],
      3,
    );
    renderWidget(api, { id: 'pv-team', type: 'priceVolume', size: 'large', groupBy: asDimensionId('tag_team') });

    // 15 units against 12, not the 10 the top rows hold.
    await expectBar('— Volume +$30.00');
    expect(api.keyedRequests(CURRENT)).toEqual([[{ tag_team: 'ops' }, { tag_team: '' }]]);
    expect(api.keyedRequests(PREVIOUS)).toEqual([[{ tag_team: '' }]]);
  });

  it('shows the error when asking for the groups a period left out fails', async () => {
    const api = new PeriodGroupsApi(CURRENT_ROWS, PREVIOUS_ROWS, 2);
    api.failKeyed = true;
    renderWidget(api);

    await waitFor(() => { expect(screen.getByText('Query failed: keyed request failed')).toBeDefined(); });
    expect(screen.queryByText(/^RDS — /)).toBeNull();
  });
});
