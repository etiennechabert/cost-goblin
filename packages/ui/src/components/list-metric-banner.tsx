import { useEffect, useState } from 'react';
import type { CostMetric } from '@costgoblin/core/browser';
import { useCostApi } from '../hooks/use-cost-api.js';

export function ListMetricBanner(): React.JSX.Element | null {
  const api = useCostApi();
  const [metric, setMetric] = useState<CostMetric | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getCostScope().then(scope => {
      if (!cancelled) setMetric(scope.costMetric);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [api]);

  if (metric !== 'list') return null;

  return (
    <div className="flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
      <span aria-hidden="true" className="mt-0.5 text-warning">⚠</span>
      <div className="flex flex-col gap-0.5">
        <span className="font-medium text-text-primary">Showing list price &mdash; not money spent</span>
        <span className="text-text-secondary">
          The active cost metric is <strong className="text-text-primary">List price</strong>.
          Numbers reflect the hypothetical on-demand list price of usage rows &mdash; before negotiated
          and commitment discounts &mdash; and non-usage charges are excluded.
          Change in Cost Scope &rarr; Cost metric to see actual spend.
        </span>
      </div>
    </div>
  );
}
