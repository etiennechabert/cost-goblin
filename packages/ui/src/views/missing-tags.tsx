import { useState } from 'react';
import type {
  Dimension,
  DimensionId,
  DateString,
  MissingTagsResult,
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

export function MissingTags() {
  const api = useCostApi();
  const dimensionsQuery = useQuery(() => api.getDimensions(), []);

  const [minCost, setMinCost] = useState(50);
  const [selectedTag, setSelectedTag] = useState<DimensionId | null>(null);

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

  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <h2 className="text-xl font-semibold text-text-primary">Missing Tags</h2>
        <p className="text-sm text-text-secondary mt-1">Resources without cost allocation tags</p>
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
          Min cost $
          <input
            type="number"
            value={minCost}
            onChange={(e) => { setMinCost(Number(e.target.value)); }}
            className="w-20 rounded border border-border bg-bg-primary px-2 py-1 text-xs text-text-primary"
          />
        </label>
      </div>

      {data !== null && (
        <div className="flex items-center gap-4 text-sm">
          <span className="font-medium text-text-primary">
            {formatDollars(data.totalUntaggedCost)} untagged
          </span>
          <span className="text-text-secondary">
            {String(data.resourceCount)} resources
          </span>
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

      {data !== null && data.rows.length > 0 && (
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
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, i) => (
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data !== null && data.rows.length === 0 && (
        <div className="rounded-xl border border-border bg-bg-secondary/50 p-12 text-center text-text-secondary">
          No untagged resources above ${String(minCost)}
        </div>
      )}
    </div>
  );
}
