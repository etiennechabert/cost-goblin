import type { WidgetCommonProps } from './widget.js';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { formatDollars } from '../components/format.js';
import { BaselineMicroBar } from '../components/baseline-micro-bar.js';

/** Compact, non-paginated table of the top baselines by potential savings, for
 *  dropping into a custom View or an entity-detail page. */
export function BaselineWidget({ spec }: WidgetCommonProps) {
  const api = useCostApi();
  const topN = spec.type === 'baseline' && spec.topN !== undefined ? spec.topN : 8;
  const query = useQuery(() => api.listBaselines({ sortBy: 'potential', sortDir: 'desc', limit: topN }), [api, topN]);
  const items = query.status === 'success' ? query.data.items : [];

  if (query.status === 'loading') return <div className="p-4 text-xs text-text-muted">Loading baselines…</div>;
  if (query.status === 'error') return <div className="p-4 text-xs text-negative">{query.error.message}</div>;
  if (items.length === 0) return <div className="p-4 text-xs text-text-muted">No baselines yet — recompute on the Baselines page.</div>;

  return (
    <div className="flex flex-col divide-y divide-border-subtle">
      {items.map((r) => (
        <div key={r.spec.id} className="flex items-center gap-3 px-3 py-1.5 text-xs">
          <span className="flex-1 truncate text-text-secondary" title={r.scopeLabel}>{r.spec.name ?? r.scopeLabel}</span>
          <BaselineMicroBar lower={r.effectiveLower} upper={r.effectiveUpper} current={r.currentDaily} status={r.status} />
          <span className={`w-20 text-right tabular-nums ${r.savings.potentialMonthly > 0 ? 'text-warning' : 'text-text-muted'}`}>{formatDollars(r.savings.potentialMonthly)}/mo</span>
        </div>
      ))}
    </div>
  );
}
