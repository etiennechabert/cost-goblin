import type { Anomaly } from '@costgoblin/core/browser';
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
  readonly anomaly: Anomaly;
  readonly lookbackDays: number;
  readonly stddevThreshold: number;
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly onDismiss: () => void;
}

interface MiniHistogramProps {
  readonly dailyCosts: readonly { date: string; cost: number; isAnomaly: boolean }[];
}

function MiniHistogram({ dailyCosts }: MiniHistogramProps) {
  const last14 = dailyCosts.slice(-14);
  const max = last14.reduce((m, d) => Math.max(m, d.cost), 0);

  return (
    <div className="flex items-end gap-0.5" style={{ height: '64px' }}>
      {last14.map((day) => {
        const heightPct = max > 0 ? (day.cost / max) * 100 : 0;
        return (
          <div
            key={day.date}
            className="group relative flex flex-1 flex-col items-center justify-end"
            style={{ height: '100%' }}
          >
            <div
              className={`w-full rounded-t-sm transition-colors ${
                day.isAnomaly
                  ? 'bg-negative group-hover:bg-negative-hover'
                  : 'bg-accent group-hover:bg-accent-hover'
              }`}
              style={{ height: `${String(heightPct)}%`, minHeight: heightPct > 0 ? '2px' : '0' }}
              title={`${formatDate(day.date)}: ${formatDollars(day.cost)}${day.isAnomaly ? ' (anomaly)' : ''}`}
            />
          </div>
        );
      })}
    </div>
  );
}

export function AnomalyDetailModal({
  anomaly,
  lookbackDays,
  stddevThreshold,
  isOpen,
  onClose,
  onDismiss,
}: AnomalyDetailModalProps) {
  const api = useCostApi();

  const detailQuery = useQuery(
    () =>
      api.queryAnomalyDetail({
        anomalyId: anomaly.id,
        dimension: anomaly.dimension,
        entity: anomaly.entity,
        service: anomaly.service,
        detectedDate: anomaly.detectedDate,
        lookbackDays,
        stddevThreshold,
      }),
    [api, anomaly.id, anomaly.dimension, anomaly.entity, anomaly.service, anomaly.detectedDate, lookbackDays, stddevThreshold],
  );

  const handleDismiss = () => {
    onDismiss();
    onClose();
  };

  const data = detailQuery.status === 'success' ? detailQuery.data : null;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <DialogTitle className="text-lg font-semibold text-text-primary">
                {anomaly.entity}
              </DialogTitle>
              <AnomalyBadge severity={anomaly.severity} />
            </div>
            <DialogDescription className="mt-1 text-sm text-text-secondary">
              {anomaly.service} · Detected on {formatDate(anomaly.detectedDate)}
            </DialogDescription>
          </div>
        </div>

        <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto">
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-3">
              <p className="text-xs font-medium uppercase tracking-wider text-text-muted">Current Cost</p>
              <p className="mt-1.5 text-xl font-semibold tabular-nums text-text-primary">
                {formatDollars(anomaly.currentCost)}
              </p>
            </div>
            <div className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-3">
              <p className="text-xs font-medium uppercase tracking-wider text-text-muted">Expected Cost</p>
              <p className="mt-1.5 text-xl font-semibold tabular-nums text-text-secondary">
                {formatDollars(anomaly.expectedCost)}
              </p>
            </div>
            <div className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-3">
              <p className="text-xs font-medium uppercase tracking-wider text-text-muted">Increase</p>
              <p className="mt-1.5 text-xl font-semibold tabular-nums text-negative">
                {formatPercent(anomaly.percentIncrease)}
              </p>
            </div>
            <div className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-3">
              <p className="text-xs font-medium uppercase tracking-wider text-text-muted">Deviation</p>
              <p className="mt-1.5 text-xl font-semibold tabular-nums text-text-primary">
                {anomaly.deviation.toFixed(1)}σ
              </p>
            </div>
          </div>

          {detailQuery.status === 'loading' && (
            <p className="text-sm text-text-secondary">Loading daily trend…</p>
          )}
          {detailQuery.status === 'error' && (
            <div className="rounded-lg border border-negative bg-negative-muted px-4 py-3 text-sm text-negative">
              {detailQuery.error.message}
            </div>
          )}

          {data !== null && (
            <>
              <div className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-3">
                <p className="mb-2 text-xs font-medium uppercase tracking-wider text-text-muted">
                  Baseline Statistics ({lookbackDays}-day average)
                </p>
                <div className="flex gap-6 text-sm">
                  <div>
                    <span className="text-text-muted">Rolling Avg:</span>{' '}
                    <span className="tabular-nums text-text-primary">{formatDollars(data.rollingAverage)}</span>
                  </div>
                  <div>
                    <span className="text-text-muted">Std Dev:</span>{' '}
                    <span className="tabular-nums text-text-primary">{formatDollars(data.standardDeviation)}</span>
                  </div>
                </div>
              </div>

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
            </>
          )}
        </div>

        <div className="mt-4 flex gap-2 border-t border-border pt-4">
          <button
            type="button"
            onClick={handleDismiss}
            className="flex-1 rounded-lg border border-border bg-bg-tertiary/50 px-3 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
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
