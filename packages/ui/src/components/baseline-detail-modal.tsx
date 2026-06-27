import { useMemo, useState } from 'react';
import type { BaselineDetail, BaselineDailyPoint, ManualBand } from '@costgoblin/core/browser';
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

export function BaselineDetailModal({ id, onClose, onChanged }: Readonly<{ id: string; onClose: () => void; onChanged: () => void }>) {
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
        {detail !== null && <Body detail={detail} onChanged={() => { setRefresh((n) => n + 1); onChanged(); }} />}
      </DialogContent>
    </Dialog>
  );
}

function Body({ detail, onChanged }: Readonly<{ detail: BaselineDetail; onChanged: () => void }>) {
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

  const maxCost = Math.max(...costs, autoUpper, 1);
  const effLower = mode === 'percentile' ? percentile(costs, lower, true) : lower;
  const effUpper = mode === 'percentile' ? percentile(costs, upper, false) : upper;
  const current = record.currentDaily;
  const potential = Math.max(0, current - effLower);
  const realized = Math.max(0, effUpper - current);

  const ma = useMemo(() => movingAverage(dailyHistory, 30), [dailyHistory]);
  const innerW = CHART_W - PAD.left - PAD.right;
  const innerH = CHART_H - PAD.top - PAD.bottom;
  const x = (i: number): number => PAD.left + (dailyHistory.length <= 1 ? 0 : (i / (dailyHistory.length - 1)) * innerW);
  const y = (v: number): number => PAD.top + innerH - (Math.min(v, maxCost) / maxCost) * innerH;
  const barW = dailyHistory.length > 0 ? Math.max(1, innerW / dailyHistory.length - 0.5) : 1;

  async function save(): Promise<void> {
    setSaving(true);
    const manualBand: ManualBand = { mode, lower, upper };
    await api.updateBaseline(record.spec.id, { manualBand, ...(note.length > 0 ? { note: { text: note } } : {}) }).catch(() => null);
    setSaving(false);
    setNote('');
    onChanged();
  }

  async function resetAuto(): Promise<void> {
    setSaving(true);
    await api.updateBaseline(record.spec.id, { manualBand: null, note: { text: 'Reset to automated band' } }).catch(() => null);
    setSaving(false);
    onChanged();
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <DialogTitle className="text-base">{record.spec.name ?? record.scopeLabel}</DialogTitle>
        <p className="text-xs text-text-muted">{record.scopeLabel} · {record.spec.source} · {record.status}</p>
      </div>

      <svg viewBox={`0 0 ${String(CHART_W)} ${String(CHART_H)}`} className="w-full rounded-lg border border-border bg-bg-tertiary/20" role="img" aria-label="Daily cost history">
        {/* shaded band */}
        <rect x={PAD.left} y={y(effUpper)} width={innerW} height={Math.max(0, y(effLower) - y(effUpper))} className="fill-accent/10" />
        {/* daily bars */}
        {dailyHistory.map((p, i) => (
          <rect key={String(p.date)} x={x(i) - barW / 2} y={y(p.cost)} width={barW} height={Math.max(0, PAD.top + innerH - y(p.cost))} className="fill-text-muted/40" />
        ))}
        {/* moving-average line */}
        <polyline
          fill="none"
          className="stroke-accent"
          strokeWidth={1.5}
          points={ma.map((v, i) => `${String(x(i))},${String(y(v))}`).join(' ')}
        />
        {/* band reference lines */}
        <line x1={PAD.left} x2={CHART_W - PAD.right} y1={y(effLower)} y2={y(effLower)} className="stroke-positive" strokeWidth={1} strokeDasharray="4 3" />
        <line x1={PAD.left} x2={CHART_W - PAD.right} y1={y(effUpper)} y2={y(effUpper)} className="stroke-negative" strokeWidth={1} strokeDasharray="4 3" />
        <text x={4} y={y(effUpper) + 3} className="fill-negative text-[9px]">{formatDollars(effUpper)}</text>
        <text x={4} y={y(effLower) + 3} className="fill-positive text-[9px]">{formatDollars(effLower)}</text>
      </svg>

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
              <button key={m} type="button" onClick={() => { setMode(m); setLower(m === 'percentile' ? 10 : autoLower); setUpper(m === 'percentile' ? 90 : autoUpper); }}
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
          onValueChange={(v) => { const [lo, hi] = v; if (lo !== undefined) setLower(lo); if (hi !== undefined) setUpper(hi); }}
        />
        <div className="flex items-center justify-between text-xs tabular-nums text-text-muted">
          <span>lower {mode === 'percentile' ? `P${String(Math.round(lower))} (${formatDollars(effLower)})` : formatDollars(lower)}</span>
          <span>upper {mode === 'percentile' ? `P${String(Math.round(upper))} (${formatDollars(effUpper)})` : formatDollars(upper)}</span>
        </div>
        <textarea value={note} onChange={(e) => { setNote(e.target.value); }} placeholder="Add a note (optional)…"
          className="w-full rounded-md border border-border bg-bg-primary px-2 py-1 text-xs text-text-primary placeholder:text-text-muted" rows={2} />
        <div className="flex gap-2">
          <button type="button" disabled={saving} onClick={() => { void save(); }} className="rounded-md bg-accent/15 px-3 py-1 text-xs font-medium text-accent hover:bg-accent/25 disabled:opacity-50">Save band + note</button>
          {record.spec.manualBand !== undefined && (
            <button type="button" disabled={saving} onClick={() => { void resetAuto(); }} className="rounded-md border border-border px-3 py-1 text-xs text-text-secondary hover:text-text-primary disabled:opacity-50">Reset to automated</button>
          )}
        </div>
      </div>

      {record.triage.notes.length > 0 && (
        <div className="rounded-lg border border-border bg-bg-secondary/40 p-3">
          <p className="text-xs font-medium text-text-secondary mb-2">Activity</p>
          <ul className="flex flex-col gap-2">
            {record.triage.notes.slice().reverse().map((n, i) => (
              <li key={`${n.at}-${String(i)}`} className="text-xs text-text-secondary">
                <span className="text-text-muted">{formatRelativeTime(n.at)} · </span>
                {n.statusChange !== undefined && <span className="text-accent">[{n.statusChange.from}→{n.statusChange.to}] </span>}
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
