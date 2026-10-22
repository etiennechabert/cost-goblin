import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { asDateString, asDollars } from '@costgoblin/core/browser';
import type { CostQueryParams, CostResult, DateRange, Granularity, WidgetSpec } from '@costgoblin/core/browser';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { SummaryWidget } from '../widgets/summary-widget.js';

afterEach(cleanup);

const SPEC: WidgetSpec = { id: 'sm', type: 'summary', size: 'small' };

function result(total: number, range: DateRange): CostResult {
  return { rows: [], totalCost: asDollars(total), topServices: [], dateRange: range };
}

const range = (start: string, end: string): DateRange => ({ start: asDateString(start), end: asDateString(end) });

/** Answers each query with the range the (real) handler would have read. */
class ReadRangeApi extends MockCostApi {
  constructor(private readonly answers: { current: CostResult; previous: CostResult }) { super(); }
  override queryCosts(params?: CostQueryParams): Promise<CostResult> {
    return Promise.resolve(params?.origin?.endsWith('/prev') === true ? this.answers.previous : this.answers.current);
  }
}

function renderSummary(api: MockCostApi, granularity: Granularity, dateRange: DateRange, previousDateRange: DateRange) {
  return render(
    <CostApiProvider value={api}>
      <SummaryWidget
        spec={SPEC}
        dateRange={dateRange}
        previousDateRange={previousDateRange}
        compareEnabled
        granularity={granularity}
        globalFilters={{}}
        dimensions={[]}
        onSetFilter={vi.fn()}
      />
    </CostApiProvider>,
  );
}

/** The "Daily Average" panel's value line. */
function dailyAverage(): string {
  return screen.getByText('Daily Average').nextElementSibling?.textContent ?? '';
}

describe('SummaryWidget daily average', () => {
  // On 2026-10-21 with a 2-day lag the newest day is 2026-10-19.
  const selection = range('2026-08-01', '2026-10-31'); // 92 days
  const previous = range('2026-05-01', '2026-07-31'); // 92 days

  it('Monthly: divides by the days the handler read (80), not the 92 selected', async () => {
    const api = new ReadRangeApi({
      current: result(8_000, range('2026-08-01', '2026-10-19')),
      previous: result(9_200, previous),
    });
    renderSummary(api, 'monthly', selection, previous);

    await waitFor(() => { expect(screen.getByText('Total Cost').nextElementSibling?.textContent).toBe('$8.0k'); });
    // 8000 / 80 = $100.00 (8000 / 92 would be $86.96), against 9200 / 92 = $100.00 before: no fake drop.
    // The previous period's query resolves on its own, so wait for its delta too.
    await waitFor(() => { expect(dailyAverage()).toBe('$100.00(+$0.00)'); });
    expect(screen.getByText('Previous: $100.00/day')).toBeDefined();
  });

  it('Daily: still divides by the selection, whatever the handler read', async () => {
    const api = new ReadRangeApi({
      current: result(8_000, range('2026-08-01', '2026-10-19')),
      previous: result(9_200, previous),
    });
    renderSummary(api, 'daily', selection, previous);

    await waitFor(() => { expect(screen.getByText('Total Cost').nextElementSibling?.textContent).toBe('$8.0k'); });
    expect(dailyAverage().startsWith('$86.96')).toBe(true);
  });
});
