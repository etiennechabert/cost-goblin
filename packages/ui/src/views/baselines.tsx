import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { SortingState } from '@tanstack/react-table';
import type { BaselineRecord, BaselineRecomputeStatus, BaselineTriageStatus, BaselinesListResult, DimensionsConfig } from '@costgoblin/core/browser';
import { asDimensionId, asTagValue } from '@costgoblin/core/browser';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { DataTable } from '../components/data-table.js';
import type { TableColumn } from '../lib/table-types.js';
import { CoinRainLoader } from '../components/coin-rain-loader.js';
import { formatDollars } from '../components/format.js';
import { BaselineMicroBar } from '../components/baseline-micro-bar.js';
import { BaselineDetailModal } from '../components/baseline-detail-modal.js';
import { Dialog, DialogContent, DialogTitle, DialogClose } from '../components/ui/dialog.js';

type TriageFilter = BaselineTriageStatus | 'open' | 'all';

const STATUS_FILTERS: readonly { id: TriageFilter; label: string }[] = [
  { id: 'open', label: 'Open' },
  { id: 'all', label: 'All' },
  { id: 'new', label: 'New' },
  { id: 'tracking', label: 'Tracking' },
  { id: 'acting', label: 'Acting' },
  { id: 'resolved', label: 'Resolved' },
  { id: 'dismissed', label: 'Dismissed' },
  { id: 'ignored', label: 'Ignored' },
];

const TRIAGE_LABEL: Readonly<Record<BaselineTriageStatus, string>> = {
  'new': 'New', 'tracking': 'Tracking', 'acting': 'Acting',
  'resolved': 'Resolved', 'dismissed': 'Dismissed', 'ignored': 'Ignored',
};

type ChipTone = 'accent' | 'warning' | 'positive' | 'neutral';

/** Single source of truth for the status palette — the chip, dot, and active
 *  styles all derive from a status's tone, so the colors can't drift apart. */
const STATUS_TONE: Readonly<Record<BaselineTriageStatus, ChipTone>> = {
  'new': 'neutral', tracking: 'accent', acting: 'warning', resolved: 'positive', dismissed: 'neutral', ignored: 'neutral',
};
const TONE_CHIP: Readonly<Record<ChipTone, string>> = {
  accent: 'text-accent bg-accent/10 border-accent/30',
  warning: 'text-warning bg-warning/10 border-warning/30',
  positive: 'text-positive bg-positive/10 border-positive/30',
  neutral: 'text-text-secondary bg-bg-tertiary/30 border-border',
};
const TONE_DOT: Readonly<Record<ChipTone, string>> = {
  accent: 'bg-accent', warning: 'bg-warning', positive: 'bg-positive', neutral: 'bg-text-muted',
};
// Stronger tint for the active filter chip, so even neutral statuses read
// clearly as selected (the muted base alone was almost indistinguishable).
const TONE_ACTIVE: Readonly<Record<ChipTone, string>> = {
  accent: 'text-accent bg-accent/15 border-accent/60',
  warning: 'text-warning bg-warning/15 border-warning/60',
  positive: 'text-positive bg-positive/15 border-positive/60',
  neutral: 'text-text-primary bg-bg-tertiary border-text-muted/60',
};

function triageChip(status: BaselineTriageStatus): string {
  return TONE_CHIP[STATUS_TONE[status]];
}
function filterDot(id: TriageFilter): string | undefined {
  return id === 'open' || id === 'all' ? undefined : TONE_DOT[STATUS_TONE[id]];
}
function activeFilterClass(id: TriageFilter): string {
  return id === 'open' || id === 'all' ? TONE_ACTIVE.accent : TONE_ACTIVE[STATUS_TONE[id]];
}

function Kpi({ label, value, accent }: Readonly<{ label: string; value: string; accent?: string | undefined }>) {
  return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-3">
      <p className="text-xs uppercase tracking-wider text-text-muted">{label}</p>
      <p className={`text-lg font-semibold tabular-nums ${accent ?? 'text-text-primary'}`}>{value}</p>
    </div>
  );
}

export function Baselines({ baselineStatus }: Readonly<{ baselineStatus?: BaselineRecomputeStatus | undefined }>) {
  const api = useCostApi();
  const [statusFilter, setStatusFilter] = useState<TriageFilter>('open');
  const [refreshKey, setRefreshKey] = useState(0);
  const [sorting, setSorting] = useState<SortingState>([{ id: 'potential', desc: true }]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [triageQueue, setTriageQueue] = useState<readonly string[] | null>(null);
  const [triageIdx, setTriageIdx] = useState(0);
  const [showRecompute, setShowRecompute] = useState(false);

  async function startTriage(): Promise<void> {
    const res = await api.listBaselines({ triage: 'new' });
    const ids = res.items.map((r) => r.spec.id);
    if (ids.length === 0) return;
    setTriageQueue(ids);
    setTriageIdx(0);
  }
  function endTriage(): void {
    setTriageQueue(null);
    setTriageIdx(0);
    setRefreshKey((n) => n + 1);
  }

  const running = baselineStatus?.state === 'running';
  const progressLabel = baselineStatus?.state === 'running'
    ? (baselineStatus.phase === 'discovering' ? 'Discovering baselines…' : `Computing ${String(baselineStatus.done)} / ${String(baselineStatus.total)}`)
    : '';
  const progressPct = baselineStatus?.state === 'running' && baselineStatus.phase === 'computing' && baselineStatus.total > 0
    ? Math.round((baselineStatus.done / baselineStatus.total) * 100)
    : null;
  const prevState = useRef<string | undefined>(baselineStatus?.state);
  useEffect(() => {
    if (prevState.current === 'running' && baselineStatus?.state === 'idle') setRefreshKey((n) => n + 1);
    prevState.current = baselineStatus?.state;
  }, [baselineStatus?.state]);

  const listQuery = useQuery(
    () => api.listBaselines(statusFilter === 'all' ? {} : { triage: statusFilter }),
    [api, statusFilter, refreshKey],
  );
  const result: BaselinesListResult | null = listQuery.status === 'success' ? listQuery.data : null;
  // Counts are filter-independent (same tally in every response), so hold the
  // last-good set across the brief loading window on a filter switch — otherwise
  // every chip's badge blinks away and the bar reflows on each click.
  const lastCounts = useRef<BaselinesListResult['counts'] | null>(null);
  if (result !== null) lastCounts.current = result.counts;
  const counts = result?.counts ?? lastCounts.current;
  const rows = result?.items ?? [];
  const orderedIds = rows.map((r) => r.spec.id);
  const selIdx = selectedId !== null ? orderedIds.indexOf(selectedId) : -1;

  const columns = useMemo<readonly TableColumn<BaselineRecord>[]>(() => [
    {
      id: 'scope', header: 'Scope', sortable: false,
      accessorFn: (r) => r.scopeLabel,
      cell: (_v, r) => (
        <button type="button" onClick={() => { setSelectedId(r.spec.id); }} className="text-left">
          <span className="text-text-primary text-xs font-medium hover:text-accent">{r.spec.name ?? r.scopeLabel}</span>
          {r.spec.source === 'manual' && <span className="ml-1 text-[9px] text-text-muted">(manual)</span>}
        </button>
      ),
    },
    {
      id: 'owner', header: 'Owner', sortable: false,
      accessorFn: (r) => (r.ownerPath ?? []).map(String).join(' / '),
      cell: (_v, r) => <span className="text-text-muted text-[11px]">{(r.ownerPath ?? []).map(String).join(' / ') || '—'}</span>,
    },
    {
      id: 'status', header: 'Status',
      accessorFn: (r) => r.triageStatus,
      cell: (_v, r) => <span className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-medium ${triageChip(r.triageStatus)}`}>{TRIAGE_LABEL[r.triageStatus]}</span>,
    },
    {
      id: 'band', header: 'Average / band', sortable: false,
      accessorFn: (r) => r.currentDaily,
      cell: (_v, r) => <BaselineMicroBar lower={r.effectiveLower} upper={r.effectiveUpper} current={r.currentDaily} status={r.status} />,
    },
    {
      id: 'potential', header: 'Potential/mo', align: 'right', mono: true,
      accessorFn: (r) => r.savings.potentialMonthly,
      cell: (_v, r) => <span className={r.savings.potentialMonthly > 0 ? 'text-warning' : 'text-text-muted'}>{formatDollars(r.savings.potentialMonthly)}</span>,
    },
    {
      id: 'realized', header: 'Realized/mo', align: 'right', mono: true,
      accessorFn: (r) => r.savings.realizedMonthly,
      cell: (_v, r) => <span className={r.savings.realizedMonthly > 0 ? 'text-positive' : 'text-text-muted'}>{formatDollars(r.savings.realizedMonthly)}</span>,
    },
  ], []);

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-base font-medium text-text-secondary">Cost baselines — drift, potential &amp; realized savings</p>
          {counts !== null && <p className="text-xs text-text-muted mt-1 tabular-nums">{String(counts.all)} baselines</p>}
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => { void startTriage(); }} className="rounded-md border border-accent/40 bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent hover:bg-accent/20">Triage new</button>
          <button type="button" onClick={() => { setShowNew(true); }} className="rounded-md border border-border px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary">New baseline</button>
          <button type="button" disabled={running} onClick={() => { setShowRecompute(true); }}
            className="rounded-md bg-accent/15 px-3 py-1.5 text-xs font-medium text-accent hover:bg-accent/25 disabled:opacity-60">
            {running ? progressLabel : 'Recompute…'}
          </button>
        </div>
      </div>

      {result !== null && (
        <div className="grid grid-cols-3 gap-3">
          <Kpi label="Potential savings" value={`${formatDollars(result.totalPotentialMonthly)}/mo`} accent="text-warning" />
          <Kpi label="Realized savings" value={`${formatDollars(result.totalRealizedMonthly)}/mo`} accent="text-positive" />
          <Kpi label="Baselines" value={String(counts?.all ?? result.total)} />
        </div>
      )}

      {running && (
        <div className="rounded-lg border border-accent/30 bg-accent/5 px-4 py-2">
          <div className="flex items-center justify-between text-xs text-accent">
            <span>{progressLabel}</span>
            {progressPct !== null && <span className="tabular-nums">{String(progressPct)}%</span>}
          </div>
          <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-bg-tertiary">
            <div className={`h-full rounded-full bg-accent/60 ${progressPct === null ? 'w-1/3 animate-pulse' : 'transition-all'}`}
              style={progressPct === null ? undefined : { width: `${String(progressPct)}%` }} />
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {STATUS_FILTERS.map((f) => {
          const active = statusFilter === f.id;
          const dot = filterDot(f.id);
          const count = counts?.[f.id];
          return (
            <Fragment key={f.id}>
              {/* Divider between the meta filters (Open/All) and the lifecycle statuses. */}
              {f.id === 'new' && <span className="mx-0.5 h-4 w-px bg-border" aria-hidden="true" />}
              <button type="button" onClick={() => { setStatusFilter(f.id); }}
                className={['flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                  active ? activeFilterClass(f.id) : 'border-border bg-bg-tertiary/30 text-text-secondary hover:text-text-primary'].join(' ')}>
                {dot !== undefined && <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden="true" />}
                {f.label}
                {count !== undefined && <span className="tabular-nums text-[10px] opacity-60">{String(count)}</span>}
              </button>
            </Fragment>
          );
        })}
      </div>

      {baselineStatus?.state === 'error' && (
        <div className="rounded-lg border border-negative bg-negative-muted px-4 py-3 text-sm text-negative">Recompute failed: {baselineStatus.message}</div>
      )}
      {listQuery.status === 'loading' && <div className="flex-1"><CoinRainLoader height={500} count={10} /></div>}
      {listQuery.status === 'error' && (
        <div className="rounded-lg border border-negative bg-negative-muted px-4 py-3 text-sm text-negative">{listQuery.error.message}</div>
      )}

      {rows.length > 0 && (
        <div className="rounded-xl border border-border bg-bg-secondary/50 overflow-hidden p-4">
          <DataTable<BaselineRecord> data={[...rows]} columns={columns} sorting={sorting} onSortingChange={setSorting} height={600} csvFilename="baselines" />
        </div>
      )}

      {result !== null && rows.length === 0 && (
        <div className="rounded-xl border border-border bg-bg-secondary/50 p-12 text-center text-text-secondary">
          No baselines yet. They are discovered automatically after a sync — hit <span className="text-text-primary">Recompute</span> to scan now, or pin one with <span className="text-text-primary">New baseline</span>.
        </div>
      )}

      {selectedId !== null && (
        <BaselineDetailModal
          id={selectedId}
          onClose={() => { setSelectedId(null); }}
          onChanged={() => { setRefreshKey((n) => n + 1); }}
          onNext={selIdx >= 0 && selIdx < orderedIds.length - 1 ? () => { setSelectedId(orderedIds[selIdx + 1] ?? null); } : undefined}
          onPrev={selIdx > 0 ? () => { setSelectedId(orderedIds[selIdx - 1] ?? null); } : undefined}
          position={selIdx >= 0 ? { index: selIdx, total: orderedIds.length } : undefined}
        />
      )}
      {showNew && <NewBaselineDialog onClose={() => { setShowNew(false); }} onCreated={() => { setShowNew(false); setRefreshKey((n) => n + 1); }} />}
      {showRecompute && <RecomputeDialog onClose={() => { setShowRecompute(false); }} onStarted={() => { setShowRecompute(false); }} />}

      {triageQueue !== null && triageQueue[triageIdx] !== undefined && (
        <BaselineDetailModal
          key={triageQueue[triageIdx]}
          id={triageQueue[triageIdx]}
          triageMode
          onClose={endTriage}
          onChanged={() => { /* queue is a fixed snapshot — refresh the list when triage ends */ }}
          onNext={() => { if (triageIdx + 1 < triageQueue.length) setTriageIdx(triageIdx + 1); else endTriage(); }}
          onPrev={triageIdx > 0 ? () => { setTriageIdx(triageIdx - 1); } : undefined}
          position={{ index: triageIdx, total: triageQueue.length }}
        />
      )}
    </div>
  );
}

function NewBaselineDialog({ onClose, onCreated }: Readonly<{ onClose: () => void; onCreated: () => void }>) {
  const api = useCostApi();
  const dimsQuery = useQuery(() => api.getDimensionsConfig(), [api]);
  const dims: DimensionsConfig | null = dimsQuery.status === 'success' ? dimsQuery.data : null;
  const builtIns = (dims?.builtIn ?? []).filter((d) => d.enabled !== false);
  const [dimId, setDimId] = useState('');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const effectiveDim = dimId.length > 0 ? dimId : (builtIns[0] !== undefined ? String(builtIns[0].name) : '');

  async function create(): Promise<void> {
    if (effectiveDim.length === 0 || value.length === 0) { setError('Pick a dimension and a value.'); return; }
    await api.createBaseline({ scope: { kind: 'filter', filters: { [asDimensionId(effectiveDim)]: [asTagValue(value)] } } })
      .then(() => { onCreated(); })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : String(err)); });
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogTitle>New baseline</DialogTitle>
        <p className="text-xs text-text-muted mt-1">Scope a baseline to a stable built-in dimension value (tags are intentionally excluded).</p>
        <div className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs text-text-secondary">
            Dimension
            <select value={effectiveDim} onChange={(e) => { setDimId(e.target.value); }} className="rounded-md border border-border bg-bg-primary px-2 py-1 text-sm text-text-primary">
              {builtIns.map((d) => <option key={String(d.name)} value={String(d.name)}>{d.label}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-text-secondary">
            Value
            <input value={value} onChange={(e) => { setValue(e.target.value); }} placeholder="e.g. Amazon Relational Database Service" className="rounded-md border border-border bg-bg-primary px-2 py-1 text-sm text-text-primary placeholder:text-text-muted" />
          </label>
          {error !== null && <p className="text-xs text-negative">{error}</p>}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <DialogClose><button type="button" className="rounded-md border border-border px-3 py-1 text-xs text-text-secondary">Cancel</button></DialogClose>
          <button type="button" onClick={() => { void create(); }} className="rounded-md bg-accent/15 px-3 py-1 text-xs font-medium text-accent hover:bg-accent/25">Create</button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RecomputeDialog({ onClose, onStarted }: Readonly<{ onClose: () => void; onStarted: () => void }>) {
  const api = useCostApi();
  const cfgQuery = useQuery(() => api.getBaselinesConfig(), [api]);
  const dimsQuery = useQuery(() => api.getDimensionsConfig(), [api]);
  const cfg = cfgQuery.status === 'success' ? cfgQuery.data : null;
  const dims: DimensionsConfig | null = dimsQuery.status === 'success' ? dimsQuery.data : null;
  const builtIns = (dims?.builtIn ?? []).filter((d) => d.enabled !== false);

  const [picked, setPicked] = useState<ReadonlySet<string> | null>(null);
  const [startFresh, setStartFresh] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Best-effort hint only (the real cardinality guard lives in the backend
  // auto-grain). Default-unchecking high-card dims keeps the initial display in
  // step with what the auto-grain does.
  const isHighCard = (description: string | undefined): boolean => /high.?cardinalit/i.test(description ?? '');

  // Initial checklist: the current custom grain, or — when the grain is auto —
  // the enabled built-ins minus high-cardinality ones. `picked` is null until the
  // user toggles something; while null we DON'T persist a grain on recompute, so
  // the backend's cardinality-guarded auto-grain stays in effect.
  const effPicked = picked ?? new Set<string>(
    cfg !== null && cfg.config.grainDimensions.length > 0
      ? cfg.config.grainDimensions.map(String)
      : builtIns.filter((d) => !isHighCard(d.description)).map((d) => String(d.name)),
  );

  function toggle(name: string): void {
    const next = new Set(effPicked);
    if (next.has(name)) next.delete(name); else next.add(name);
    setPicked(next);
  }

  async function run(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      // Only persist a grain when the user actually edited the checklist; an
      // untouched dialog leaves the (auto-guarded) grain alone.
      if (picked !== null) {
        if (cfg === null) { setError('Could not read the current baseline config.'); setBusy(false); return; }
        const grainDimensions = builtIns.filter((d) => picked.has(String(d.name))).map((d) => asDimensionId(String(d.name)));
        if (grainDimensions.length === 0) { setError('Pick at least one dimension.'); setBusy(false); return; }
        await api.setBaselinesConfig({ ...cfg.config, grainDimensions });
      }
      // recomputeBaselines resolves only when the whole job finishes; the page
      // shows live progress, so kick it off and close the dialog immediately.
      void api.recomputeBaselines({ startFresh }).catch(() => undefined);
      onStarted();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  const pending = (s: typeof cfgQuery.status): boolean => s !== 'success' && s !== 'error';
  const loading = pending(cfgQuery.status) || pending(dimsQuery.status);
  const loadError = cfgQuery.status === 'error' ? cfgQuery.error.message
    : dimsQuery.status === 'error' ? dimsQuery.error.message : null;

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogTitle>Recompute baselines</DialogTitle>
        <p className="mt-1 text-xs text-text-muted">Discovery enumerates every distinct combination of the dimensions you pick — more dimensions mean finer baselines but many more of them.</p>
        {loading ? (
          <p className="mt-4 text-xs text-text-muted">Loading dimensions…</p>
        ) : (
          <>
            {loadError !== null && (
              <p className="mt-3 rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5 text-[11px] text-warning">Couldn't load dimensions ({loadError}). Recompute will use the current settings.</p>
            )}
            {loadError === null && (
            <div className="mt-4 flex flex-col gap-1.5 max-h-64 overflow-y-auto">
              {builtIns.map((d) => {
                const name = String(d.name);
                return (
                  <label key={name} className="flex items-center gap-2 text-xs text-text-secondary" title={d.description}>
                    <input type="checkbox" checked={effPicked.has(name)} onChange={() => { toggle(name); }} />
                    <span className="text-text-primary">{d.label}</span>
                    {isHighCard(d.description) && <span className="rounded border border-warning/40 px-1 text-[9px] text-warning">high cardinality</span>}
                    <span className="truncate text-[10px] text-text-muted">{d.description}</span>
                  </label>
                );
              })}
            </div>
            )}
            <label className="mt-4 flex items-start gap-2 text-xs text-text-secondary">
              <input type="checkbox" checked={startFresh} onChange={(e) => { setStartFresh(e.target.checked); }} className="mt-0.5" />
              <span>
                <span className="text-text-primary">Start fresh</span> — remove all discovered baselines, including ones you triaged, and rediscover from scratch.
              </span>
            </label>
            {!startFresh && (
              <p className="mt-1.5 text-[11px] text-text-muted">Untouched baselines that no longer match the new dimensions are removed; any you triaged or annotated are kept.</p>
            )}
          </>
        )}
        {error !== null && <p className="mt-3 text-xs text-negative">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <DialogClose><button type="button" className="rounded-md border border-border px-3 py-1 text-xs text-text-secondary">Cancel</button></DialogClose>
          <button type="button" disabled={busy || loading} onClick={() => { void run(); }} className="rounded-md bg-accent/15 px-3 py-1 text-xs font-medium text-accent hover:bg-accent/25 disabled:opacity-50">
            {busy ? 'Starting…' : startFresh ? 'Wipe & recompute' : 'Recompute'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
