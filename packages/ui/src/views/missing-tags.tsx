import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CoinRainLoader } from '../components/coin-rain-loader.js';
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
import { ClipboardCopy, Check, ChevronDown, CheckIcon } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover.js';

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

interface CopyContext {
  readonly rows: readonly MissingTagRow[];
  readonly tagLabel: string;
  readonly selectedOwner: string | null;
  readonly totalCost: number;
}

function buildMessageParts(ctx: CopyContext) {
  const owner = ctx.selectedOwner !== null && ctx.selectedOwner.length > 0
    ? ctx.selectedOwner
    : null;
  return { count: String(ctx.rows.length), tag: ctx.tagLabel, owner, cost: formatDollars(ctx.totalCost) };
}

function buildSlack(ctx: CopyContext): string {
  const p = buildMessageParts(ctx);
  const scope = p.owner === null ? '' : ` (filtered to *${p.owner}*)`;
  return [
    `*${p.count} resources* are missing the \`${p.tag}\` tag${scope}, representing *${p.cost}/month* in unattributed spend.`,
    '',
    'Full list in the attached CSV — please tag these resources or confirm they should be excluded.',
  ].join('\n');
}

function buildJira(ctx: CopyContext): string {
  const p = buildMessageParts(ctx);
  const scope = p.owner === null ? '' : ` (filtered to *${p.owner}*)`;
  return [
    `h3. Missing {{${p.tag}}} tag`,
    '',
    `*${p.count} resources*${scope} representing *${p.cost}/month* in unattributed spend.`,
    '',
    'Full list in the attached CSV — please tag these resources or confirm they should be excluded.',
  ].join('\n');
}

type CopyFormat = 'jira' | 'slack';
const FORMAT_LABELS: Record<CopyFormat, string> = { jira: 'Jira', slack: 'Slack' };
const FORMAT_BUILDERS: Record<CopyFormat, (ctx: CopyContext) => string> = { jira: buildJira, slack: buildSlack };

function CopyMessageButton({ ctx }: Readonly<{ ctx: CopyContext }>) {
  const [copied, setCopied] = useState<CopyFormat | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopy = useCallback((format: CopyFormat) => {
    if (ctx.rows.length === 0) return;
    void navigator.clipboard.writeText(FORMAT_BUILDERS[format](ctx)).then(() => {
      setCopied(format);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => { setCopied(null); }, 1500);
    });
  }, [ctx]);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={ctx.rows.length === 0}
          className="inline-flex items-center gap-1.5 rounded border border-border bg-bg-tertiary/30 px-2.5 py-1 text-xs text-text-secondary hover:text-text-primary hover:border-border disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <ClipboardCopy size={12} />
          <span>Copy message</span>
          <ChevronDown className="h-3 w-3 text-text-muted" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-36 p-1" align="end">
        {(['slack', 'jira'] as const).map(format => (
          <button
            key={format}
            type="button"
            onClick={() => { handleCopy(format); }}
            className="w-full flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-text-secondary hover:bg-bg-tertiary/50 hover:text-text-primary transition-colors"
          >
            {copied === format ? <Check size={12} className="text-accent" /> : <span className="w-3" />}
            <span>{copied === format ? 'Copied!' : FORMAT_LABELS[format]}</span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
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
  const [actionableExpanded, setActionableExpanded] = useState(true);
  const [untaggableExpanded, setUntaggableExpanded] = useState(false);
  const [nonResourceExpanded, setNonResourceExpanded] = useState(false);
  const [sorting, setSorting] = useState<SortingState>([{ id: 'cost', desc: true }]);

  const dimensions: Dimension[] =
    dimensionsQuery.status === 'success' ? dimensionsQuery.data : [];
  const tagDimensions = dimensions.filter(isTagDimension);

  const firstTagId = tagDimensions.length > 0 && tagDimensions[0] !== undefined
    ? getDimensionId(tagDimensions[0])
    : null;
  const activeTagId = selectedTag ?? firstTagId;

  const missingFirstRef = useRef(true);
  useEffect(() => {
    if (missingFirstRef.current) {
      missingFirstRef.current = false;
      return;
    }
    api.cancelPendingQueries().catch(() => undefined);
  }, [dateRange, granularity, api]);

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

  const closestOptions = useMemo(() => {
    const totals = new Map<string, number>();
    for (const r of actionableRows) {
      const key = r.closestOwner ?? '';
      totals.set(key, (totals.get(key) ?? 0) + Number(r.cost));
    }
    return [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([entity, cost]) => ({ entity, cost }));
  }, [actionableRows]);

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
      <div className="flex items-start justify-between">
        <div>
          <p className="text-base font-medium text-text-secondary">Missing Tags</p>
          <p className="text-xs text-text-muted mt-1">Resources without the selected allocation tag, classified by taggability.</p>
        </div>
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
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="flex items-center gap-1.5 rounded-lg border border-border bg-bg-tertiary/30 px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-bg-tertiary/50 transition-colors"
              >
                <span className="text-text-muted">Fallback {activeDimLabel}</span>
                <span>{(() => {
                  if (selectedClosest === null) return 'All';
                  return selectedClosest.length === 0 ? '(none)' : selectedClosest;
                })()}</span>
                <ChevronDown className="h-3 w-3 text-text-muted" />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-72 p-1 max-h-80 overflow-y-auto" align="start">
              <button
                type="button"
                onClick={() => { setSelectedClosest(null); }}
                className={[
                  'w-full flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs transition-colors',
                  selectedClosest === null
                    ? 'bg-accent/10 text-accent font-medium'
                    : 'text-text-secondary hover:bg-bg-tertiary/50 hover:text-text-primary',
                ].join(' ')}
              >
                {selectedClosest === null && <CheckIcon className="h-3 w-3" />}
                {selectedClosest !== null && <span className="w-3" />}
                <span>All</span>
              </button>
              {closestOptions.map(opt => {
                const label = opt.entity.length === 0 ? '(none)' : opt.entity;
                const isSelected = selectedClosest === opt.entity;
                return (
                  <button
                    key={`opt-${opt.entity}`}
                    type="button"
                    onClick={() => { setSelectedClosest(opt.entity); }}
                    className={[
                      'w-full flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs transition-colors',
                      isSelected
                        ? 'bg-accent/10 text-accent font-medium'
                        : 'text-text-secondary hover:bg-bg-tertiary/50 hover:text-text-primary',
                    ].join(' ')}
                  >
                    {isSelected ? <CheckIcon className="h-3 w-3" /> : <span className="w-3" />}
                    <span className="truncate">{label}</span>
                    <span className="ml-auto tabular-nums text-text-muted">{formatDollars(opt.cost)}</span>
                  </button>
                );
              })}
            </PopoverContent>
          </Popover>
        )}

      </div>

      {dimensionsQuery.status === 'success' && tagDimensions.length === 0 && (
        <div className="rounded-xl border border-border bg-bg-secondary/50 p-12 text-center">
          <p className="text-sm font-medium text-text-primary">No tag dimensions configured</p>
          <p className="text-xs text-text-secondary mt-1">
            Add custom tag dimensions in the <strong>Dimensions</strong> page to start tracking missing tags.
          </p>
        </div>
      )}

      {missingQuery.status === 'loading' && (
        <div className="flex-1">
          <CoinRainLoader height={500} count={10} />
        </div>
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
                Actionable{' '}
                <span className="ml-2 text-base font-bold tabular-nums text-accent">
                  {formatDollars(selectedClosest === null ? data.totalActionableCost : asDollars(filteredActionable.reduce((s, r) => s + Number(r.cost), 0)))}
                  {data.actionableCount < data.unfilteredActionableCount && selectedClosest === null && (
                    <span className="text-xs font-normal text-text-muted"> out of {formatDollars(data.unfilteredActionableCost)}</span>
                  )}
                </span>
              </p>
              <p className="text-xs text-text-muted">
                {(() => {
                  const count = selectedClosest === null ? data.actionableCount : filteredActionable.length;
                  const showScope = selectedClosest === null && data.actionableCount < data.unfilteredActionableCount;
                  return showScope
                    ? `${String(count)} out of ${String(data.unfilteredActionableCount)} untagged resources in taggable categories`
                    : `${String(count)} untagged resources in taggable categories`;
                })()}
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
                headerRight={<CopyMessageButton ctx={{ rows: filteredActionable, tagLabel: activeDimLabel, selectedOwner: selectedClosest, totalCost: filteredActionable.reduce((s, r) => s + Number(r.cost), 0) }} />}
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

      {data !== null && filteredUntaggable.length > 0 && (
        <div className="rounded-xl border border-border bg-bg-secondary/30 overflow-hidden">
          <button
            type="button"
            onClick={() => { setUntaggableExpanded(v => !v); }}
            className="w-full flex items-center justify-between px-5 py-3 text-left hover:bg-bg-tertiary/20 transition-colors"
          >
            <div>
              <p className="text-sm font-medium text-text-secondary">
                Likely not taggable{' '}
                <span className="ml-2 text-base font-bold tabular-nums">
                  {formatDollars(selectedClosest === null ? data.totalLikelyUntaggableCost : asDollars(filteredUntaggable.reduce((s, r) => s + Number(r.cost), 0)))}
                  {data.likelyUntaggableCount < data.unfilteredLikelyUntaggableCount && selectedClosest === null && (
                    <span className="text-xs font-normal text-text-muted"> out of {formatDollars(data.unfilteredLikelyUntaggableCost)}</span>
                  )}
                </span>
              </p>
              <p className="text-xs text-text-muted">
                {(() => {
                  const count = selectedClosest === null ? data.likelyUntaggableCount : filteredUntaggable.length;
                  const showScope = selectedClosest === null && data.likelyUntaggableCount < data.unfilteredLikelyUntaggableCount;
                  return showScope
                    ? `${String(count)} out of ${String(data.unfilteredLikelyUntaggableCount)} resources in categories where nothing is tagged`
                    : `${String(count)} resources in categories where nothing is tagged`;
                })()}
              </p>
            </div>
            <span className="text-text-muted text-xs">{untaggableExpanded ? '▾' : '▸'}</span>
          </button>
          {untaggableExpanded && (
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
          )}
        </div>
      )}

      {data !== null && data.nonResourceRows.length > 0 && (
        <div className="rounded-xl border border-border bg-bg-secondary/30 overflow-hidden">
          <button
            type="button"
            onClick={() => { setNonResourceExpanded(v => !v); }}
            className="w-full flex items-center justify-between px-5 py-3 text-left hover:bg-bg-tertiary/20 transition-colors"
          >
            <div>
              <p className="text-sm font-medium text-text-primary">
                Non-resource cost{' '}
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
