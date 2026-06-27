import { useEffect, useMemo, useRef, useState } from 'react';
import type { SortingState } from '@tanstack/react-table';
import type { BaselineRecord, BaselineRecomputeStatus, BaselineStatus, BaselinesListResult, DimensionsConfig } from '@costgoblin/core/browser';
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

const STATUS_FILTERS: readonly { id: BaselineStatus | 'actionable' | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'actionable', label: 'Actionable' },
  { id: 'over', label: 'Over' },
  { id: 'under', label: 'Under' },
  { id: 'in-band', label: 'In band' },
  { id: 'insufficient-data', label: 'Insufficient' },
];

function statusChip(status: BaselineStatus): string {
  switch (status) {
    case 'over': return 'text-negative bg-negative/10 border-negative/30';
    case 'under': return 'text-positive bg-positive/10 border-positive/30';
    case 'in-band': return 'text-warning bg-warning/10 border-warning/30';
    default: return 'text-text-muted bg-bg-tertiary/30 border-border';
  }
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
  const [statusFilter, setStatusFilter] = useState<BaselineStatus | 'actionable' | 'all'>('all');
  const [refreshKey, setRefreshKey] = useState(0);
  const [sorting, setSorting] = useState<SortingState>([{ id: 'potential', desc: true }]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  const running = baselineStatus?.state === 'running';
  const progress = baselineStatus?.state === 'running' ? `${String(baselineStatus.done)}/${String(baselineStatus.total)}` : '';
  const prevState = useRef<string | undefined>(baselineStatus?.state);
  useEffect(() => {
    if (prevState.current === 'running' && baselineStatus?.state === 'idle') setRefreshKey((n) => n + 1);
    prevState.current = baselineStatus?.state;
  }, [baselineStatus?.state]);

  const listQuery = useQuery(
    () => api.listBaselines(statusFilter === 'all' ? {} : { status: statusFilter }),
    [api, statusFilter, refreshKey],
  );
  const result: BaselinesListResult | null = listQuery.status === 'success' ? listQuery.data : null;
  const rows = result?.items ?? [];

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
      accessorFn: (r) => r.status,
      cell: (_v, r) => <span className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-medium ${statusChip(r.status)}`}>{r.status}</span>,
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
          {result !== null && <p className="text-xs text-text-muted mt-1 tabular-nums">{String(result.total)} baselines</p>}
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => { setShowNew(true); }} className="rounded-md border border-border px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary">New baseline</button>
          <button type="button" disabled={running} onClick={() => { api.recomputeBaselines().catch(() => undefined); }}
            className="rounded-md bg-accent/15 px-3 py-1.5 text-xs font-medium text-accent hover:bg-accent/25 disabled:opacity-60">
            {running ? `Recomputing… ${progress}` : 'Recompute'}
          </button>
        </div>
      </div>

      {result !== null && (
        <div className="grid grid-cols-3 gap-3">
          <Kpi label="Potential savings" value={`${formatDollars(result.totalPotentialMonthly)}/mo`} accent="text-warning" />
          <Kpi label="Realized savings" value={`${formatDollars(result.totalRealizedMonthly)}/mo`} accent="text-positive" />
          <Kpi label="Baselines" value={String(result.total)} />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {STATUS_FILTERS.map((f) => (
          <button key={f.id} type="button" onClick={() => { setStatusFilter(f.id); }}
            className={['rounded-full border px-3 py-1 text-xs font-medium transition-colors',
              statusFilter === f.id ? 'border-accent/50 bg-accent/10 text-accent' : 'border-border bg-bg-tertiary/30 text-text-secondary hover:text-text-primary'].join(' ')}>
            {f.label}
          </button>
        ))}
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
        <BaselineDetailModal id={selectedId} onClose={() => { setSelectedId(null); }} onChanged={() => { setRefreshKey((n) => n + 1); }} />
      )}
      {showNew && <NewBaselineDialog onClose={() => { setShowNew(false); }} onCreated={() => { setShowNew(false); setRefreshKey((n) => n + 1); }} />}
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
            <input value={value} onChange={(e) => { setValue(e.target.value); }} placeholder="e.g. AmazonRDS" className="rounded-md border border-border bg-bg-primary px-2 py-1 text-sm text-text-primary placeholder:text-text-muted" />
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
