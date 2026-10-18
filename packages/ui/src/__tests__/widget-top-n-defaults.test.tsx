import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { asDateString, asDimensionId, asDollars, asEntityRef } from '@costgoblin/core/browser';
import type {
  AggregatedTableParams,
  AggregatedTableResult,
  BaselinesListParams,
  BaselinesListResult,
  CostQueryParams,
  CostResult,
  DailyCostsResult,
  DateRange,
  Dimension,
  TrendResult,
  WidgetSpec,
} from '@costgoblin/core/browser';
import { WidgetInspector } from '../components/widget-inspector.js';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { PaletteProvider } from '../hooks/use-palette.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { BaselineWidget } from '../widgets/baseline-widget.js';
import { HeatmapWidget } from '../widgets/heatmap-widget.js';
import { LineWidget } from '../widgets/line-widget.js';
import { PriceVolumeWidget } from '../widgets/price-volume-widget.js';
import { WIDGET_CATALOG } from '../widgets/registry.js';
import { TopNBarWidget } from '../widgets/top-n-bar-widget.js';
import { WaterfallWidget } from '../widgets/waterfall-widget.js';
import { DEFAULT_TOP_N } from '../widgets/widget.js';
import type { TopNWidgetType, WidgetComponent } from '../widgets/widget.js';

const SERVICE = asDimensionId('service');
const REGION = asDimensionId('region');
const DIMS: readonly Dimension[] = [
  { name: SERVICE, label: 'Service', field: 'service' },
  { name: REGION, label: 'Region', field: 'region' },
];
const RANGE: DateRange = { start: asDateString('2026-03-01'), end: asDateString('2026-03-31') };
const PREV_RANGE: DateRange = { start: asDateString('2026-01-29'), end: asDateString('2026-02-28') };

/** How many entries each ranked widget shows when its spec sets no Top N. */
const RANKED: readonly { readonly type: TopNWidgetType; readonly widget: WidgetSpec; readonly shown: number }[] = [
  { type: 'line', widget: { id: 'w', type: 'line', size: 'large', groupBy: SERVICE }, shown: 6 },
  { type: 'topNBar', widget: { id: 'w', type: 'topNBar', size: 'large', groupBy: SERVICE }, shown: 12 },
  { type: 'heatmap', widget: { id: 'w', type: 'heatmap', size: 'large', groupBy: SERVICE }, shown: 12 },
  { type: 'baseline', widget: { id: 'w', type: 'baseline', size: 'large' }, shown: 8 },
  { type: 'waterfall', widget: { id: 'w', type: 'waterfall', size: 'large', groupBy: SERVICE }, shown: 8 },
  { type: 'priceVolume', widget: { id: 'w', type: 'priceVolume', size: 'large', groupBy: SERVICE }, shown: 6 },
];

/** The inspector is controlled: feed each edit back in, as the views editor does. */
function Inspector({ initial, onChange }: Readonly<{ initial: WidgetSpec; onChange: (next: WidgetSpec) => void }>) {
  const [widget, setWidget] = useState(initial);
  return (
    <WidgetInspector
      widget={widget}
      dimensions={DIMS}
      onChange={(next) => { onChange(next); setWidget(next); }}
      onDelete={() => undefined}
    />
  );
}

function topNField(): HTMLInputElement {
  const input = screen.getByRole('spinbutton', { name: 'Top N' });
  if (!(input instanceof HTMLInputElement)) throw new Error('Top N is not an input');
  return input;
}

function catalogLabel(type: TopNWidgetType | 'pie'): string {
  const entry = WIDGET_CATALOG.find(c => c.type === type);
  if (entry === undefined) throw new Error(`no catalog entry for ${type}`);
  return entry.label;
}

describe('Top N defaults', () => {
  it('lists the ranked widgets and their defaults in one place', () => {
    expect(DEFAULT_TOP_N).toStrictEqual(Object.fromEntries(RANKED.map(r => [r.type, r.shown])));
  });

  it.each(RANKED)('the inspector shows the $type widget’s own default of $shown', ({ widget, shown }) => {
    render(<Inspector initial={widget} onChange={() => undefined} />);
    expect(topNField().value).toBe(String(shown));
  });

  it.each(RANKED)('switching a pie to $type starts at its default of $shown', async ({ type, shown }) => {
    const changes: WidgetSpec[] = [];
    const user = userEvent.setup();
    render(<Inspector initial={{ id: 'w', type: 'pie', size: 'medium', groupBy: SERVICE }} onChange={(next) => { changes.push(next); }} />);

    await user.selectOptions(screen.getByDisplayValue(catalogLabel('pie')), catalogLabel(type));

    const next = changes.at(-1);
    expect(next?.type).toBe(type);
    expect(next !== undefined && 'topN' in next ? next.topN : undefined).toBe(shown);
    expect(topNField().value).toBe(String(shown));
  });
});

describe('Top N defaults in the widgets', () => {
  it('a line widget plots its default number of series', async () => {
    render(
      <PaletteProvider>
        <CostApiProvider value={new MockCostApi()}>
          <LineWidget
            spec={{ id: 'w', type: 'line', size: 'large', groupBy: SERVICE }}
            dateRange={RANGE}
            previousDateRange={PREV_RANGE}
            compareEnabled={false}
            granularity="daily"
            globalFilters={{}}
            dimensions={DIMS}
            onSetFilter={() => undefined}
          />
        </CostApiProvider>
      </PaletteProvider>,
    );

    expect(await screen.findByText(`Top ${String(DEFAULT_TOP_N.line)} • Click to filter, dbl-click to hide`)).not.toBeNull();
  });

  it('a baseline widget lists its default number of baselines', async () => {
    const requests: BaselinesListParams[] = [];
    class BaselineApi extends MockCostApi {
      override listBaselines(params?: BaselinesListParams): Promise<BaselinesListResult> {
        if (params !== undefined) requests.push(params);
        return super.listBaselines();
      }
    }
    render(
      <CostApiProvider value={new BaselineApi()}>
        <BaselineWidget
          spec={{ id: 'w', type: 'baseline', size: 'large' }}
          dateRange={RANGE}
          previousDateRange={PREV_RANGE}
          compareEnabled={false}
          granularity="daily"
          globalFilters={{}}
          dimensions={DIMS}
          onSetFilter={() => undefined}
        />
      </CostApiProvider>,
    );

    await waitFor(() => { expect(requests.at(-1)?.limit).toBe(DEFAULT_TOP_N.baseline); });
  });
});

// More groups than any default shows, ranked g01 (largest) to g15.
const GROUPS = Array.from({ length: 15 }, (_, i) => `g${String(i + 1).padStart(2, '0')}`);
const sizeOf = (i: number) => (GROUPS.length - i) * 100;
const DAYS = Array.from({ length: 31 }, (_, i) => asDateString(`2026-03-${String(i + 1).padStart(2, '0')}`));

/** Every ranked query answers with the fifteen groups, the current period
 *  larger than the previous one by each group's size. */
class RankedApi extends MockCostApi {
  override queryCosts(params?: CostQueryParams): Promise<CostResult> {
    return Promise.resolve({
      rows: GROUPS.map((g, i) => ({ entity: asEntityRef(g), totalCost: asDollars(sizeOf(i)), serviceCosts: {} })),
      totalCost: asDollars(GROUPS.reduce((s, _, i) => s + sizeOf(i), 0)),
      topServices: [],
      dateRange: params?.dateRange ?? RANGE,
    });
  }

  override queryDailyCosts(): Promise<DailyCostsResult> {
    const breakdown = Object.fromEntries(GROUPS.map((g, i) => [g, asDollars(sizeOf(i))]));
    const dayTotal = GROUPS.reduce((s, _, i) => s + sizeOf(i), 0);
    return Promise.resolve({
      days: DAYS.map(date => ({ date, total: asDollars(dayTotal), breakdown })),
      groups: [...GROUPS],
      totalCost: asDollars(dayTotal * DAYS.length),
    });
  }

  override queryTrends(): Promise<TrendResult> {
    return Promise.resolve({
      increases: GROUPS.map((g, i) => ({
        entity: asEntityRef(g),
        currentCost: asDollars(1_000 + sizeOf(i)),
        previousCost: asDollars(1_000),
        delta: asDollars(sizeOf(i)),
        percentChange: sizeOf(i) / 10,
      })),
      savings: [],
      totalIncrease: asDollars(GROUPS.reduce((s, _, i) => s + sizeOf(i), 0)),
      totalSavings: asDollars(0),
    });
  }

  override queryAggregatedTable(params?: AggregatedTableParams): Promise<AggregatedTableResult> {
    const column = params?.groupByColumns[0];
    if (params === undefined || column === undefined) return Promise.reject(new Error('expected one group-by column'));
    const previous = params.dateRange?.start === PREV_RANGE.start;
    return Promise.resolve({
      rows: GROUPS.map((g, i) => {
        const cost = previous ? 1_000 : 1_000 + sizeOf(i);
        return { values: { [column]: g }, cost, listCost: cost, usageAmount: 100, rowCount: 1 };
      }),
      totalRows: GROUPS.length,
      tagColumns: [],
    });
  }
}

const DRAWN: readonly { readonly type: TopNWidgetType; readonly Widget: WidgetComponent; readonly spec: WidgetSpec }[] = [
  { type: 'topNBar', Widget: TopNBarWidget, spec: { id: 'w', type: 'topNBar', size: 'large', groupBy: REGION } },
  { type: 'heatmap', Widget: HeatmapWidget, spec: { id: 'w', type: 'heatmap', size: 'large', groupBy: REGION } },
  { type: 'waterfall', Widget: WaterfallWidget, spec: { id: 'w', type: 'waterfall', size: 'large', groupBy: REGION } },
  { type: 'priceVolume', Widget: PriceVolumeWidget, spec: { id: 'w', type: 'priceVolume', size: 'large', groupBy: REGION } },
];

describe('Top N defaults in the drawn widgets', () => {
  it.each(DRAWN)('a $type widget draws its default number of groups, the largest first', async ({ type, Widget, spec }) => {
    render(
      <PaletteProvider>
        <CostApiProvider value={new RankedApi()}>
          <Widget
            spec={spec}
            dateRange={RANGE}
            previousDateRange={PREV_RANGE}
            compareEnabled={false}
            granularity="daily"
            globalFilters={{}}
            dimensions={DIMS}
            onSetFilter={() => undefined}
          />
        </CostApiProvider>
      </PaletteProvider>,
    );

    await waitFor(() => {
      expect(GROUPS.filter(g => screen.queryAllByText(g).length > 0)).toEqual(GROUPS.slice(0, DEFAULT_TOP_N[type]));
    });
  });
});
