import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import type { AggregatedTableParams, AggregatedTableResult, AggregatedTableRow, WidgetSpec } from '@costgoblin/core/browser';
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

/** Serves each period its own rows. The base mock's method takes no
 *  parameters, so the override re-declares them as optional to stay
 *  override-compatible. */
class ChargeCategoryTableApi extends MockCostApi {
  override queryAggregatedTable(params?: AggregatedTableParams): Promise<AggregatedTableResult> {
    const rows = params?.dateRange?.start === PREVIOUS.start ? PREVIOUS_ROWS : CURRENT_ROWS;
    return Promise.resolve({ rows, totalRows: rows.length, tagColumns: [] });
  }
}

function renderTable() {
  return render(
    <CostApiProvider value={new ChargeCategoryTableApi()}>
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

describe('TableWidget Δ% column', () => {
  it('signs the change from a net-credit previous period like the dollar change', async () => {
    renderTable();

    const credit = await deltaCell('Credit');
    expect(credit.textContent).toBe('↓50.0%');
    expect(credit.querySelector('.text-positive')).not.toBeNull();

    const adjustment = await deltaCell('Adjustment');
    expect(adjustment.textContent).toBe('↑50.0%');
    expect(adjustment.querySelector('.text-negative')).not.toBeNull();
  });

  it('keeps the change from a positive period, and shows none without a previous cost', async () => {
    renderTable();

    const usage = await deltaCell('Usage');
    expect(usage.textContent).toBe('↑20.0%');
    expect(usage.querySelector('.text-negative')).not.toBeNull();

    expect((await deltaCell('Purchase')).textContent).toBe('');
    expect((await deltaCell('Tax')).textContent).toBe('');
  });
});
