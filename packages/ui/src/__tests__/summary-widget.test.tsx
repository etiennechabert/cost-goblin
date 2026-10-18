import { act, render, screen, waitFor, within } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import type { CostQueryParams, CostResult, DateRange, Dimension, DimensionId, SummaryMetric, WidgetSpec } from '@costgoblin/core/browser';
import { asDateString, asDimensionId, asDollars, asEntityRef } from '@costgoblin/core/browser';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { daysBetween } from '../lib/dates.js';
import { SummaryWidget } from '../widgets/summary-widget.js';

const CURRENT: DateRange = { start: asDateString('2026-02-01'), end: asDateString('2026-02-28') };
const PREVIOUS: DateRange = { start: asDateString('2026-01-04'), end: asDateString('2026-01-31') };

const DIMENSIONS: readonly Dimension[] = [
  { name: asDimensionId('account'), label: 'Account', field: 'account' },
  { name: asDimensionId('service'), label: 'Service', field: 'service' },
  { name: asDimensionId('region'), label: 'Region', field: 'region' },
];

type Rows = readonly (readonly [string, number])[];

// $900 this period whatever the grouping. The service rows are deliberately
// not in cost order: the top entity is the costliest, not the first row.
const CURRENT_ROWS: Readonly<Record<string, Rows>> = {
  account: [['prod', 500], ['staging', 400]],
  service: [['Amazon S3', 270], ['Amazon EC2', 540], ['AWS Lambda', 90]],
  region: [['eu-west-1', 810], ['us-east-1', 90]],
};

/** A result as `query:costs` returns it: the asked range echoed, with the
 *  days of it that synced data covers. */
function costResult(rows: Rows, dateRange: DateRange, coveredDays = daysBetween(dateRange.start, dateRange.end)): CostResult {
  return {
    rows: rows.map(([entity, cost]) => ({ entity: asEntityRef(entity), totalCost: asDollars(cost), serviceCosts: {} })),
    totalCost: asDollars(rows.reduce((s, [, cost]) => s + cost, 0)),
    topServices: [],
    dateRange,
    coveredDays,
  };
}

interface SummaryApiOptions {
  /** Current-period rows for every grouping, replacing CURRENT_ROWS. */
  readonly current?: Rows;
  /** Previous-period rows; $720 split over two accounts by default. */
  readonly previous?: Rows;
  /** Days of the previous period that synced data covers; all 28 by default. */
  readonly previousCoveredDays?: number;
  /** Fails every query, or only the previous period's. */
  readonly fail?: Error;
  readonly failPrevious?: Error;
}

/** Serves each period and grouping its own rows, and records every query.
 *  The base mock's method takes no parameters, so the override re-declares
 *  them as optional to stay override-compatible. */
class SummaryApi extends MockCostApi {
  readonly calls: CostQueryParams[] = [];
  /** The latest previous-period answer, for a test to wait on. */
  previousAnswer: Promise<CostResult> | null = null;

  constructor(private readonly options: SummaryApiOptions = {}) {
    super();
  }

  override queryCosts(params?: CostQueryParams): Promise<CostResult> {
    if (params === undefined) throw new Error('queryCosts called without params');
    this.calls.push(params);
    if (this.options.fail !== undefined) return Promise.reject(this.options.fail);
    if (params.dateRange.start === PREVIOUS.start) {
      if (this.options.failPrevious !== undefined) return Promise.reject(this.options.failPrevious);
      const rows = this.options.previous ?? [['prod', 400], ['staging', 320]];
      this.previousAnswer = Promise.resolve(costResult(rows, PREVIOUS, this.options.previousCoveredDays));
      return this.previousAnswer;
    }
    return Promise.resolve(costResult(this.options.current ?? CURRENT_ROWS[params.groupBy] ?? [], CURRENT));
  }

  groupBys(): readonly DimensionId[] {
    return this.calls.map(c => c.groupBy);
  }

  queriedPrevious(): boolean {
    return this.calls.some(c => c.dateRange.start === PREVIOUS.start);
  }
}

function summary(fields: Partial<Extract<WidgetSpec, { type: 'summary' }>> = {}): WidgetSpec {
  return { id: 's', type: 'summary', size: 'small', ...fields };
}

function renderSummary(spec: WidgetSpec, api: SummaryApi, compareEnabled = false) {
  return render(
    <CostApiProvider value={api}>
      <SummaryWidget
        spec={spec}
        dateRange={CURRENT}
        previousDateRange={PREVIOUS}
        compareEnabled={compareEnabled}
        granularity="daily"
        globalFilters={{}}
        dimensions={DIMENSIONS}
        onSetFilter={() => undefined}
      />
    </CostApiProvider>,
  );
}

describe('SummaryWidget', () => {
  describe("metric 'total'", () => {
    it('shows the total and daily average, without querying the previous period while compare is off', async () => {
      const api = new SummaryApi();
      renderSummary(summary({ metric: 'total' }), api);

      expect(await screen.findByText('$900.00')).not.toBeNull();
      expect(screen.getByText('Total Cost')).not.toBeNull();
      expect(screen.getByText('Daily Average')).not.toBeNull();
      expect(screen.queryByText(/%/)).toBeNull();
      expect(api.queriedPrevious()).toBe(false);
    });

    it('is the default when no metric is set, and compares when compare is on', async () => {
      const api = new SummaryApi();
      renderSummary(summary(), api, true);

      // The card shows "vs Previous Period —" as soon as the current period
      // lands; the percent follows with the previous period's own query.
      expect(await screen.findByText('▲25.0%')).not.toBeNull();
      expect(screen.getByText('vs Previous Period')).not.toBeNull();
      expect(screen.getByText('Total Cost')).not.toBeNull();
    });

    it('compares with nothing when the previous period has too little data', async () => {
      // 7 of 28 days synced: $900 vs $100 would read as ▲800%.
      const api = new SummaryApi({ previous: [['prod', 100]], previousCoveredDays: 7 });
      renderSummary(summary({ metric: 'total' }), api, true);

      expect(await screen.findByText('$900.00')).not.toBeNull();
      await waitFor(() => { expect(api.previousAnswer).not.toBeNull(); });
      // Let the previous period's result commit before asserting it shows nothing.
      await act(async () => { await api.previousAnswer; });
      expect(screen.getByText('vs Previous Period')).not.toBeNull();
      expect(screen.queryByText(/%/)).toBeNull();
      expect(screen.queryByText('Previous: $100.00')).toBeNull();
    });
  });

  describe("metric 'delta'", () => {
    it('shows the change vs the previous period even while compare is off', async () => {
      const api = new SummaryApi();
      renderSummary(summary({ metric: 'delta' }), api);

      expect(await screen.findByText('+$180.00')).not.toBeNull();
      expect(screen.getByText('Change vs previous period')).not.toBeNull();
      expect(screen.getByText('+25.0%')).not.toBeNull();
      expect(screen.getByText('Previous: $720.00')).not.toBeNull();
      expect(screen.getByText('This period: $900.00')).not.toBeNull();
      expect(screen.queryByText('Total Cost')).toBeNull();
      expect(api.queriedPrevious()).toBe(true);
      expect(screen.getByText('+$180.00').classList.contains('text-negative')).toBe(true);
    });

    it('signs the percent like the dollar change from a net-credit previous period', async () => {
      // A -$100 credit grew to -$150: a $50 saving, so -50% and colored positive.
      const api = new SummaryApi({ current: [['prod', -150]], previous: [['prod', -100]] });
      renderSummary(summary({ metric: 'delta' }), api);

      const change = await screen.findByText('$-50.00');
      expect(change.classList.contains('text-positive')).toBe(true);
      expect(screen.getByText('-50.0%')).not.toBeNull();
    });

    it('shows no change when the previous period has too little data', async () => {
      // Only 7 of the period's 28 days are synced, so its $100 is no total
      // to compare against: +$800 (+800%) would be a data gap, not spend.
      const api = new SummaryApi({ previous: [['prod', 100]], previousCoveredDays: 7 });
      renderSummary(summary({ metric: 'delta' }), api);

      expect(await screen.findByText('Not enough data for the previous period')).not.toBeNull();
      expect(screen.getByText('—')).not.toBeNull();
      expect(screen.queryByText(/%$/)).toBeNull();
      expect(screen.queryByText('Previous: $100.00')).toBeNull();
    });

    it('shows no change when the previous period was never synced', async () => {
      // Before the first synced month: no rows and $0, over the asked range.
      // The whole $900 is not new spend.
      const api = new SummaryApi({ previous: [], previousCoveredDays: 0 });
      renderSummary(summary({ metric: 'delta' }), api);

      expect(await screen.findByText('Not enough data for the previous period')).not.toBeNull();
      expect(screen.queryByText('+$900.00')).toBeNull();
      expect(screen.queryByText('No spend in the previous period')).toBeNull();
    });

    it('compares against a previous period with enough synced days', async () => {
      // 23 of 28 days clears the 80% bar (22.4).
      const api = new SummaryApi({ previousCoveredDays: 23 });
      renderSummary(summary({ metric: 'delta' }), api);

      expect(await screen.findByText('+$180.00')).not.toBeNull();
      expect(screen.queryByText('Not enough data for the previous period')).toBeNull();
    });

    it('takes no ratio against a previous total that is only float residue', async () => {
      // Charges and credits netting out leave 1e-13, not $0.
      const api = new SummaryApi({ previous: [['prod', 0.1 + 0.2 - 0.3]] });
      renderSummary(summary({ metric: 'delta' }), api);

      expect(await screen.findByText('+$900.00')).not.toBeNull();
      expect(screen.getByText('No spend in the previous period')).not.toBeNull();
      expect(screen.queryByText(/%$/)).toBeNull();
    });

    it('prints no residue change as a negative zero or colors it', async () => {
      const api = new SummaryApi({ current: [['prod', 0.3]], previous: [['prod', 0.1 + 0.2]] });
      renderSummary(summary({ metric: 'delta' }), api);

      const change = await screen.findByText('+$0.00');
      expect(change.classList.contains('text-text-primary')).toBe(true);
    });

    it('shows a failed previous-period query instead of a comparison', async () => {
      const api = new SummaryApi({ failPrevious: new Error('previous gone') });
      renderSummary(summary({ metric: 'delta' }), api);

      expect(await screen.findByText('Query failed: previous gone')).not.toBeNull();
      expect(screen.queryByText('Not enough data for the previous period')).toBeNull();
    });

    it('shows the dollar change but no percent when the previous period had no spend', async () => {
      // Every day synced, nothing spent: zero spend, not missing data.
      const api = new SummaryApi({ previous: [] });
      renderSummary(summary({ metric: 'delta' }), api);

      expect(await screen.findByText('+$900.00')).not.toBeNull();
      expect(screen.getByText('No spend in the previous period')).not.toBeNull();
      expect(screen.queryByText(/%$/)).toBeNull();
    });
  });

  describe("metric 'topEntity'", () => {
    it('shows the costliest service and its share by default', async () => {
      const api = new SummaryApi();
      renderSummary(summary({ metric: 'topEntity' }), api);

      expect(await screen.findByText('Amazon EC2')).not.toBeNull();
      expect(screen.getByText('Top Service')).not.toBeNull();
      expect(screen.getByText('$540.00')).not.toBeNull();
      expect(screen.getByText('60.0% of $900.00')).not.toBeNull();
      expect(api.groupBys()).toEqual(['service']);
      expect(api.queriedPrevious()).toBe(false);
    });

    it('ranks the configured groupBy', async () => {
      const api = new SummaryApi();
      renderSummary(summary({ metric: 'topEntity', groupBy: asDimensionId('region') }), api);

      expect(await screen.findByText('eu-west-1')).not.toBeNull();
      expect(screen.getByText('Top Region')).not.toBeNull();
      expect(screen.getByText('90.0% of $900.00')).not.toBeNull();
      expect(api.groupBys()).toEqual(['region']);
    });

    it('names the bucket of rows with no value for the dimension', async () => {
      const api = new SummaryApi({ current: [['', 700], ['platform', 200]] });
      renderSummary(summary({ metric: 'topEntity', groupBy: asDimensionId('tag_team') }), api);

      expect(await screen.findByText('(none)')).not.toBeNull();
      expect(screen.getByText('$700.00')).not.toBeNull();
    });

    it('says so when nothing was spent', async () => {
      const api = new SummaryApi();
      renderSummary(summary({ metric: 'topEntity', groupBy: asDimensionId('nothing') }), api);

      expect(await screen.findByText('No spend in range')).not.toBeNull();
      expect(screen.getByText('—')).not.toBeNull();
      // An unknown dimension id is shown as-is rather than hidden.
      expect(screen.getByText('Top nothing')).not.toBeNull();
    });
  });

  describe("metric 'entityCount'", () => {
    it('counts the distinct services by default', async () => {
      const api = new SummaryApi();
      renderSummary(summary({ metric: 'entityCount' }), api);

      expect(await screen.findByText('3')).not.toBeNull();
      expect(screen.getByText('Service count')).not.toBeNull();
      expect(api.groupBys()).toEqual(['service']);
    });

    it('does not count rows with no value for the dimension', async () => {
      const api = new SummaryApi({ current: [['', 700], ['platform', 200], ['data', 100]] });
      renderSummary(summary({ metric: 'entityCount', groupBy: asDimensionId('tag_team') }), api);

      expect(await screen.findByText('2')).not.toBeNull();
    });

    it('counts the configured groupBy', async () => {
      const api = new SummaryApi();
      renderSummary(summary({ metric: 'entityCount', groupBy: asDimensionId('region') }), api);

      expect(await screen.findByText('2')).not.toBeNull();
      expect(screen.getByText('Region count')).not.toBeNull();
      expect(api.groupBys()).toEqual(['region']);
    });
  });

  it('labels the card with the widget title when one is set', async () => {
    renderSummary(summary({ metric: 'entityCount', title: 'Services in use' }), new SummaryApi());

    expect(await screen.findByText('Services in use')).not.toBeNull();
    expect(screen.queryByText('Service count')).toBeNull();
  });

  it('shows a failed query instead of an empty card', async () => {
    const api = new SummaryApi({ fail: new Error('disk on fire') });
    renderSummary(summary({ metric: 'topEntity' }), api);

    expect(await screen.findByText('Query failed: disk on fire')).not.toBeNull();
  });

  it('renders each metric as a different card', async () => {
    // Each metric with the text that shows once its card has loaded.
    const loaded: readonly (readonly [SummaryMetric, string])[] = [
      ['total', 'Total Cost'],
      ['delta', '+$180.00'],
      ['topEntity', 'Amazon EC2'],
      ['entityCount', 'Service count'],
    ];
    const texts: string[] = [];
    for (const [metric, text] of loaded) {
      const { container, unmount } = renderSummary(summary({ metric }), new SummaryApi());
      await within(container).findByText(text);
      expect(container.querySelector('output')).toBeNull();
      texts.push(container.textContent);
      unmount();
    }
    expect(new Set(texts).size).toBe(loaded.length);
  });
});
