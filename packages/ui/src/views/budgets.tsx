import { useMemo, useState } from 'react';
import type { Budget, CostResult, DimensionId, Dollars } from '@costgoblin/core/browser';
import { asDimensionId, asDollars, computeBudgetProgress } from '@costgoblin/core/browser';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useLagDays } from '../hooks/use-lag-days.js';
import { useQuery } from '../hooks/use-query.js';
import { DateRangePicker, getDefaultDateRange } from '../components/date-range-picker.js';
import type { DateRange, Granularity } from '../components/date-range-picker.js';
import { DimensionSelector } from '../components/dimension-selector.js';
import { BudgetCard } from '../components/budget-card.js';
import { BudgetEditorModal } from '../components/budget-editor-modal.js';
import { Button } from '../components/ui/button.js';
import { formatDollars } from '../components/format.js';
import { getDimensionId } from '../lib/dimensions.js';

type EditorState =
  | { mode: 'closed' }
  | { mode: 'create' }
  | { mode: 'edit'; budget: Budget };

export function BudgetsView(): React.JSX.Element {
  const api = useCostApi();
  const lagDays = useLagDays();

  const [dateRange, setDateRange] = useState<DateRange>(() => getDefaultDateRange(lagDays));
  const [granularity, setGranularity] = useState<Granularity>('daily');
  const [selectedDimensionId, setSelectedDimensionId] = useState<DimensionId | null>(null);
  const [editor, setEditor] = useState<EditorState>({ mode: 'closed' });
  const [refreshTick, setRefreshTick] = useState(0);

  const dimensionsQuery = useQuery(() => api.getDimensions(), []);
  const dimensions = dimensionsQuery.status === 'success' ? dimensionsQuery.data : [];

  const firstDim = dimensions[0];
  const activeDimensionId: DimensionId | null =
    selectedDimensionId ?? (firstDim !== undefined ? getDimensionId(firstDim) : null);

  const budgetsQuery = useQuery(() => api.getBudgets(), [refreshTick]);
  const allBudgets = budgetsQuery.status === 'success' ? budgetsQuery.data : [];

  const costsQuery = useQuery(
    () => activeDimensionId === null
      ? Promise.resolve<CostResult | null>(null)
      : api.queryCosts({ groupBy: activeDimensionId, dateRange, filters: {} }),
    [activeDimensionId, dateRange.start, dateRange.end],
  );

  const costsByEntity = useMemo(() => {
    const map = new Map<string, number>();
    if (costsQuery.status !== 'success' || costsQuery.data === null) return map;
    for (const row of costsQuery.data.rows) {
      map.set(row.entity, row.totalCost);
    }
    return map;
  }, [costsQuery]);

  const filteredBudgets = useMemo(
    () => allBudgets.filter(b => b.dimension === activeDimensionId),
    [allBudgets, activeDimensionId],
  );

  const progressItems = useMemo(() => {
    const items = filteredBudgets.map(budget =>
      computeBudgetProgress(budget, asDollars(costsByEntity.get(budget.entity) ?? 0), dateRange),
    );
    items.sort((a, b) => b.percentUsed - a.percentUsed);
    return items;
  }, [filteredBudgets, costsByEntity, dateRange]);

  const summary = useMemo(() => {
    let annual = 0;
    let spent = 0;
    let prorated = 0;
    let overBudget = 0;
    for (const item of progressItems) {
      annual += item.budget.annualAmount;
      spent += item.actualCost;
      prorated += item.proratedBudget;
      if (item.isOverBudget) overBudget += 1;
    }
    return {
      annual: asDollars(annual),
      spent: asDollars(spent),
      prorated: asDollars(prorated),
      overallPercent: prorated > 0 ? (spent / prorated) * 100 : 0,
      overBudget,
    };
  }, [progressItems]);

  const budgetedEntities = useMemo(
    () => filteredBudgets.map(b => b.entity as unknown as string),
    [filteredBudgets],
  );

  function handleCloseEditor(): void {
    setEditor({ mode: 'closed' });
  }

  function handleSaved(): void {
    setEditor({ mode: 'closed' });
    setRefreshTick(t => t + 1);
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-semibold text-text-primary">Budgets</h2>
          <p className="text-sm text-text-secondary mt-0.5">Track spending against annual budgets</p>
        </div>
        <DateRangePicker
          value={dateRange}
          granularity={granularity}
          onChange={(range, g) => { setDateRange(range); setGranularity(g); }}
          lagDays={lagDays}
        />
      </div>

      <div className="flex items-center justify-between">
        {dimensions.length > 0 && (
          <DimensionSelector
            dimensions={dimensions}
            selected={activeDimensionId ?? ''}
            onSelect={(id) => { setSelectedDimensionId(asDimensionId(id)); }}
          />
        )}
        <Button
          size="sm"
          onClick={() => { setEditor({ mode: 'create' }); }}
          disabled={activeDimensionId === null}
        >
          Add Budget
        </Button>
      </div>

      {budgetsQuery.status === 'error' && (
        <ErrorBanner message={budgetsQuery.error.message} />
      )}
      {costsQuery.status === 'error' && (
        <ErrorBanner message={costsQuery.error.message} />
      )}

      {progressItems.length > 0 && (
        <SummaryGrid
          annual={summary.annual}
          spent={summary.spent}
          overallPercent={summary.overallPercent}
          overBudget={summary.overBudget}
        />
      )}

      {progressItems.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {progressItems.map(item => (
            <BudgetCard
              key={item.budget.id}
              progress={item}
              onClick={() => { setEditor({ mode: 'edit', budget: item.budget }); }}
            />
          ))}
        </div>
      )}

      {progressItems.length === 0 && budgetsQuery.status === 'success' && (
        <div className="rounded-xl border border-border bg-bg-secondary/50 p-12 text-center">
          <p className="text-sm text-text-muted mb-4">No budgets set for this dimension</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => { setEditor({ mode: 'create' }); }}
            disabled={activeDimensionId === null}
          >
            Add your first budget
          </Button>
        </div>
      )}

      {editor.mode === 'create' && activeDimensionId !== null && (
        <BudgetEditorModal
          mode="create"
          dimension={activeDimensionId}
          dateRange={dateRange}
          budgetedEntities={budgetedEntities}
          onClose={handleCloseEditor}
          onSaved={handleSaved}
        />
      )}
      {editor.mode === 'edit' && (
        <BudgetEditorModal
          mode="edit"
          budget={editor.budget}
          onClose={handleCloseEditor}
          onSaved={handleSaved}
          onDeleted={handleSaved}
        />
      )}
    </div>
  );
}

function SummaryGrid({ annual, spent, overallPercent, overBudget }: Readonly<{
  annual: Dollars;
  spent: Dollars;
  overallPercent: number;
  overBudget: number;
}>): React.JSX.Element {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      <StatTile label="Total annual budget" value={formatDollars(annual)} />
      <StatTile label="Total spent" value={formatDollars(spent)} />
      <StatTile
        label="Overall usage"
        value={`${overallPercent.toFixed(0)}%`}
        valueClass={overallPercent > 100 ? 'text-negative' : ''}
      />
      <StatTile
        label="Over budget"
        value={String(overBudget)}
        valueClass={overBudget > 0 ? 'text-negative' : 'text-positive'}
      />
    </div>
  );
}

function StatTile({ label, value, valueClass }: Readonly<{ label: string; value: string; valueClass?: string }>): React.JSX.Element {
  return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-3">
      <p className="text-xs text-text-muted">{label}</p>
      <p className={`text-lg font-semibold tabular-nums mt-1 ${valueClass ?? 'text-text-primary'}`}>{value}</p>
    </div>
  );
}

function ErrorBanner({ message }: Readonly<{ message: string }>): React.JSX.Element {
  return (
    <div className="rounded-lg border border-negative/50 bg-negative-muted px-4 py-3 text-sm text-negative">
      {message}
    </div>
  );
}
