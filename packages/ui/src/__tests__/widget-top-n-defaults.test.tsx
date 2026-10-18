import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { asDateString, asDimensionId } from '@costgoblin/core/browser';
import type { BaselinesListParams, BaselinesListResult, DateRange, Dimension, WidgetSpec } from '@costgoblin/core/browser';
import { WidgetInspector } from '../components/widget-inspector.js';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { PaletteProvider } from '../hooks/use-palette.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { BaselineWidget } from '../widgets/baseline-widget.js';
import { LineWidget } from '../widgets/line-widget.js';
import { WIDGET_CATALOG } from '../widgets/registry.js';
import { DEFAULT_TOP_N } from '../widgets/widget.js';
import type { TopNWidgetType } from '../widgets/widget.js';

const SERVICE = asDimensionId('service');
const DIMS: readonly Dimension[] = [{ name: SERVICE, label: 'Service', field: 'service' }];
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
