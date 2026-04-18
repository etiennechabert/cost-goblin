import { useState } from 'react';
import type {
  Dimension,
  DimensionId,
  DateString,
  MissingTagsResult,
  MissingTagRow,
} from '@costgoblin/core/browser';
import { asDimensionId, asDateString, asDollars } from '@costgoblin/core/browser';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { getDimensionId, isTagDimension } from '../lib/dimensions.js';
import { formatDollars } from '../components/format.js';

function getDateRange(): { start: DateString; end: DateString } {
  const today = new Date();
  const end = asDateString(today.toISOString().slice(0, 10));
  const startDate = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
  const start = asDateString(startDate.toISOString().slice(0, 10));
  return { start, end };
}

function ResourceTable({ rows, showRatio }: Readonly<{ rows: readonly MissingTagRow[]; showRatio: boolean }>) {
  return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-text-secondary">
            <th className="px-4 pb-3 pt-4 font-medium">Account</th>
            <th className="px-4 pb-3 pt-4 font-medium">Resource</th>
            <th className="px-4 pb-3 pt-4 font-medium">Service</th>
            <th className="px-4 pb-3 pt-4 font-medium">Family</th>
            <th className="px-4 pb-3 pt-4 text-right font-medium">Cost</th>
            <th className="px-4 pb-3 pt-4 font-medium">Closest Owner</th>
            {showRatio && <th className="px-4 pb-3 pt-4 text-right font-medium">Tagged in category</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={`${row.resourceId}-${String(i)}`} className="border-b border-border-subtle hover:bg-bg-tertiary/30 transition-colors">
              <td className="px-4 py-3 text-text-primary">{row.accountName}</td>
              <td className="px-4 py-3 text-text-secondary font-mono text-xs max-w-64 truncate" title={row.resourceId}>
                {row.resourceId}
              </td>
              <td className="px-4 py-3 text-text-secondary">{row.service}</td>
              <td className="px-4 py-3 text-text-secondary">{row.serviceFamily}</td>
              <td className="px-4 py-3 text-right tabular-nums font-medium text-text-primary">
                {formatDollars(row.cost)}
              </td>
              <td className="px-4 py-3 text-text-secondary">
                {row.closestOwner ?? '—'}
              </td>
              {showRatio && (
                <td className="px-4 py-3 text-right tabular-nums text-text-muted">
                  {`${String(Math.round(row.categoryTaggedRatio * 100))}%`}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MissingTags() {
  const api = useCostApi();
  const dimensionsQuery = useQuery(() => api.getDimensions(), []);

  const [minCost, setMinCost] = useState(50);
  const [selectedTag, setSelectedTag] = useState<DimensionId | null>(null);
  const [showLikelyUntaggable, setShowLikelyUntaggable] = useState(false);
  const [nonResourceExpanded, setNonResourceExpanded] = useState(false);

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
        dateRange: getDateRange(),
        filters: {},
        minCost: asDollars(minCost),
        tagDimension: activeTagId,
      });
    },
    [activeTagId, minCost, api],
  );

  const data: MissingTagsResult | null =
    missingQuery.status === 'success' ? missingQuery.data : null;

  const actionableRows = data === null ? [] : data.rows.filter(r => r.bucket === 'actionable');
  const likelyUntaggableRows = data === null ? [] : data.rows.filter(r => r.bucket === 'likely-untaggable');

  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <h2 className="text-xl font-semibold text-text-primary">Missing Tags</h2>
        <p className="text-sm text-text-secondary mt-1">
          Resources without the selected allocation tag, classified by whether other resources in the same service category are tagged.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        {tagDimensions.length > 1 && (
          <div className="flex items-center gap-1 rounded-lg border border-border bg-bg-tertiary/30 p-1">
            {tagDimensions.map((dim) => {
              const id = getDimensionId(dim);
              const isSelected = activeTagId === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => { setSelectedTag(asDimensionId(id)); }}
                  className={[
                    'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                    isSelected
                      ? 'bg-bg-secondary text-text-primary shadow-sm'
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

        <label className="flex items-center gap-1.5 text-xs text-text-secondary">
          <input
            type="checkbox"
            checked={showLikelyUntaggable}
            onChange={(e) => { setShowLikelyUntaggable(e.target.checked); }}
            className="h-3.5 w-3.5 rounded accent-emerald-500"
          />
          <span>Show likely-untaggable categories</span>
        </label>
      </div>

      {data !== null && (
        <div className="flex flex-wrap items-center gap-5 rounded-xl border border-border bg-bg-secondary/30 px-5 py-4">
          <div>
            <p className="text-xs text-text-muted">Actionable missing tags</p>
            <p className="text-lg font-bold tabular-nums text-accent">
              {formatDollars(data.totalActionableCost)}
            </p>
            <p className="text-[11px] text-text-muted">
              {String(data.actionableCount)} resources in taggable categories
            </p>
          </div>
          <div>
            <p className="text-xs text-text-muted">Likely not taggable</p>
            <p className="text-lg font-bold tabular-nums text-text-secondary">
              {formatDollars(data.totalLikelyUntaggableCost)}
            </p>
            <p className="text-[11px] text-text-muted">
              {String(data.likelyUntaggableCount)} resources in categories where nothing is tagged
            </p>
          </div>
          <div>
            <p className="text-xs text-text-muted">Non-resource cost</p>
            <p className="text-lg font-bold tabular-nums text-text-secondary">
              {formatDollars(data.totalNonResourceCost)}
            </p>
            <p className="text-[11px] text-text-muted">
              tax, support, credits, and usage without a resource
            </p>
          </div>
        </div>
      )}

      {missingQuery.status === 'loading' && (
        <div className="text-sm text-text-secondary">Loading...</div>
      )}
      {missingQuery.status === 'error' && (
        <div className="rounded-lg border border-negative bg-negative-muted px-4 py-3 text-sm text-negative">
          {missingQuery.error.message}
        </div>
      )}

      {data !== null && actionableRows.length > 0 && (
        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold text-text-primary">
            Actionable
            <span className="ml-2 text-xs font-normal text-text-muted">
              {String(actionableRows.length)} resources · {formatDollars(data.totalActionableCost)}
            </span>
          </h3>
          <ResourceTable rows={actionableRows} showRatio />
        </div>
      )}

      {data !== null && actionableRows.length === 0 && likelyUntaggableRows.length === 0 && (
        <div className="rounded-xl border border-border bg-bg-secondary/50 p-12 text-center text-text-secondary">
          No untagged resources above ${String(minCost)}
        </div>
      )}

      {data !== null && showLikelyUntaggable && likelyUntaggableRows.length > 0 && (
        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold text-text-secondary">
            Likely not taggable
            <span className="ml-2 text-xs font-normal text-text-muted">
              {String(likelyUntaggableRows.length)} resources · {formatDollars(data.totalLikelyUntaggableCost)}
            </span>
          </h3>
          <p className="text-xs text-text-muted -mt-2">
            No resource in these categories has been tagged in the selected period — either AWS doesn't allow tagging them, or your org never has.
          </p>
          <ResourceTable rows={likelyUntaggableRows} showRatio={false} />
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
                Non-resource cost
              </p>
              <p className="text-xs text-text-muted">
                {formatDollars(data.totalNonResourceCost)} across {String(data.nonResourceRows.length)} categories — not attributable to a tagged resource
              </p>
            </div>
            <span className="text-text-muted text-xs">{nonResourceExpanded ? '▾' : '▸'}</span>
          </button>
          {nonResourceExpanded && (
            <div className="border-t border-border">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-text-muted bg-bg-tertiary/20">
                    <th className="px-4 py-2 font-medium">Service</th>
                    <th className="px-4 py-2 font-medium">Family</th>
                    <th className="px-4 py-2 font-medium">Line item type</th>
                    <th className="px-4 py-2 text-right font-medium">Cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {data.nonResourceRows.map((row, i) => (
                    <tr key={`${row.service}-${row.lineItemType}-${String(i)}`}>
                      <td className="px-4 py-1.5 text-text-primary">{row.service}</td>
                      <td className="px-4 py-1.5 text-text-secondary">{row.serviceFamily}</td>
                      <td className="px-4 py-1.5 text-text-secondary">{row.lineItemType}</td>
                      <td className="px-4 py-1.5 text-right tabular-nums text-text-primary">{formatDollars(row.cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
