import type { RollupStatus, RollupStats } from '@costgoblin/core/browser';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function formatRatio(ratio: number): string {
  return ratio >= 10 ? ratio.toFixed(0) : ratio.toFixed(1);
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatMonth(period: string): string {
  const [year, month] = period.split('-');
  const name = MONTH_NAMES[Number(month) - 1] ?? month ?? period;
  const yy = (year ?? '').slice(2);
  return yy === '' ? name : `${name} '${yy}`;
}

type ChipState = 'done' | 'building' | 'pending';

function chipClass(state: ChipState, highlighted: boolean): string {
  const base = `rounded border px-1.5 py-0.5 text-[10px] tabular-nums${highlighted ? ' ring-1 ring-accent/60' : ''}`;
  switch (state) {
    // `building` is the brighter, pulsing variant — it's the only moving thing
    // in the popover during a parallel batch, where `done` can sit at 0 for
    // several seconds while builds run concurrently.
    case 'building': return `${base} border-accent bg-accent/25 text-accent animate-pulse`;
    case 'done': return `${base} border-accent/30 bg-accent/15 text-accent`;
    case 'pending': return `${base} border-border bg-bg-tertiary/40 text-text-muted`;
  }
}

const CHIP_TITLE: Record<ChipState, string> = { done: 'Rebuilt', building: 'Building…', pending: 'Pending' };

function chipState(period: string, index: number, done: number, active: readonly string[]): ChipState {
  if (index < done) return 'done';
  if (active.includes(period)) return 'building';
  return 'pending';
}

function KpiRow({ label, value, accent }: Readonly<{ label: string; value: string; accent?: boolean }>): React.JSX.Element {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-text-muted">{label}</span>
      <span className={accent === true ? 'font-medium tabular-nums text-accent' : 'tabular-nums text-text-secondary'}>{value}</span>
    </div>
  );
}

interface Props {
  readonly status: RollupStatus;
  /** Size KPIs for the `ready` body. Omit (or null) to skip those rows — the
   *  building overlay doesn't need them. */
  readonly stats?: RollupStats | null;
  /** Months to emphasise (e.g. the ones the user is currently viewing) — drawn
   *  with an accent ring so the user can spot their period in the batch. */
  readonly highlight?: readonly string[];
}

/** Presentational rollup status body, shared by the header popover and the
 *  full-view "building" overlay so both surfaces stay in sync. Renders the
 *  progress bar + per-period chips while `computing`, size KPIs when `ready`,
 *  and a short explanation otherwise. */
export function RollupStatusDetail({ status, stats = null, highlight }: Props): React.JSX.Element {
  const highlightSet = new Set(highlight ?? []);
  const pct = status.state === 'computing' && status.total > 0
    ? Math.round((status.done / status.total) * 100)
    : 0;

  if (status.state === 'computing') {
    return (
      <div className="space-y-2">
        <p className="text-xs text-text-secondary">Rebuilding the pre-aggregated rollup. Dashboards read raw data until it finishes.</p>
        {status.total > 0 && (
          <>
            <div className="h-1.5 overflow-hidden rounded-full bg-bg-tertiary">
              <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${String(pct)}%` }} />
            </div>
            <p className="text-[11px] tabular-nums text-text-muted">{String(status.done)} / {String(status.total)} months</p>
          </>
        )}
        {status.periods.length > 0 && (
          <div className="flex max-h-24 flex-wrap gap-1 overflow-y-auto">
            {status.periods.map((p, i) => {
              const state = chipState(p, i, status.done, status.active);
              return (
                <span key={p} className={chipClass(state, highlightSet.has(p))} title={CHIP_TITLE[state]}>
                  {formatMonth(p)}
                </span>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  if (status.state === 'ready') {
    return (
      <div className="space-y-2">
        <p className="text-xs text-text-secondary">Dashboards are served from the pre-aggregated rollup.</p>
        <div className="divide-y divide-border-subtle text-xs">
          <KpiRow label="Months built" value={String(status.periods)} />
          {stats !== null && (
            <KpiRow label="Rollup size" value={`${formatBytes(stats.rollupBytes)} · ${formatCount(stats.rollupRows)} rows`} />
          )}
          {stats !== null && stats.rawBytes > 0 && (
            <KpiRow label="Raw (daily)" value={formatBytes(stats.rawBytes)} />
          )}
          {stats !== null && stats.rawBytes > 0 && stats.rollupBytes > 0 && (
            <KpiRow label="Compression" value={`${formatRatio(stats.rawBytes / stats.rollupBytes)}× smaller`} accent />
          )}
        </div>
      </div>
    );
  }

  if (status.state === 'failed') {
    return (
      <div className="space-y-1.5">
        <p className="text-xs text-negative">{status.message}</p>
        <div className="rounded border border-border bg-bg-tertiary/40 p-1.5">
          <p className="text-[10px] font-medium uppercase tracking-wide text-text-muted">Error</p>
          <p className="mt-0.5 max-h-28 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-snug text-text-secondary">{status.reason}</p>
        </div>
        <p className="text-[11px] text-text-muted">Dashboards fall back to raw data. Reload data or re-save dimensions to retry.</p>
      </div>
    );
  }

  return <p className="text-xs text-text-secondary">No rollup is built yet. Dashboards query the raw data directly.</p>;
}
