import { useState } from 'react';
import type {
  Dimension,
  FilterMap,
  CostResult,
  EntityRef,
  DimensionId,
  OrgNode,
} from '@costgoblin/core/browser';
import { asDimensionId, asTagValue, findNode, getDescendantTagValues } from '@costgoblin/core/browser';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { getDimensionId, isOwnerDimension, isProductDimension } from '../lib/dimensions.js';
import { ConceptPlaceholder } from '../components/concept-placeholder.js';
import { SummaryCard } from '../components/summary-card.js';
import { DimensionSelector } from '../components/dimension-selector.js';
import { FilterBar } from '../components/filter-bar.js';
import { CostTable } from '../components/cost-table.js';
import { EntityPopup } from '../components/entity-popup.js';
import { CsvExport } from '../components/csv-export.js';
import { DateRangePicker, getDefaultDateRange } from '../components/date-range-picker.js';
import type { DateRange } from '../components/date-range-picker.js';


interface PopupTarget {
  entity: string;
  dimension: string;
}

interface OverviewState {
  selectedDimensionId: DimensionId | null;
  filters: FilterMap;
  dateRange: DateRange;
  popup: PopupTarget | null;
  orgPath: string[];
}

interface CostOverviewProps {
  onEntityClick?: (entity: string, dimension: string) => void;
}

export function CostOverview({ onEntityClick: onEntityClickProp }: CostOverviewProps = {}) {
  const api = useCostApi();

  const dimensionsQuery = useQuery(() => api.getDimensions(), []);

  const [state, setState] = useState<OverviewState>({
    selectedDimensionId: null,
    filters: {},
    dateRange: getDefaultDateRange(),
    popup: null,
    orgPath: [],
  });

  const orgTreeQuery = useQuery(() => api.getOrgTree(), []);
  const orgTree: readonly OrgNode[] = orgTreeQuery.status === 'success' ? orgTreeQuery.data : [];

  const dimensions: Dimension[] =
    dimensionsQuery.status === 'success' ? dimensionsQuery.data : [];

  const firstDimId = dimensions.length > 0 && dimensions[0] !== undefined
    ? getDimensionId(dimensions[0])
    : null;

  const activeDimensionId: DimensionId | null = state.selectedDimensionId ?? firstDimId;

  const filtersKey = JSON.stringify(state.filters);
  const dateRangeKey = `${state.dateRange.start}_${state.dateRange.end}`;
  const orgPathKey = state.orgPath.join('/');

  function getOrgNodeValuesForPath(path: string[], tree: readonly OrgNode[]): string[] | undefined {
    if (path.length === 0) return undefined;
    const lastNodeName = path[path.length - 1];
    if (lastNodeName === undefined) return undefined;
    const node = findNode(tree, lastNodeName);
    if (node === undefined || node.children === undefined) return undefined;
    return node.children.flatMap(child =>
      child.virtual === true || (child.children !== undefined && child.children.length > 0)
        ? getDescendantTagValues(child)
        : [child.name],
    );
  }

  const orgNodeValues = getOrgNodeValuesForPath(state.orgPath, orgTree);

  const costsQuery = useQuery(
    () => {
      if (activeDimensionId === null) return Promise.resolve(null);
      return api.queryCosts({
        groupBy: activeDimensionId,
        dateRange: state.dateRange,
        filters: state.filters,
        ...(orgNodeValues !== undefined ? { orgNodeValues } : {}),
      });
    },
    [activeDimensionId, filtersKey, dateRangeKey, orgPathKey, api],
  );

  function handleDimensionSelect(id: string) {
    setState((prev) => ({ ...prev, selectedDimensionId: asDimensionId(id), orgPath: [] }));
  }

  function handleBreadcrumbClick(index: number) {
    setState(prev => ({ ...prev, orgPath: prev.orgPath.slice(0, index) }));
  }

  function handleFilterChange(filters: FilterMap) {
    setState((prev) => ({ ...prev, filters }));
  }

  function handleGetFilterValues(dimensionId: DimensionId, currentFilters: FilterMap): Promise<{ value: string; label: string; count: number }[]> {
    const plainFilters: Record<string, string> = {};
    for (const [k, v] of Object.entries(currentFilters)) {
      if (v !== undefined) plainFilters[k] = v;
    }
    return api.getFilterValues(dimensionId, plainFilters, state.dateRange);
  }

  function handleDateRangeChange(dateRange: DateRange) {
    setState((prev) => ({ ...prev, dateRange }));
  }

  function handleVirtualEntityClick(entity: EntityRef) {
    setState(prev => ({ ...prev, orgPath: [...prev.orgPath, entity] }));
  }

  function handleEntityClick(entity: EntityRef) {
    if (activeDimensionId !== null) {
      const activeDim = dimensions.find(d => getDimensionId(d) === activeDimensionId);
      if (activeDim !== undefined && isOwnerDimension(activeDim)) {
        const currentRows = costData?.rows ?? [];
        const row = currentRows.find(r => r.entity === entity);
        if (row?.isVirtual === true) {
          handleVirtualEntityClick(entity);
          return;
        }
      }
      setState(prev => ({ ...prev, popup: { entity, dimension: activeDimensionId } }));
    }
  }

  function handlePopupClose() {
    setState(prev => ({ ...prev, popup: null }));
  }

  function handlePopupSetFilter(entity: string, dimension: string) {
    setState(prev => ({
      ...prev,
      popup: null,
      filters: { ...prev.filters, [asDimensionId(dimension)]: asTagValue(entity) },
    }));
  }

  function handlePopupOpenDetail(entity: string, dimension: string) {
    setState(prev => ({ ...prev, popup: null }));
    if (onEntityClickProp !== undefined) {
      onEntityClickProp(entity, dimension);
    }
  }

  const costData: CostResult | null =
    costsQuery.status === 'success' ? costsQuery.data : null;

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-text-primary">Cost Overview</h2>
          <p className="text-sm text-text-secondary mt-0.5">Cloud spending visibility</p>
        </div>
        <div className="flex items-center gap-3">
          <DateRangePicker value={state.dateRange} onChange={handleDateRangeChange} />
          {costData !== null && (
            <CsvExport rows={costData.rows} topServices={costData.topServices} />
          )}
        </div>
      </div>

      {dimensionsQuery.status === 'loading' && (
        <div className="text-sm text-text-secondary">Loading…</div>
      )}
      {dimensionsQuery.status === 'error' && (
        <div className="rounded-lg border border-negative bg-negative-muted px-4 py-3 text-sm text-negative">
          Failed to load dimensions: {dimensionsQuery.error.message}
        </div>
      )}

      {dimensions.length > 0 && (
        <>
          <FilterBar
            dimensions={dimensions}
            filters={state.filters}
            onFilterChange={handleFilterChange}
            getFilterValues={handleGetFilterValues}
          />

          {costData !== null && (
            <SummaryCard
              totalCost={costData.totalCost}
              dateRange={costData.dateRange}
            />
          )}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <DimensionSelector
              dimensions={dimensions}
              selected={activeDimensionId ?? ''}
              onSelect={handleDimensionSelect}
            />
          </div>


          {!dimensions.some(isOwnerDimension) && (
            <ConceptPlaceholder concept="owner" />
          )}

          {!dimensions.some(isProductDimension) && (
            <ConceptPlaceholder concept="product" />
          )}

          {costsQuery.status === 'loading' && (
            <div className="text-sm text-text-secondary">Loading costs…</div>
          )}
          {costsQuery.status === 'error' && (
            <div className="rounded-lg border border-negative bg-negative-muted px-4 py-3 text-sm text-negative">
              Failed to load costs: {costsQuery.error.message}
            </div>
          )}
          {state.orgPath.length > 0 && (
            <nav className="flex items-center gap-1 text-sm text-text-secondary">
              <button
                type="button"
                className="hover:text-text-primary transition-colors"
                onClick={() => { handleBreadcrumbClick(0); }}
              >
                All
              </button>
              {state.orgPath.map((name, i) => (
                <span key={name} className="flex items-center gap-1">
                  <span className="text-text-muted">/</span>
                  {i < state.orgPath.length - 1 ? (
                    <button
                      type="button"
                      className="hover:text-text-primary transition-colors"
                      onClick={() => { handleBreadcrumbClick(i + 1); }}
                    >
                      {name}
                    </button>
                  ) : (
                    <span className="text-text-primary">{name}</span>
                  )}
                </span>
              ))}
            </nav>
          )}
          {costData !== null && (
            <CostTable
              rows={[...costData.rows]}
              topServices={[...costData.topServices]}
              onEntityClick={handleEntityClick}
            />
          )}
        </>
      )}

      {state.popup !== null && (
        <EntityPopup
          entity={state.popup.entity}
          dimension={state.popup.dimension}
          onClose={handlePopupClose}
          onSetFilter={handlePopupSetFilter}
          onOpenDetail={handlePopupOpenDetail}
        />
      )}
    </div>
  );
}
