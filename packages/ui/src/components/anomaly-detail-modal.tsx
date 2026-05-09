import type { AnomalyDetailResult } from '@costgoblin/core/browser';
import { asAnomalyId, asEntityRef, asDateString } from '@costgoblin/core/browser';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { formatDollars, formatPercent, formatDate } from './format.js';
import { AnomalyBadge } from './anomaly-badge.js';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from './ui/dialog.js';

export interface AnomalyDetailModalProps {
  anomalyId: string;
  entity: string;
  service: string;
  detectedDate: string;
  lookbackDays: number;
  isOpen: boolean;
  onClose: () => void;
  onDismiss: (anomalyId: string) => void;
}

function MiniHistogram({
  dailyCosts,
}: Readonly<{ dailyCosts: AnomalyDetailResult['dailyCosts'] }>) {
  const last14 = dailyCosts.slice(-14);
  const max = last14.reduce((m, d) => Math.max(m, d.cost), 0);

  return (
    <div className="flex items-end gap-0.5" style={{ height: '64px' }}>
      {last14.map((day) => {
        const heightPct = max > 0 ? (day.cost / max) * 100 : 0;
        const isAnomalyDay = day.isAnomaly;
        return (
          <div
            key={day.date}
            className="group relative flex flex-1 flex-col items-center justify-end"
            style={{ height: '100%' }}
          >
            <div
              className={`w-full rounded-t-sm transition-colors ${
                isAnomalyDay
                  ? 'bg-negative group-hover:bg-negative-hover'
                  : 'bg-accent group-hover:bg-accent-hover'
              }`}
              style={{ height: `${String(heightPct)}%`, minHeight: heightPct > 0 ? '2px' : '0' }}
              title={`${formatDate(day.date)}: ${formatDollars(day.cost)}${isAnomalyDay ? ' (anomaly)' : ''}`}
            />
          </div>
        );
      })}
    </div>
  );
}

export function AnomalyDetailModal({
  anomalyId,
  entity,
  service,
  detectedDate,
  lookbackDays,
  isOpen,
  onClose,
  onDismiss,
}: Readonly<AnomalyDetailModalProps>) {
  const api = useCostApi();

  const detailQuery = useQuery(
    () =>
      api.queryAnomalyDetail({
        anomalyId: asAnomalyId(anomalyId),
        entity: asEntityRef(entity),
        service,
        detectedDate: asDateString(detectedDate),
        lookbackDays,
      }),
    [anomalyId, entity, service, detectedDate, lookbackDays, api],
  );

  const data: AnomalyDetailResult | null =
    detailQuery.status === 'success' ? detailQuery.data : null;

  const anomaly = data?.anomaly ?? null;
  const top5Resources = data?.affectedResources.slice(0, 5) ?? [];

  const handleDismiss = () => {
    onDismiss(anomalyId);
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-2xl">
        {/* Header */}
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <DialogTitle className="text-lg font-semibold text-text-primary">
                {entity}
              </DialogTitle>
              {anomaly !== null && <AnomalyBadge severity={anomaly.severity} />}
            </div>
            <DialogDescription className="mt-1 text-sm text-text-secondary">
              {service} · Detected on {formatDate(detectedDate)}
            </DialogDescription>
          </div>
        </div>

        {/* Body */}
        <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto">
          {detailQuery.status === 'loading' && (
            <p className="text-sm text-text-secondary">Loading anomaly details…</p>
          )}
          {detailQuery.status === 'error' && (
            <div className="rounded-lg border border-negative bg-negative-muted px-4 py-3 text-sm text-negative">
              {detailQuery.error.message}
            </div>
          )}

          {data !== null && anomaly !== null && (
            <>
              {/* Key Metrics */}
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-3">
                  <p className="text-xs font-medium uppercase tracking-wider text-text-muted">
                    Current Cost
                  </p>
                  <p className="mt-1.5 text-xl font-semibold tabular-nums text-text-primary">
                    {formatDollars(anomaly.currentCost)}
                  </p>
                </div>

                <div className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-3">
                  <p className="text-xs font-medium uppercase tracking-wider text-text-muted">
                    Expected Cost
                  </p>
                  <p className="mt-1.5 text-xl font-semibold tabular-nums text-text-secondary">
                    {formatDollars(anomaly.expectedCost)}
                  </p>
                </div>

                <div className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-3">
                  <p className="text-xs font-medium uppercase tracking-wider text-text-muted">
                    Increase
                  </p>
                  <p className="mt-1.5 text-xl font-semibold tabular-nums text-negative">
                    {formatPercent(anomaly.percentIncrease)}
                  </p>
                </div>

                <div className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-3">
                  <p className="text-xs font-medium uppercase tracking-wider text-text-muted">
                    Deviation
                  </p>
                  <p className="mt-1.5 text-xl font-semibold tabular-nums text-text-primary">
                    {anomaly.deviation.toFixed(1)}σ
                  </p>
                </div>
              </div>

              {/* Statistical Context */}
              <div className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-3">
                <p className="mb-2 text-xs font-medium uppercase tracking-wider text-text-muted">
                  Baseline Statistics ({lookbackDays}-day average)
                </p>
                <div className="flex gap-6 text-sm">
                  <div>
                    <span className="text-text-muted">Rolling Avg:</span>{' '}
                    <span className="tabular-nums text-text-primary">
                      {formatDollars(data.rollingAverage)}
                    </span>
                  </div>
                  <div>
                    <span className="text-text-muted">Std Dev:</span>{' '}
                    <span className="tabular-nums text-text-primary">
                      {formatDollars(data.standardDeviation)}
                    </span>
                  </div>
                </div>
              </div>

              {/* Daily Cost Trend */}
              {data.dailyCosts.length > 0 && (
                <div className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-3">
                  <p className="mb-3 text-xs font-medium uppercase tracking-wider text-text-muted">
                    Daily Trend — Last 14 Days
                  </p>
                  <MiniHistogram dailyCosts={data.dailyCosts} />
                  <div className="mt-2 flex items-center gap-4 text-xs text-text-muted">
                    <div className="flex items-center gap-1.5">
                      <div className="h-2 w-2 rounded-sm bg-accent" />
                      <span>Normal</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <div className="h-2 w-2 rounded-sm bg-negative" />
                      <span>Anomaly</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Affected Resources */}
              {top5Resources.length > 0 && (
                <div className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-3">
                  <p className="mb-3 text-xs font-medium uppercase tracking-wider text-text-muted">
                    Top 5 Affected Resources
                  </p>
                  <div className="flex flex-col gap-2">
                    {top5Resources.map((resource) => (
                      <div
                        key={resource.resourceId}
                        className="flex items-center justify-between gap-3 text-sm"
                      >
                        <span className="truncate font-mono text-xs text-text-secondary" title={resource.resourceId}>
                          {resource.resourceId}
                        </span>
                        <span className="shrink-0 tabular-nums text-text-primary">
                          {formatDollars(resource.cost)}
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
        <div className="mt-4 flex gap-2 border-t border-border pt-4">
          <button
            type="button"
            onClick={handleDismiss}
            disabled={detailQuery.status === 'loading'}
            className="flex-1 rounded-lg border border-border bg-bg-tertiary/50 px-3 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            Dismiss anomaly
          </button>
          <DialogClose asChild>
            <button
              type="button"
              className="flex-1 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover"
            >
              Close
            </button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}
