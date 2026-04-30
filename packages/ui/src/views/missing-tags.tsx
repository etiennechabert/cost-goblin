import { useCallback, useMemo, useState } from 'react';
import type {
  Dimension,
  DimensionId,
  MissingTagsResult,
  MissingTagRow,
  NonResourceCostRow,
} from '@costgoblin/core/browser';
import { asDimensionId, asDollars } from '@costgoblin/core/browser';
import type { SortingState } from '@tanstack/react-table';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useLagDays } from '../hooks/use-lag-days.js';
import { useQuery } from '../hooks/use-query.js';
import { getDimensionId, isTagDimension } from '../lib/dimensions.js';
import { formatDollars } from '../components/format.js';
import { DataTable } from '../components/data-table.js';
import type { TableColumn } from '../lib/table-types.js';
import { DateRangePicker, getDefaultDateRange } from '../components/date-range-picker.js';
import type { DateRange, Granularity } from '../components/date-range-picker.js';

function buildColumns(showRatio: boolean, dimLabel: string): readonly TableColumn<MissingTagRow>[] {
  const cols: TableColumn<MissingTagRow>[] = [
    { id: 'accountName', header: 'Account', dimId: 'account', clickable: true, accessorFn: r => r.accountName },
    { id: 'resourceId', header: 'Resource', dimId: 'resource_id', clickable: true, accessorFn: r => r.resourceId, mono: true, truncate: true },
    { id: 'service', header: 'Service', dimId: 'service', clickable: true, accessorFn: r => r.service },
    { id: 'serviceFamily', header: 'Family', dimId: 'service_family', clickable: true, accessorFn: r => r.serviceFamily },
    {
      id: 'cost', header: 'Cost', align: 'right', mono: true,
      accessorFn: r => r.cost,
      cell: (v) => formatDollars(v as number),
    },
    { id: 'closestOwner', header: `Fallback ${dimLabel}`, accessorFn: r => r.closestOwner ?? '' },
  ];
  if (showRatio) {
    cols.push({
      id: 'categoryTaggedRatio', header: 'Tagged in category', align: 'right', mono: true,
      accessorFn: r => r.categoryTaggedRatio,
      cell: (v) => `${String(Math.round((v as number) * 100))}%`,
    });
  }
  return cols;
}

const NON_RESOURCE_COLUMNS: readonly TableColumn<NonResourceCostRow>[] = [
  { id: 'service', header: 'Service', dimId: 'service', clickable: true, accessorFn: r => r.service },
  { id: 'serviceFamily', header: 'Family', dimId: 'service_family', clickable: true, accessorFn: r => r.serviceFamily },
  { id: 'lineItemType', header: 'Line item type', accessorFn: r => r.lineItemType },
  {
    id: 'cost', header: 'Cost', align: 'right', mono: true,
    accessorFn: r => r.cost,
    cell: (v) => formatDollars(v as number),
  },
];

function ExpandedRow({ row }: Readonly<{ row: MissingTagRow }>) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-x-4 gap-y-0.5 text-[11px]">
      <div className="flex gap-1.5 py-0.5 min-w-0">
        <span className="text-text-muted shrink-0">Account ID</span>
        <span className="text-text-primary font-mono truncate" title={row.accountId}>{row.accountId}</span>
      </div>
      <div className="flex gap-1.5 py-0.5 min-w-0">
        <span className="text-text-muted shrink-0">Account</span>
        <span className="text-text-primary truncate">{row.accountName}</span>
      </div>
      <div className="flex gap-1.5 py-0.5 min-w-0">
        <span className="text-text-muted shrink-0">Resource</span>
        <span className="text-text-primary font-mono truncate" title={row.resourceId}>{row.resourceId}</span>
      </div>
      <div className="flex gap-1.5 py-0.5 min-w-0">
        <span className="text-text-muted shrink-0">Service</span>
        <span className="text-text-primary truncate">{row.service}</span>
      </div>
      <div className="flex gap-1.5 py-0.5 min-w-0">
        <span className="text-text-muted shrink-0">Family</span>
        <span className="text-text-primary truncate">{row.serviceFamily}</span>
      </div>
      <div className="flex gap-1.5 py-0.5 min-w-0">
        <span className="text-text-muted shrink-0">Cost</span>
        <span className="text-text-primary">{formatDollars(row.cost)}</span>
      </div>
      <div className="flex gap-1.5 py-0.5 min-w-0">
        <span className="text-text-muted shrink-0">Fallback Owner</span>
        <span className="text-text-primary truncate">{row.closestOwner ?? '—'}</span>
      </div>
      <div className="flex gap-1.5 py-0.5 min-w-0">
        <span className="text-text-muted shrink-0">Bucket</span>
        <span className="text-text-primary">{row.bucket}</span>
      </div>
      <div className="flex gap-1.5 py-0.5 min-w-0">
        <span className="text-text-muted shrink-0">Category tagged ratio</span>
        <span className="text-text-primary">{`${String(Math.round(row.categoryTaggedRatio * 100))}%`}</span>
      </div>
    </div>
  );
}

interface MissingTagsProps {
  onEntityClick?: ((entity: string, dimension: string) => void) | undefined;
}

export function MissingTags({ onEntityClick }: MissingTagsProps = {}) {
  const api = useCostApi();
  const lagDays = useLagDays();
  const dimensionsQuery = useQuery(() => api.getDimensions(), []);

  const [dateRange, setDateRange] = useState<DateRange>(() => getDefaultDateRange(lagDays));
  const [granularity, setGranularity] = useState<Granularity>('daily');
  const [minCost, setMinCost] = useState(1);
  const [selectedTag, setSelectedTag] = useState<DimensionId | null>(null);
  const [selectedClosest, setSelectedClosest] = useState<string | null>(null);
  const [showLikelyUntaggable, setShowLikelyUntaggable] = useState(false);
  const [showNonResource, setShowNonResource] = useState(false);
  const [actionableExpanded, setActionableExpanded] = useState(true);
  const [nonResourceExpanded, setNonResourceExpanded] = useState(false);
  const [sorting, setSorting] = useState<SortingState>([{ id: 'cost', desc: true }]);

  const dimensions: Dimension[] =
    dimensionsQuery.status === 'success' ? dimensionsQuery.data : [];
  const tagDimensions = dimensions.filter(isTagDimension);

  const firstTagId = tagDimensions.length > 0 && tagDimensions[0] !== undefined
    ? getDimensionId(tagDimensions[0])
    : null;
  const activeTagId = selectedTag ?? firstTagId;

  const missingQuery = useQuery(
    () => {
      if (activeTagId === null) return Promise.resolve(null);
      return api.queryMissingTags({
        dateRange,
        filters: {},
        minCost: asDollars(minCost),
        tagDimension: activeTagId,
      });
    },
    [activeTagId, minCost, dateRange.start, dateRange.end, api],
  );

  const data: MissingTagsResult | null =
    missingQuery.status === 'success' ? missingQuery.data : null;

  const actionableRows = useMemo(
    () => data === null ? [] : data.rows.filter(r => r.bucket === 'actionable'),
    [data],
  );
  const likelyUntaggableRows = useMemo(
    () => data === null ? [] : data.rows.filter(r => r.bucket === 'likely-untaggable'),
    [data],
  );

  const visibleRows = useMemo(
    () => showLikelyUntaggable ? [...actionableRows, ...likelyUntaggableRows] : actionableRows,
    [actionableRows, likelyUntaggableRows, showLikelyUntaggable],
  );

  const closestOptions = useMemo(() => {
    const totals = new Map<string, number>();
    for (const r of visibleRows) {
      const key = r.closestOwner ?? '';
      totals.set(key, (totals.get(key) ?? 0) + Number(r.cost));
    }
    return [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([entity, cost]) => ({ entity, cost }));
  }, [visibleRows]);

  const filteredActionable = useMemo(
    () => selectedClosest === null ? actionableRows : actionableRows.filter(r => (r.closestOwner ?? '') === selectedClosest),
    [actionableRows, selectedClosest],
  );
  const filteredUntaggable = useMemo(
    () => selectedClosest === null ? likelyUntaggableRows : likelyUntaggableRows.filter(r => (r.closestOwner ?? '') === selectedClosest),
    [likelyUntaggableRows, selectedClosest],
  );

  const activeDimLabel = tagDimensions.find(d => getDimensionId(d) === activeTagId)?.label ?? 'Owner';
  const actionableColumns = useMemo(() => buildColumns(true, activeDimLabel), [activeDimLabel]);
  const untaggableColumns = useMemo(() => buildColumns(false, activeDimLabel), [activeDimLabel]);

  const renderExpandedRow = useCallback((row: MissingTagRow) => <ExpandedRow row={row} />, []);

  const handleCellClick = useCallback((_row: MissingTagRow, columnId: string, value: unknown) => {
    if (typeof value !== 'string' || value.length === 0) return;
    if (columnId === 'closestOwner') {
      setSelectedClosest(value);
    } else {
      const col = actionableColumns.find(c => c.id === columnId);
      if (col?.dimId !== undefined && col.dimId !== null && onEntityClick !== undefined) {
        onEntityClick(value, col.dimId);
      }
    }
  }, [actionableColumns, onEntityClick]);

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <p className="text-base font-medium text-text-secondary">Resources without the selected allocation tag, classified by taggability.</p>
        <DateRangePicker
          value={dateRange}
          granularity={granularity}
          onChange={(range, g) => { setDateRange(range); setGranularity(g); }}
          lagDays={lagDays}
        />
      </div>

      <div className="flex flex-wrap items-center gap-4">
        {tagDimensions.length > 0 && (
          <div className="flex items-center gap-1 rounded-lg border border-border bg-bg-tertiary/30 p-1">
            <span className="px-2 text-xs text-text-muted">Tag</span>
            {tagDimensions.map((dim) => {
              const id = getDimensionId(dim);
              const isSelected = activeTagId === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => { setSelectedTag(asDimensionId(id)); setSelectedClosest(null); }}
                  className={[
                    'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                    isSelected
                      ? 'bg-accent text-bg-primary shadow-sm'
                      : 'text-text-secondary hover:text-text-primary',
                  ].join(' ')}
                >
                  {dim.label}
                </button>
              );
            })}
          </div>
        )}

        <label className="flex items-center gap-1.5 text-xs text-text-secondary">
          <span>Min cost $</span>
          <input
            type="number"
            value={minCost}
            onChange={(e) => { setMinCost(Number(e.target.value)); }}
            className="w-20 rounded border border-border bg-bg-primary px-2 py-1 text-xs text-text-primary"
          />
        </label>

        {closestOptions.length > 0 && (
          <label className="flex items-center gap-1.5 text-xs text-text-secondary">
            <span>Fallback {activeDimLabel}</span>
            <select
              value={selectedClosest ?? '__all__'}
              onChange={(e) => { setSelectedClosest(e.target.value === '__all__' ? null : e.target.value); }}
              className="rounded border border-border bg-bg-primary px-2 py-1 text-xs text-text-primary"
            >
              <option value="__all__">All</option>
              {closestOptions.map(opt => (
                <option key={`opt-${opt.entity}`} value={opt.entity}>
                  {opt.entity.length === 0 ? '(none)' : opt.entity} — {formatDollars(opt.cost)}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="flex items-center gap-1.5 text-xs text-text-secondary">
          <input
            type="checkbox"
            checked={showLikelyUntaggable}
            onChange={(e) => { setShowLikelyUntaggable(e.target.checked); }}
            className="h-3.5 w-3.5 rounded accent-emerald-500"
          />
          <span>Show likely-untaggable categories</span>
        </label>

        <label className="flex items-center gap-1.5 text-xs text-text-secondary">
          <input
            type="checkbox"
            checked={showNonResource}
            onChange={(e) => { setShowNonResource(e.target.checked); }}
            className="h-3.5 w-3.5 rounded accent-emerald-500"
          />
          <span>Show non-resource cost</span>
        </label>
      </div>

      {missingQuery.status === 'loading' && (
        <div className="text-sm text-text-secondary">Loading...</div>
      )}
      {missingQuery.status === 'error' && (
        <div className="rounded-lg border border-negative bg-negative-muted px-4 py-3 text-sm text-negative">
          {missingQuery.error.message}
        </div>
      )}

      {data !== null && filteredActionable.length > 0 && (
        <div className="rounded-xl border border-border bg-bg-secondary/30 overflow-hidden">
          <button
            type="button"
            onClick={() => { setActionableExpanded(v => !v); }}
            className="w-full flex items-center justify-between px-5 py-3 text-left hover:bg-bg-tertiary/20 transition-colors"
          >
            <div>
              <p className="text-sm font-medium text-text-primary">
                Actionable
                <span className="ml-2 text-base font-bold tabular-nums text-accent">
                  {formatDollars(selectedClosest === null ? data.totalActionableCost : asDollars(filteredActionable.reduce((s, r) => s + Number(r.cost), 0)))}
                </span>
              </p>
              <p className="text-xs text-text-muted">
                {selectedClosest === null
                  ? `${String(data.actionableCount)} untagged resources in taggable categories`
                  : `${String(filteredActionable.length)} untagged resources in taggable categories`}
              </p>
            </div>
            <span className="text-text-muted text-xs">{actionableExpanded ? '▾' : '▸'}</span>
          </button>
          {actionableExpanded && (
            <div className="border-t border-border px-4 py-3">
              <DataTable<MissingTagRow>
                data={filteredActionable}
                columns={actionableColumns}
                sorting={sorting}
                onSortingChange={setSorting}
                onCellClick={handleCellClick}
                renderExpandedRow={renderExpandedRow}
                height={Math.max(200, window.innerHeight - 520)}
                csvFilename={`costgoblin-missing-tags-actionable-${dateRange.start}-${dateRange.end}`}
              />
            </div>
          )}
        </div>
      )}

      {data !== null && filteredActionable.length === 0 && filteredUntaggable.length === 0 && (
        <div className="rounded-xl border border-border bg-bg-secondary/50 p-12 text-center text-text-secondary">
          No untagged resources above ${String(minCost)}
        </div>
      )}

      {data !== null && showLikelyUntaggable && filteredUntaggable.length > 0 && (
        <div className="rounded-xl border border-border bg-bg-secondary/30 overflow-hidden">
          <button
            type="button"
            onClick={() => { setShowLikelyUntaggable(v => !v); }}
            className="w-full flex items-center justify-between px-5 py-3 text-left hover:bg-bg-tertiary/20 transition-colors"
          >
            <div>
              <p className="text-sm font-medium text-text-secondary">
                Likely not taggable
                <span className="ml-2 text-base font-bold tabular-nums">
                  {formatDollars(selectedClosest === null ? data.totalLikelyUntaggableCost : asDollars(filteredUntaggable.reduce((s, r) => s + Number(r.cost), 0)))}
                </span>
              </p>
              <p className="text-xs text-text-muted">
                {selectedClosest === null
                  ? `${String(data.likelyUntaggableCount)} resources in categories where nothing is tagged`
                  : `${String(filteredUntaggable.length)} resources in categories where nothing is tagged`}
              </p>
            </div>
            <span className="text-text-muted text-xs">▾</span>
          </button>
          <div className="border-t border-border px-4 py-3">
            <DataTable<MissingTagRow>
              data={filteredUntaggable}
              columns={untaggableColumns}
              sorting={sorting}
              onSortingChange={setSorting}
              onCellClick={handleCellClick}
              renderExpandedRow={renderExpandedRow}
              height={300}
              csvFilename={`costgoblin-missing-tags-untaggable-${dateRange.start}-${dateRange.end}`}
            />
          </div>
        </div>
      )}

      {data !== null && showNonResource && data.nonResourceRows.length > 0 && (
        <div className="rounded-xl border border-border bg-bg-secondary/30 overflow-hidden">
          <button
            type="button"
            onClick={() => { setNonResourceExpanded(v => !v); }}
            className="w-full flex items-center justify-between px-5 py-3 text-left hover:bg-bg-tertiary/20 transition-colors"
          >
            <div>
              <p className="text-sm font-medium text-text-primary">
                Non-resource cost
                <span className="ml-2 text-base font-bold tabular-nums text-text-secondary">{formatDollars(data.totalNonResourceCost)}</span>
              </p>
              <p className="text-xs text-text-muted">
                {String(data.nonResourceRows.length)} categories — tax, support, credits, and usage without a resource
              </p>
            </div>
            <span className="text-text-muted text-xs">{nonResourceExpanded ? '▾' : '▸'}</span>
          </button>
          {nonResourceExpanded && (
            <div className="border-t border-border px-4 py-3">
              <DataTable<NonResourceCostRow>
                data={data.nonResourceRows.slice()}
                columns={NON_RESOURCE_COLUMNS}
                sorting={sorting}
                onSortingChange={setSorting}
                height={300}
                csvFilename={`costgoblin-non-resource-cost-${dateRange.start}-${dateRange.end}`}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
