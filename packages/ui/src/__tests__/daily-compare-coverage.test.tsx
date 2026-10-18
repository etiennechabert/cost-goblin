import { describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { asDateString, asDimensionId, asDollars } from '@costgoblin/core/browser';
import type {
  DailyCostsParams,
  DailyCostsResult,
  DateRange,
  Dimension,
  DimensionId,
  Granularity,
  TagValue,
  WidgetSpec,
} from '@costgoblin/core/browser';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { PaletteProvider } from '../hooks/use-palette.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { LineWidget } from '../widgets/line-widget.js';

/** The previous-period overlay of the daily widgets is drawn only when the
 *  previous period's data is there: the main process reports how many of its
 *  days fall in synced months (`coveredDays`), and a day with no spend in a
 *  synced month counts, as a filter to a rarely used service leaves most
 *  days without rows. */

const ACCOUNT = asDimensionId('account');

// Ten days each. The previous period starts in February.
const RANGE: DateRange = { start: asDateString('2026-03-06'), end: asDateString('2026-03-15') };
const PREV_RANGE: DateRange = { start: asDateString('2026-02-24'), end: asDateString('2026-03-05') };

const DIMS: readonly Dimension[] = [{ name: ACCOUNT, label: 'Account', field: 'account_id' }];

type Breakdown = Readonly<Record<string, number>>;

function daily(entries: readonly (readonly [string, Breakdown])[], coveredDays: number): DailyCostsResult {
  const groups = new Set<string>();
  const days = entries.map(([date, breakdown]) => {
    const priced: Record<string, ReturnType<typeof asDollars>> = {};
    let total = 0;
    for (const [k, v] of Object.entries(breakdown)) {
      groups.add(k);
      priced[k] = asDollars(v);
      total += v;
    }
    return { date: asDateString(date), total: asDollars(total), breakdown: priced };
  });
  return { days, groups: [...groups], totalCost: asDollars(days.reduce((s, d) => s + d.total, 0)), coveredDays };
}

// Spend on three of the ten days.
const CURRENT = daily([
  ['2026-03-07', { prod: 10 }],
  ['2026-03-10', { prod: 20, staging: 5 }],
  ['2026-03-14', { prod: 30 }],
], 10);

/** Answers the current period with `current` and the previous one with
 *  `previous`, keeping each answer so a test can wait for them to settle. */
class DailyApi extends MockCostApi {
  readonly calls: DailyCostsParams[] = [];
  readonly answers: Promise<DailyCostsResult>[] = [];

  constructor(private readonly current: DailyCostsResult, private readonly previous: DailyCostsResult) {
    super();
  }

  override queryDailyCosts(params?: DailyCostsParams): Promise<DailyCostsResult> {
    if (params === undefined) return Promise.reject(new Error('queryDailyCosts called without params'));
    this.calls.push(params);
    const answer = Promise.resolve(params.dateRange.start === PREV_RANGE.start ? this.previous : this.current);
    this.answers.push(answer);
    return answer;
  }

  previousCalls(): DailyCostsParams[] {
    return this.calls.filter(c => c.dateRange.start === PREV_RANGE.start);
  }

  /** Wait for the previous period's query, then for every answer to commit. */
  async settled(): Promise<void> {
    await waitFor(() => { expect(this.previousCalls()).toHaveLength(1); });
    await act(async () => {
      await Promise.all(this.answers);
      await new Promise(resolve => { setTimeout(resolve, 0); });
    });
  }
}

const LINE: WidgetSpec = { id: 'ln', type: 'line', size: 'large', groupBy: ACCOUNT };

function renderLine(api: DailyApi, granularity: Granularity = 'daily') {
  const onSetFilter = vi.fn<(dim: DimensionId, value: TagValue) => void>();
  return render(
    <PaletteProvider>
      <CostApiProvider value={api}>
        <LineWidget
          spec={LINE}
          dateRange={RANGE}
          previousDateRange={PREV_RANGE}
          compareEnabled
          granularity={granularity}
          globalFilters={{}}
          dimensions={DIMS}
          onSetFilter={onSetFilter}
        />
      </CostApiProvider>
    </PaletteProvider>,
  );
}

function lines(container: HTMLElement): Element[] {
  return [...container.querySelectorAll('path.visx-linepath:not([stroke-dasharray])')];
}

function ghostLines(container: HTMLElement): Element[] {
  return [...container.querySelectorAll('path.visx-linepath[stroke-dasharray]')];
}

/** Hourly rows for every hour of the given days. */
function hourly(days: readonly string[], breakdown: Breakdown): (readonly [string, Breakdown])[] {
  return days.flatMap(day => Array.from({ length: 24 }, (_, h): readonly [string, Breakdown] =>
    [`${day} ${String(h).padStart(2, '0')}:00`, breakdown]));
}

describe('LineWidget — previous period coverage', () => {
  it('overlays a fully synced previous period with spend on only three of its days', async () => {
    const previous = daily([
      ['2026-02-25', { prod: 12 }],
      ['2026-02-28', { prod: 18, staging: 4 }],
      ['2026-03-04', { prod: 25 }],
    ], 10);
    const api = new DailyApi(CURRENT, previous);
    const { container } = renderLine(api);

    await waitFor(() => { expect(ghostLines(container)).toHaveLength(2); });
    expect(lines(container)).toHaveLength(2);
  });

  it('skips the overlay when only part of the previous period is synced', async () => {
    // February isn't synced: five of the ten days, every one of them with spend.
    const previous = daily([
      ['2026-03-01', { prod: 12 }],
      ['2026-03-02', { prod: 14 }],
      ['2026-03-03', { prod: 16 }],
      ['2026-03-04', { prod: 18 }],
      ['2026-03-05', { prod: 20 }],
    ], 5);
    const api = new DailyApi(CURRENT, previous);
    const { container } = renderLine(api);

    await api.settled();
    await waitFor(() => { expect(lines(container)).toHaveLength(2); });
    expect(ghostLines(container)).toHaveLength(0);
  });

  it('counts the days of an hourly previous period, not its hours', async () => {
    // The hourly tier holds March only: 120 hourly rows, five of ten days.
    const current = daily(hourly(['2026-03-07', '2026-03-10'], { prod: 1, staging: 1 }), 10);
    const previous = daily(hourly(['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05'], { prod: 1 }), 5);
    const api = new DailyApi(current, previous);
    const { container } = renderLine(api, 'hourly');

    await api.settled();
    await waitFor(() => { expect(lines(container)).toHaveLength(2); });
    expect(ghostLines(container)).toHaveLength(0);
  });
});
