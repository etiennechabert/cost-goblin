import type { DateString, EntityDetailResult } from '@costgoblin/core/browser';
import { asDimensionId, asEntityRef } from '@costgoblin/core/browser';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { daysAgo } from '../lib/dates.js';
import { formatDollars } from './format.js';

export interface EntityPopupProps {
  entity: string;
  dimension: string;
  onClose: () => void;
  onSetFilter: (entity: string, dimension: string) => void;
  onOpenDetail: (entity: string, dimension: string) => void;
}

function getDateRange(): { start: DateString; end: DateString } {
  return { start: daysAgo(30), end: daysAgo(0) };
}

function MiniHistogram({ dailyCosts }: Readonly<{ dailyCosts: EntityDetailResult['dailyCosts'] }>) {
  const last10 = dailyCosts.slice(-10);
  const max = last10.reduce((m, d) => Math.max(m, d.cost), 0);

  return (
    <div className="flex items-end gap-0.5" style={{ height: '48px' }}>
      {last10.map((day) => {
        const heightPct = max > 0 ? (day.cost / max) * 100 : 0;
        return (
          <div
            key={day.date}
            className="group relative flex flex-1 flex-col items-center justify-end"
            style={{ height: '100%' }}
          >
            <div
              className="w-full rounded-t-sm bg-accent transition-colors group-hover:bg-accent-hover"
              style={{ height: `${String(heightPct)}%`, minHeight: heightPct > 0 ? '2px' : '0' }}
              title={`${day.date}: ${formatDollars(day.cost)}`}
            />
          </div>
        );
      })}
    </div>
  );
}

export function EntityPopup({
  entity,
  dimension,
  onClose,
  onSetFilter,
  onOpenDetail,
}: Readonly<EntityPopupProps>) {
  const api = useCostApi();

  const detailQuery = useQuery(
    () =>
      api.queryEntityDetail({
        entity: asEntityRef(entity),
        dimension: asDimensionId(dimension),
        dateRange: getDateRange(),
        filters: {},
      }),
    [entity, dimension, api],
  );

  const data: EntityDetailResult | null =
    detailQuery.status === 'success' ? detailQuery.data : null;

  const top5 = data === null ? [] : data.bySubEntity.slice(0, 5);

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/40"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <div className="fixed right-0 top-0 z-50 flex h-full w-96 flex-col bg-bg-primary shadow-2xl">
        {/* Header */}
        <div className="flex items-start justify-between border-b border-border px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-text-primary">{entity}</h2>
            <p className="mt-0.5 text-xs text-text-secondary">{dimension}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-5 py-5">
          {detailQuery.status === 'loading' && (
            <p className="text-sm text-text-secondary">Loading…</p>
          )}
          {detailQuery.status === 'error' && (
            <div className="rounded-lg border border-negative bg-negative-muted px-4 py-3 text-sm text-negative">
              {detailQuery.error.message}
            </div>
          )}

          {data !== null && (
            <>
              {/* Total cost */}
              <div className="rounded-xl border border-border bg-bg-secondary/50 px-5 py-4">
                <p className="text-xs font-medium uppercase tracking-wider text-text-muted">
                  Total Cost
                </p>
                <p className="mt-1.5 text-2xl font-semibold tabular-nums text-text-primary">
                  {formatDollars(data.totalCost)}
                </p>
              </div>

              {/* Mini histogram */}
              {data.dailyCosts.length > 0 && (
                <div className="rounded-xl border border-border bg-bg-secondary/50 px-5 py-4">
                  <p className="mb-3 text-xs font-medium uppercase tracking-wider text-text-muted">
                    Daily Trend — Last 10 Days
                  </p>
                  <MiniHistogram dailyCosts={data.dailyCosts} />
                </div>
              )}

              {/* Top 5 breakdown */}
              {top5.length > 0 && (
                <div className="rounded-xl border border-border bg-bg-secondary/50 px-5 py-4">
                  <p className="mb-3 text-xs font-medium uppercase tracking-wider text-text-muted">
                    Top 5 Sub-Items
                  </p>
                  <div className="flex flex-col gap-2">
                    {top5.map((item) => (
                      <div key={item.name} className="flex items-center justify-between gap-3 text-sm">
                        <span className="truncate text-text-secondary" title={item.name}>
                          {item.name}
                        </span>
                        <span className="shrink-0 tabular-nums text-text-primary">
                          {formatDollars(item.cost)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Actions */}
        <div className="flex gap-2 border-t border-border px-5 py-4">
          <button
            type="button"
            onClick={() => { onSetFilter(entity, dimension); }}
            className="flex-1 rounded-lg border border-border bg-bg-tertiary/50 px-3 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
          >
            Set as filter
          </button>
          <button
            type="button"
            onClick={() => { onOpenDetail(entity, dimension); }}
            className="flex-1 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover"
          >
            Open full view
          </button>
        </div>
      </div>
    </>
  );
}
