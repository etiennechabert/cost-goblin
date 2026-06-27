import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import type { BaselineDetail, BaselineDailyPoint, BaselineTriageStatus, BaselineUpdatePatch, ManualBand } from '@costgoblin/core/browser';
import { asDateString, asDollars, BASELINE_TRIAGE_STATUSES } from '@costgoblin/core/browser';

const TRIAGE_LABEL: Readonly<Record<BaselineTriageStatus, string>> = {
  'new': 'New', 'interesting': 'Interesting', 'confirmed': 'Confirmed',
  'in-progress': 'In Progress', 'false-positive': 'False Positive', 'auto-ignored': 'Auto-Ignored',
};

/** "Negative" outcomes — picking one auto-advances to the next case so you can
 *  sweep a review list quickly. */
const DISMISS_STATUSES = new Set<BaselineTriageStatus>(['false-positive', 'auto-ignored']);

function triageChipClass(status: BaselineTriageStatus): string {
  switch (status) {
    case 'interesting': return 'text-warning bg-warning/10 border-warning/30';
    case 'confirmed': return 'text-positive bg-positive/10 border-positive/30';
    case 'new': case 'in-progress': return 'text-accent bg-accent/10 border-accent/30';
    default: return 'text-text-muted bg-bg-tertiary/30 border-border';
  }
}
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog.js';
import { Slider } from './ui/slider.js';
import { CoinRainLoader } from './coin-rain-loader.js';
import { formatDollars, formatRelativeTime } from './format.js';

const CHART_W = 760;
const CHART_H = 240;
const PAD = { top: 12, right: 16, bottom: 22, left: 56 };

function percentile(values: readonly number[], p: number, excludeZero: boolean): number {
  const filtered = (excludeZero ? values.filter((v) => v > 0) : values).slice().sort((a, b) => a - b);
  if (filtered.length === 0) return 0;
  if (filtered.length === 1) return filtered[0] ?? 0;
  const rank = (Math.min(100, Math.max(0, p)) / 100) * (filtered.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const loV = filtered[lo] ?? 0;
  if (lo === hi) return loV;
  return loV + ((filtered[hi] ?? 0) - loV) * (rank - lo);
}

function movingAverage(points: readonly BaselineDailyPoint[], window: number): number[] {
  return points.map((_, i) => {
    const slice = points.slice(Math.max(0, i - window + 1), i + 1);
    return slice.reduce((s, p) => s + p.cost, 0) / Math.max(1, slice.length);
  });
}

/** Fill calendar gaps so the chart's X-axis is day-accurate. The stored series
 *  is sparse (discovery emits no row for a $0 day); zero-fill every missing day
 *  between the first and last point so month ticks land correctly. */
function densifyDaily(history: readonly BaselineDailyPoint[]): readonly BaselineDailyPoint[] {
  if (history.length === 0) return history;
  const byDate = new Map<string, number>();
  for (const p of history) byDate.set(String(p.date), p.cost);
  const dates = [...byDate.keys()].sort();
  const startStr = dates[0];
  const endStr = dates[dates.length - 1];
  if (startStr === undefined || endStr === undefined) return history;
  const out: BaselineDailyPoint[] = [];
  const cur = new Date(`${startStr}T00:00:00Z`);
  const end = new Date(`${endStr}T00:00:00Z`);
  for (let guard = 0; cur.getTime() <= end.getTime() && guard < 4000; guard++) {
    const key = cur.toISOString().slice(0, 10);
    out.push({ date: asDateString(key), cost: asDollars(byDate.get(key) ?? 0) });
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function monthAbbr(dateStr: string): string { return MONTHS[Number(dateStr.slice(5, 7)) - 1] ?? ''; }
function fullDate(dateStr: string): string {
  return `${monthAbbr(dateStr)} ${String(Number(dateStr.slice(8, 10)))}, ${dateStr.slice(0, 4)}`;
}

/** Daily-cost bars + 30-day moving-average line over a fixed window, with month
 *  X-axis ticks, $ Y-axis gridlines, effective band reference lines, and a hover
 *  tooltip showing the date, that day's cost, and the rolling average. */
function HistoryChart({ history, ma, lower, upper, maxCost }: Readonly<{
  history: readonly BaselineDailyPoint[]; ma: readonly number[]; lower: number; upper: number; maxCost: number;
}>) {
  const [hover, setHover] = useState<number | null>(null);
  const innerW = CHART_W - PAD.left - PAD.right;
  const innerH = CHART_H - PAD.top - PAD.bottom;
  const n = history.length;
  const x = (i: number): number => PAD.left + (n <= 1 ? 0 : (i / (n - 1)) * innerW);
  const y = (v: number): number => PAD.top + innerH - (Math.min(Math.max(v, 0), maxCost) / maxCost) * innerH;
  const barW = n > 0 ? Math.max(1, innerW / n - 0.5) : 1;

  const monthTicks = useMemo(() => {
    const ticks: { i: number; label: string }[] = [];
    let prev = '';
    history.forEach((p, i) => {
      const mm = p.date.slice(0, 7);
      if (mm !== prev) { ticks.push({ i, label: monthAbbr(p.date) }); prev = mm; }
    });
    return ticks;
  }, [history]);

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * maxCost);

  function onMove(e: MouseEvent<SVGSVGElement>): void {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width === 0 || n === 0) return;
    const viewX = ((e.clientX - rect.left) / rect.width) * CHART_W;
    const frac = Math.min(1, Math.max(0, (viewX - PAD.left) / innerW));
    setHover(Math.min(n - 1, Math.max(0, Math.round(frac * (n - 1)))));
  }

  const hp = hover !== null ? history[hover] : undefined;
  const leftPct = hover !== null ? (x(hover) / CHART_W) * 100 : 0;

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${String(CHART_W)} ${String(CHART_H)}`} className="w-full rounded-lg border border-border bg-bg-tertiary/20"
        role="img" aria-label="Daily cost history" onMouseMove={onMove} onMouseLeave={() => { setHover(null); }}>
        {yTicks.map((v) => (
          <g key={String(v)}>
            <line x1={PAD.left} x2={CHART_W - PAD.right} y1={y(v)} y2={y(v)} className="stroke-border/40" strokeWidth={0.5} />
            <text x={PAD.left - 6} y={y(v) + 3} textAnchor="end" className="fill-text-muted text-[9px]">{formatDollars(v)}</text>
          </g>
        ))}
        <rect x={PAD.left} y={y(upper)} width={innerW} height={Math.max(0, y(lower) - y(upper))} className="fill-accent/10" />
        {history.map((p, i) => (
          <rect key={String(p.date)} x={x(i) - barW / 2} y={y(p.cost)} width={barW} height={Math.max(0, PAD.top + innerH - y(p.cost))} className="fill-text-muted/40" />
        ))}
        <polyline fill="none" className="stroke-accent" strokeWidth={1.5} points={ma.map((v, i) => `${String(x(i))},${String(y(v))}`).join(' ')} />
        <line x1={PAD.left} x2={CHART_W - PAD.right} y1={y(lower)} y2={y(lower)} className="stroke-positive" strokeWidth={1} strokeDasharray="4 3" />
        <line x1={PAD.left} x2={CHART_W - PAD.right} y1={y(upper)} y2={y(upper)} className="stroke-negative" strokeWidth={1} strokeDasharray="4 3" />
        <text x={CHART_W - PAD.right} y={y(upper) - 2} textAnchor="end" className="fill-negative text-[9px]">{formatDollars(upper)}</text>
        <text x={CHART_W - PAD.right} y={y(lower) + 9} textAnchor="end" className="fill-positive text-[9px]">{formatDollars(lower)}</text>
        {monthTicks.map((t) => (
          <text key={t.i} x={x(t.i)} y={CHART_H - 6} textAnchor="middle" className="fill-text-muted text-[9px]">{t.label}</text>
        ))}
        {hover !== null && hp !== undefined && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + innerH} className="stroke-text-secondary/50" strokeWidth={0.75} />
            <circle cx={x(hover)} cy={y(hp.cost)} r={2.5} className="fill-text-primary" />
            <circle cx={x(hover)} cy={y(ma[hover] ?? 0)} r={2.5} className="fill-accent" />
          </g>
        )}
      </svg>
      {hover !== null && hp !== undefined && (
        <div className="pointer-events-none absolute top-1 z-10 -translate-x-1/2 rounded-md border border-border bg-bg-primary/95 px-2 py-1 text-[10px] shadow-lg"
          style={{ left: `${String(Math.min(88, Math.max(12, leftPct)))}%` }}>
          <p className="font-medium text-text-primary">{fullDate(hp.date)}</p>
          <p className="tabular-nums text-text-secondary">cost {formatDollars(hp.cost)}/day</p>
          <p className="tabular-nums text-text-muted">30-day avg {formatDollars(ma[hover] ?? 0)}/day</p>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, perDay, accent }: Readonly<{ label: string; perDay: number; accent?: 'amber' | 'green' | undefined }>) {
  const color = accent === 'amber' && perDay > 0 ? 'text-warning' : accent === 'green' && perDay > 0 ? 'text-positive' : 'text-text-primary';
  return (
    <div className="rounded-lg border border-border bg-bg-tertiary/30 px-3 py-2">
      <p className="text-[10px] uppercase tracking-wider text-text-muted">{label}</p>
      <p className={`text-sm font-medium tabular-nums ${color}`}>{formatDollars(perDay)}<span className="text-text-muted text-xs">/day</span></p>
      <p className="text-xs text-text-muted tabular-nums">{formatDollars(perDay * 30)}/mo</p>
    </div>
  );
}

export interface BaselineDetailModalProps {
  readonly id: string;
  readonly onClose: () => void;
  readonly onChanged: () => void;
  /** Advance/retreat within a review session, if there's a next/prev baseline. */
  readonly onNext?: (() => void) | undefined;
  readonly onPrev?: (() => void) | undefined;
  /** 1-based position in the current list, for the "n / total" indicator. */
  readonly position?: { readonly index: number; readonly total: number } | undefined;
}

export function BaselineDetailModal({ id, onClose, onChanged, onNext, onPrev, position }: Readonly<BaselineDetailModalProps>) {
  const api = useCostApi();
  const [refresh, setRefresh] = useState(0);
  const detailQuery = useQuery(() => api.getBaseline(id), [api, id, refresh]);
  const detail: BaselineDetail | null = detailQuery.status === 'success' ? detailQuery.data : null;

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-4xl">
        {detailQuery.status === 'loading' && <CoinRainLoader height={300} count={6} />}
        {detail === null && detailQuery.status === 'success' && (
          <p className="text-sm text-text-muted">Baseline not found.</p>
        )}
        {detail !== null && (
          <Body key={detail.record.spec.id} detail={detail} onChanged={() => { setRefresh((n) => n + 1); onChanged(); }}
            onNext={onNext} onPrev={onPrev} position={position} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function Body({ detail, onChanged, onNext, onPrev, position }: Readonly<{
  detail: BaselineDetail; onChanged: () => void;
  onNext?: (() => void) | undefined; onPrev?: (() => void) | undefined;
  position?: { readonly index: number; readonly total: number } | undefined;
}>) {
  const api = useCostApi();
  const { record, dailyHistory } = detail;
  const costs = useMemo(() => dailyHistory.map((p) => p.cost), [dailyHistory]);
  const autoLower = record.effectiveLower;
  const autoUpper = record.effectiveUpper;

  const [mode, setMode] = useState<'absolute' | 'percentile'>(record.spec.manualBand?.mode ?? 'absolute');
  const [lower, setLower] = useState<number>(record.spec.manualBand?.lower ?? (mode === 'percentile' ? 10 : autoLower));
  const [upper, setUpper] = useState<number>(record.spec.manualBand?.upper ?? (mode === 'percentile' ? 90 : autoUpper));
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [triage, setTriage] = useState<BaselineTriageStatus>(record.triageStatus);
  const [bandDirty, setBandDirty] = useState(false);

  const dirty = bandDirty || note.length > 0;

  const maxCost = Math.max(...costs, autoUpper, 1);
  const effLower = mode === 'percentile' ? percentile(costs, lower, true) : lower;
  // Clamp upper ≥ lower to mirror the server (savings.ts). In percentile mode the
  // lower edge excludes $0 days while the upper includes them, so for a mostly-idle
  // scope the raw upper can fall below lower and invert the band preview.
  const effUpper = Math.max(effLower, mode === 'percentile' ? percentile(costs, upper, false) : upper);
  const current = record.currentDaily;
  // Fixed/periodic charges (e.g. a monthly subscription billed on one day) have
  // no daily savings lever — the server forces $0, so mirror that in the preview.
  const potential = record.isPeriodic ? 0 : Math.max(0, current - effLower);
  const realized = record.isPeriodic ? 0 : Math.max(0, effUpper - current);

  // Sparse series drives the band-percentile preview (matches the server's
  // band math); the dense series drives the chart so the date axis is accurate.
  const dense = useMemo(() => densifyDaily(dailyHistory), [dailyHistory]);
  const ma = useMemo(() => movingAverage(dense, 30), [dense]);

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);
    // Only send what actually changed — so a status/note edit doesn't silently
    // pin a manual band equal to the current automated one.
    const manualBand: ManualBand = { mode, lower, upper };
    const patch: BaselineUpdatePatch = {
      ...(bandDirty ? { manualBand } : {}),
      ...(note.length > 0 ? { note: { text: note } } : {}),
    };
    try {
      await api.updateBaseline(record.spec.id, patch);
      setNote('');
      setBandDirty(false);
      onChanged();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function resetAuto(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      await api.updateBaseline(record.spec.id, { manualBand: null, note: { text: 'Reset to automated band' } });
      onChanged();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  // Quick triage: assign + persist a status immediately (no note needed). For a
  // "negative" outcome, auto-advance to the next case so you can sweep a list.
  async function assignStatus(status: BaselineTriageStatus): Promise<void> {
    const prev = triage;
    setTriage(status); // optimistic
    setSaving(true);
    setError(null);
    try {
      await api.updateBaseline(record.spec.id, { triageStatus: status });
      onChanged();
      if (DISMISS_STATUSES.has(status) && onNext) onNext();
    } catch (err: unknown) {
      setTriage(prev); // revert the optimistic highlight on failure
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  // Keep the highlighted status in sync if the record changes underneath us
  // (refetch after save, or a concurrent/external update).
  useEffect(() => { setTriage(record.triageStatus); }, [record.triageStatus]);

  // Keyboard-driven review: 1–6 assign a status; ←/→ (or p/n) move between cases.
  // No deps array is intentional — rebinding each render keeps onKey's closures
  // (onNext/onPrev/assignStatus) fresh, so navigation never targets a stale list.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const el = document.activeElement;
      if (
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLInputElement ||
        el instanceof HTMLSelectElement ||
        // The band-override slider thumb is a focusable <span role="slider"> that
        // handles its own Arrow keys — don't hijack them to navigate baselines.
        (el instanceof HTMLElement && (el.isContentEditable || el.getAttribute('role') === 'slider'))
      ) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= BASELINE_TRIAGE_STATUSES.length) {
        const status = BASELINE_TRIAGE_STATUSES[n - 1];
        if (status !== undefined) { e.preventDefault(); void assignStatus(status); }
        return;
      }
      if ((e.key === 'ArrowRight' || e.key === 'n') && onNext !== undefined) { e.preventDefault(); onNext(); }
      else if ((e.key === 'ArrowLeft' || e.key === 'p') && onPrev !== undefined) { e.preventDefault(); onPrev(); }
    }
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <DialogTitle className="text-base">{record.spec.name ?? record.scopeLabel}</DialogTitle>
          <p className="text-xs text-text-muted">{record.scopeLabel} · {record.spec.source} · drift: {record.status}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {position !== undefined && (
            <div className="flex items-center gap-1 text-xs text-text-muted">
              <button type="button" disabled={onPrev === undefined} onClick={() => { onPrev?.(); }} className="rounded px-1.5 py-0.5 hover:bg-bg-tertiary disabled:opacity-30" aria-label="Previous baseline (←)">←</button>
              <span className="tabular-nums">{String(position.index + 1)} / {String(position.total)}</span>
              <button type="button" disabled={onNext === undefined} onClick={() => { onNext?.(); }} className="rounded px-1.5 py-0.5 hover:bg-bg-tertiary disabled:opacity-30" aria-label="Next baseline (→)">→</button>
            </div>
          )}
          <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${triageChipClass(record.triageStatus)}`}>{TRIAGE_LABEL[record.triageStatus]}</span>
        </div>
      </div>

      {record.isPeriodic && (
        <div className="rounded-lg border border-border bg-bg-tertiary/30 px-3 py-2 text-[11px] text-text-secondary">
          <span className="font-medium text-text-primary">Fixed recurring charge.</span> This scope bills on a few days at a near-constant amount (e.g. a monthly subscription), so a per-day band is meaningless and potential/realized savings are excluded.
        </div>
      )}

      <HistoryChart history={dense} ma={ma} lower={effLower} upper={effUpper} maxCost={maxCost} />
      <p className="-mt-2 text-[10px] text-text-muted">Daily cost (bars) · 30-day average (line) · band low (green) / high (red). Hover for details.</p>

      <div className="grid grid-cols-4 gap-2">
        <StatCard label="Current" perDay={current} />
        <StatCard label="Band low / high" perDay={effLower} />
        <StatCard label="Potential" perDay={potential} accent="amber" />
        <StatCard label="Realized" perDay={realized} accent="green" />
      </div>

      <div className="rounded-lg border border-border bg-bg-secondary/40 p-3 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-text-secondary">Band override</p>
          <div className="flex gap-1">
            {(['absolute', 'percentile'] as const).map((m) => (
              <button key={m} type="button" onClick={() => { setMode(m); setLower(m === 'percentile' ? 10 : Math.min(autoLower, autoUpper)); setUpper(m === 'percentile' ? 90 : Math.max(autoLower, autoUpper)); setBandDirty(true); }}
                className={`rounded-md px-2 py-0.5 text-[11px] ${mode === m ? 'bg-accent/15 text-accent' : 'text-text-muted hover:text-text-primary'}`}>
                {m === 'absolute' ? 'Absolute $' : 'Percentile'}
              </button>
            ))}
          </div>
        </div>
        <Slider
          min={0}
          max={mode === 'percentile' ? 100 : Math.ceil(maxCost)}
          step={mode === 'percentile' ? 1 : Math.max(0.01, maxCost / 200)}
          value={[lower, upper]}
          onValueChange={(v) => { const [lo, hi] = v; if (lo !== undefined) setLower(lo); if (hi !== undefined) setUpper(hi); setBandDirty(true); }}
        />
        <div className="flex items-center justify-between text-xs tabular-nums text-text-muted">
          <span>lower {mode === 'percentile' ? `P${String(Math.round(lower))} (${formatDollars(effLower)})` : formatDollars(lower)}</span>
          <span>upper {mode === 'percentile' ? `P${String(Math.round(upper))} (${formatDollars(effUpper)})` : formatDollars(upper)}</span>
        </div>
        <textarea value={note} onChange={(e) => { setNote(e.target.value); }} placeholder="Add a note (optional)…"
          className="w-full rounded-md border border-border bg-bg-primary px-2 py-1 text-xs text-text-primary placeholder:text-text-muted" rows={2} />
        {error !== null && <p className="text-xs text-negative">{error}</p>}
        <div className="flex gap-2">
          <button type="button" disabled={saving || !dirty} onClick={() => { void save(); }} className="rounded-md bg-accent/15 px-3 py-1 text-xs font-medium text-accent hover:bg-accent/25 disabled:opacity-50">Save changes</button>
          {record.spec.manualBand !== undefined && (
            <button type="button" disabled={saving} onClick={() => { void resetAuto(); }} className="rounded-md border border-border px-3 py-1 text-xs text-text-secondary hover:text-text-primary disabled:opacity-50">Reset to automated</button>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-border bg-bg-secondary/40 p-3 flex flex-col gap-2">
        <p className="text-xs font-medium text-text-secondary">
          Triage status <span className="font-normal text-text-muted">— press 1–6 to set; ← / → to move between baselines{onNext !== undefined ? ' (False Positive / Auto-Ignored auto-advance)' : ''}</span>
        </p>
        <div className="flex flex-wrap gap-1.5">
          {BASELINE_TRIAGE_STATUSES.map((s, i) => (
            <button key={s} type="button" disabled={saving} onClick={() => { void assignStatus(s); }}
              className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors disabled:opacity-50 ${triage === s ? `${triageChipClass(s)} ring-1 ring-inset ring-current` : 'border-border text-text-secondary hover:text-text-primary'}`}>
              <kbd className="rounded bg-bg-tertiary px-1 text-[9px] font-medium text-text-muted">{String(i + 1)}</kbd>
              {TRIAGE_LABEL[s]}
            </button>
          ))}
        </div>
      </div>

      {record.triage.notes.length > 0 && (
        <div className="rounded-lg border border-border bg-bg-secondary/40 p-3">
          <p className="text-xs font-medium text-text-secondary mb-2">Activity</p>
          <ul className="flex flex-col gap-2">
            {record.triage.notes.slice().reverse().map((n, i) => (
              <li key={`${n.at}-${String(i)}`} className="text-xs text-text-secondary">
                <span className="text-text-muted">{formatRelativeTime(n.at)} · </span>
                {n.statusChange !== undefined && <span className="text-accent">[{TRIAGE_LABEL[n.statusChange.from]} → {TRIAGE_LABEL[n.statusChange.to]}] </span>}
                {n.text}
                {n.ticket !== undefined && <span className="text-text-muted"> ({n.ticket})</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
