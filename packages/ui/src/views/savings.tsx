import type {
  PreferredCommitment,
  SavingsGroup,
  SavingsRecommendation,
  SavingsResult,
  SavingsSnapshot,
} from '@costgoblin/core/browser';
import {
  COMMITMENT_PAYMENT_LABELS,
  COMMITMENT_PAYMENT_OPTIONS,
  COMMITMENT_TERM_LABELS,
  COMMITMENT_TERMS,
  commitmentOptionLabel,
  countSavings,
  parseCommitmentPaymentOption,
  parseCommitmentTerm,
  preferredCommitmentLabel,
  SAVINGS_PREFERENCES_DEFAULTS,
} from '@costgoblin/core/browser';
import type { SortingState } from '@tanstack/react-table';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { formatDollars } from '../components/format.js';
import { CoinRainLoader } from '../components/coin-rain-loader.js';
import { DataTable } from '../components/data-table.js';
import type { TableColumn } from '../lib/table-types.js';
import { useState, useMemo, Fragment } from 'react';

const EFFORT_ORDER: Record<string, number> = { 'VeryLow': 0, 'Low': 1, 'Medium': 2, 'High': 3 };

/** The select value standing for "highest savings" (a null preference). */
const HIGHEST = 'highest';

function effortLabel(effort: string): string {
  if (effort === 'VeryLow') return 'Very Low';
  return effort;
}

function effortColor(effort: string): string {
  switch (effort) {
    case 'VeryLow':
    case 'Low':
      return 'text-accent bg-accent/10 border-accent/30';
    case 'Medium':
      return 'text-warning bg-warning/10 border-warning/30';
    case 'High':
      return 'text-negative bg-negative/10 border-negative/30';
    default:
      return 'text-text-muted bg-bg-tertiary/30 border-border';
  }
}

function humanizeAction(action: string): string {
  return action.replaceAll(/([a-z])([A-Z])/g, '$1 $2');
}

function plural(n: number, word: string): string {
  return `${String(n)} ${word}${n === 1 ? '' : 's'}`;
}

/** `3-year, all upfront, Standard` — or COH's summary when the export didn't say. */
function optionLabel(rec: SavingsRecommendation): string {
  const label = rec.commitment === null ? '' : commitmentOptionLabel(rec.commitment);
  return label.length > 0 ? label : rec.summary;
}

function snapshotLabel(snapshots: readonly SavingsSnapshot[]): string {
  if (snapshots.length === 0) return '';
  const [only] = snapshots;
  if (snapshots.length === 1 && only !== undefined) return `COH export of ${only.date}`;
  const perProvider = snapshots.map(s => `${s.providerName} ${s.date}`).join(', ');
  return `COH exports: ${perProvider}`;
}

interface ParsedDetails {
  config: Record<string, string>;
  usages: { type: string; amount: string; unit: string }[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function flattenConfiguration(rawConfig: unknown): Record<string, string> {
  const config: Record<string, string> = {};
  if (!isRecord(rawConfig)) return config;
  for (const [section, value] of Object.entries(rawConfig)) {
    if (isRecord(value)) {
      for (const [k, v] of Object.entries(value)) {
        config[`${section}.${k}`] = String(v);
      }
    } else {
      config[section] = String(value);
    }
  }
  return config;
}

function parseUsages(costCalc: unknown): ParsedDetails['usages'] {
  if (!isRecord(costCalc)) return [];
  const rawUsages = costCalc['usages'];
  if (!Array.isArray(rawUsages)) return [];
  const usages: ParsedDetails['usages'] = [];
  for (const u of rawUsages) {
    if (!isRecord(u)) continue;
    const uAmount = u['usageAmount'];
    const stringOrEmpty = typeof uAmount === 'string' ? uAmount : '';
    const amountStr = typeof uAmount === 'number' ? String(uAmount) : stringOrEmpty;
    usages.push({
      type: typeof u['usageType'] === 'string' ? u['usageType'] : '',
      amount: amountStr,
      unit: typeof u['unit'] === 'string' ? u['unit'] : '',
    });
  }
  return usages;
}

function parseResourceDetails(json: string): ParsedDetails | null {
  if (json.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!isRecord(parsed)) return null;
    const topKey = Object.keys(parsed)[0];
    if (topKey === undefined) return null;
    const inner = parsed[topKey];
    if (!isRecord(inner)) return null;
    return {
      config: flattenConfiguration(inner['configuration']),
      usages: parseUsages(inner['costCalculation']),
    };
  } catch {
    return null;
  }
}

/** What a row acts on: the resource's id, or the commitment pool. */
function targetLabel(group: SavingsGroup): string {
  const rec = group.counted;
  if (rec.commitment !== null) return rec.commitment.poolLabel;
  return rec.resourceArn.split(':').pop() ?? rec.resourceArn;
}

function RecommendationCell(_v: unknown, group: SavingsGroup) {
  const rec = group.counted;
  const target = targetLabel(group);
  return (
    <div className="max-w-lg">
      <div className="flex items-baseline gap-2">
        <span className="text-text-primary text-xs font-medium shrink-0">{humanizeAction(rec.actionType)}</span>
        {target.length > 0 && (
          <span className="text-text-muted text-[10px] font-mono truncate" title={rec.commitment === null ? rec.resourceArn : target}>{target}</span>
        )}
      </div>
      <p className="text-text-muted text-xs mt-0.5 truncate" title={rec.summary}>{rec.summary}</p>
      {group.alternatives.length > 0 && (
        <p className="text-text-muted text-[10px]">+ {plural(group.alternatives.length, 'alternative')} not counted</p>
      )}
    </div>
  );
}

function AccountCell(_v: unknown, group: SavingsGroup) {
  return (
    <>
      <p className="text-text-secondary text-xs">{group.counted.accountName}</p>
      <p className="text-text-muted text-[10px] font-mono">{group.counted.accountId}</p>
    </>
  );
}

function MonthlySavingsCell(_v: unknown, group: SavingsGroup) {
  return (
    <>
      <span className="font-medium text-accent">{formatDollars(group.monthlySavings)}</span>
      {group.scale < 1 && (
        <p className="text-text-muted text-[10px]" title="Cost Optimization Hub's estimate, before the counted resource actions">
          COH {formatDollars(group.counted.monthlySavings)}
        </p>
      )}
    </>
  );
}

function EffortCell(_v: unknown, group: SavingsGroup) {
  return (
    <span className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-medium ${effortColor(group.counted.effort)}`}>
      {effortLabel(group.counted.effort)}
    </span>
  );
}

const SAVINGS_COLUMNS: readonly TableColumn<SavingsGroup>[] = [
  {
    id: 'recommendation', header: 'Recommendation', sortable: false,
    accessorFn: g => g.counted.actionType,
    cell: RecommendationCell,
  },
  {
    id: 'accountName', header: 'Account',
    accessorFn: g => g.counted.accountName,
    cell: AccountCell,
  },
  { id: 'region', header: 'Region', accessorFn: g => g.counted.region, sortable: false },
  {
    id: 'monthlyCost', header: 'Monthly Cost', align: 'right', mono: true,
    accessorFn: g => g.monthlyCost,
    cell: (_v, g) => formatDollars(g.monthlyCost),
  },
  {
    id: 'monthlySavings', header: 'Savings/mo', align: 'right', mono: true,
    accessorFn: g => g.monthlySavings,
    cell: MonthlySavingsCell,
  },
  {
    id: 'savingsPercentage', header: '%', align: 'right', mono: true,
    accessorFn: g => g.counted.savingsPercentage,
    cell: (_v, g) => `${String(Math.round(g.counted.savingsPercentage))}%`,
  },
  {
    id: 'effort', header: 'Effort',
    accessorFn: g => EFFORT_ORDER[g.counted.effort] ?? 4,
    cell: EffortCell,
  },
];

interface TypeTotal {
  readonly type: string;
  readonly count: number;
  readonly savings: number;
}

/** Counted rows and savings per action type, biggest first. */
function typeTotals(groups: readonly SavingsGroup[]): TypeTotal[] {
  const map = new Map<string, { count: number; savings: number }>();
  for (const group of groups) {
    const existing = map.get(group.counted.actionType);
    if (existing === undefined) {
      map.set(group.counted.actionType, { count: 1, savings: group.monthlySavings });
    } else {
      existing.count++;
      existing.savings += group.monthlySavings;
    }
  }
  return [...map.entries()]
    .sort((a, b) => b[1].savings - a[1].savings)
    .map(([type, info]) => ({ type, ...info }));
}

/** Every action type COH listed, hidden ones included, most listed first. */
function listedTypes(recommendations: readonly SavingsRecommendation[]): { type: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const rec of recommendations) counts.set(rec.actionType, (counts.get(rec.actionType) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([type, count]) => ({ type, count }));
}

export function Savings() {
  const api = useCostApi();
  const savingsQuery = useQuery(() => api.querySavings(), [api]);
  const prefsQuery = useQuery(() => api.getSavingsPreferences(), [api]);
  const [sorting, setSorting] = useState<SortingState>([{ id: 'monthlySavings', desc: true }]);
  const [activeFilter, setActiveFilter] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [hiddenTypes, setHiddenTypes] = useState(new Set<string>());
  const [preferred, setPreferred] = useState<PreferredCommitment>(SAVINGS_PREFERENCES_DEFAULTS.preferredCommitment);
  const [prefsLoaded, setPrefsLoaded] = useState(false);

  const data: SavingsResult | null =
    savingsQuery.status === 'success' ? savingsQuery.data : null;

  // Load saved preferences once
  if (!prefsLoaded && prefsQuery.status === 'success') {
    setPrefsLoaded(true);
    if (prefsQuery.data.hiddenActionTypes.length > 0) {
      setHiddenTypes(new Set(prefsQuery.data.hiddenActionTypes));
    }
    setPreferred(prefsQuery.data.preferredCommitment);
  }

  // A hidden type neither counts nor shrinks a commitment: count what's shown.
  const visibleRecs = useMemo(() => {
    if (data === null) return [];
    return hiddenTypes.size === 0
      ? data.recommendations
      : data.recommendations.filter(r => !hiddenTypes.has(r.actionType));
  }, [data, hiddenTypes]);

  const counted = useMemo(() => countSavings(visibleRecs, preferred), [visibleRecs, preferred]);
  const actionTypes = useMemo(() => typeTotals(counted.groups), [counted]);
  const allActionTypes = useMemo(() => (data === null ? [] : listedTypes(data.recommendations)), [data]);

  // The settings edit what was saved, so they wait for it: a save from the
  // defaults would overwrite the saved list.
  const prefsReady = prefsLoaded || prefsQuery.status === 'error';

  function toggleHiddenType(actionType: string) {
    const next = new Set(hiddenTypes);
    if (next.has(actionType)) {
      next.delete(actionType);
    } else {
      next.add(actionType);
      if (activeFilter === actionType) setActiveFilter(null);
    }
    setHiddenTypes(next);
    api.saveSavingsPreferences({ hiddenActionTypes: [...next] }).catch(() => undefined);
  }

  function choosePreferred(next: PreferredCommitment) {
    setPreferred(next);
    api.saveSavingsPreferences({ preferredCommitment: next }).catch(() => undefined);
  }

  // A recount can leave the filtered type without a row (showing Savings
  // Plans again folds the EC2 RIs under the Compute SP): show everything then.
  const filter = activeFilter !== null && actionTypes.some(at => at.type === activeFilter) ? activeFilter : null;
  const filtered = useMemo(() => {
    if (filter === null) return counted.groups;
    return counted.groups.filter(g => g.counted.actionType === filter);
  }, [counted, filter]);

  const filteredSavings = filtered.reduce((s, g) => s + g.monthlySavings, 0);
  const notCounted = visibleRecs.length - counted.groups.length;

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-base font-medium text-text-secondary">AWS cost optimization recommendations</p>
          {data !== null && (
            <>
              <p className="text-xs text-text-muted mt-1 tabular-nums">
                {plural(filtered.length, 'action')} · {formatDollars(filteredSavings)}/mo potential savings
              </p>
              {data.recommendations.length > 0 && (
                <p className="text-[11px] text-text-muted mt-0.5">
                  {[
                    `One option counted per resource and per commitment pool, commitments at ${preferredCommitmentLabel(preferred)}`,
                    notCounted > 0 ? `${plural(notCounted, 'alternative')} not counted` : '',
                    snapshotLabel(data.snapshots),
                  ].filter(p => p.length > 0).join(' · ')}
                </p>
              )}
            </>
          )}
        </div>
        {data !== null && (
          <button
            type="button"
            onClick={() => { setShowSettings(s => !s); }}
            className={[
              'rounded-md p-1.5 transition-colors',
              showSettings
                ? 'bg-bg-tertiary text-text-primary'
                : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary',
            ].join(' ')}
            title="Savings settings"
            aria-label="Savings settings"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
        )}
      </div>

      {showSettings && prefsReady && allActionTypes.length > 0 && (
        <SavingsSettings
          types={allActionTypes}
          hiddenTypes={hiddenTypes}
          onToggleType={toggleHiddenType}
          preferred={preferred}
          onChoosePreferred={choosePreferred}
        />
      )}

      {actionTypes.length > 1 && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => { setActiveFilter(null); }}
            className={[
              'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
              filter === null
                ? 'border-accent/50 bg-accent/10 text-accent'
                : 'border-border bg-bg-tertiary/30 text-text-secondary hover:text-text-primary',
            ].join(' ')}
          >
            All ({String(counted.groups.length)})
          </button>
          {actionTypes.map(at => (
            <button
              key={at.type}
              type="button"
              onClick={() => { setActiveFilter(filter === at.type ? null : at.type); }}
              className={[
                'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                filter === at.type
                  ? 'border-accent/50 bg-accent/10 text-accent'
                  : 'border-border bg-bg-tertiary/30 text-text-secondary hover:text-text-primary',
              ].join(' ')}
            >
              {humanizeAction(at.type)} ({String(at.count)}) &mdash; {formatDollars(at.savings)}/mo
            </button>
          ))}
        </div>
      )}

      {savingsQuery.status === 'loading' && (
        <div className="flex-1">
          <CoinRainLoader height={500} count={10} />
        </div>
      )}
      {savingsQuery.status === 'error' && (
        <div className="rounded-lg border border-negative bg-negative-muted px-4 py-3 text-sm text-negative break-words">
          {savingsQuery.error.message}
        </div>
      )}

      {filtered.length > 0 && (
        <div className="rounded-xl border border-border bg-bg-secondary/50 overflow-hidden p-4">
          <DataTable<SavingsGroup>
            data={filtered}
            columns={SAVINGS_COLUMNS}
            sorting={sorting}
            onSortingChange={setSorting}
            renderExpandedRow={(group) => <SavingsDetail group={group} />}
            height={600}
          />
        </div>
      )}

      {data !== null && data.recommendations.length === 0 && (
        <div className="rounded-xl border border-border bg-bg-secondary/50 p-12 text-center text-text-secondary">
          No cost optimization data available. Download cost optimization data from the Data tab.
        </div>
      )}
    </div>
  );
}

function SavingsSettings({ types, hiddenTypes, onToggleType, preferred, onChoosePreferred }: Readonly<{
  types: readonly { type: string; count: number }[];
  hiddenTypes: ReadonlySet<string>;
  onToggleType: (type: string) => void;
  preferred: PreferredCommitment;
  onChoosePreferred: (next: PreferredCommitment) => void;
}>) {
  const selectClass = 'rounded-md border border-border bg-bg-primary px-2 py-1 text-sm text-text-primary';
  return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 px-5 py-4 flex flex-col gap-5">
      <div>
        <h3 className="text-sm font-medium text-text-secondary mb-3">Visible recommendation types</h3>
        <div className="flex flex-col gap-2">
          {types.map(at => (
            <label key={at.type} className="flex items-center gap-3 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={!hiddenTypes.has(at.type)}
                onChange={() => { onToggleType(at.type); }}
                className="h-4 w-4 rounded accent-emerald-500"
              />
              <span className="text-text-primary">{humanizeAction(at.type)}</span>
              <span className="text-text-muted text-xs">({plural(at.count, 'item')})</span>
            </label>
          ))}
        </div>
        {hiddenTypes.size > 0 && (
          <p className="text-xs text-text-muted mt-3">
            {String(hiddenTypes.size)} type{hiddenTypes.size > 1 ? 's' : ''} hidden. Settings saved automatically.
          </p>
        )}
      </div>
      <div>
        <h3 className="text-sm font-medium text-text-secondary mb-1">Commitment option counted</h3>
        <p className="text-xs text-text-muted mb-3">
          Cost Optimization Hub lists each Savings Plan and reservation once per term and payment option.
          The totals count one per pool, like COH&apos;s commitment preferences; a pool without the chosen option counts its highest-savings one.
        </p>
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <label className="flex items-center gap-2 text-text-secondary">
            <span>Term</span>
            <select
              className={selectClass}
              value={preferred.term ?? HIGHEST}
              onChange={e => {
                const v = e.target.value;
                onChoosePreferred({ ...preferred, term: parseCommitmentTerm(v) });
              }}
            >
              <option value={HIGHEST}>Highest savings</option>
              {COMMITMENT_TERMS.map(t => <option key={t} value={t}>{COMMITMENT_TERM_LABELS[t]}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2 text-text-secondary">
            <span>Payment</span>
            <select
              className={selectClass}
              value={preferred.paymentOption ?? HIGHEST}
              onChange={e => {
                const v = e.target.value;
                onChoosePreferred({ ...preferred, paymentOption: parseCommitmentPaymentOption(v) });
              }}
            >
              <option value={HIGHEST}>Highest savings</option>
              {COMMITMENT_PAYMENT_OPTIONS.map(p => <option key={p} value={p}>{COMMITMENT_PAYMENT_LABELS[p]}</option>)}
            </select>
          </label>
        </div>
      </div>
    </div>
  );
}

interface FoldedPool {
  readonly pool: string;
  readonly label: string;
  readonly count: number;
  readonly best: number;
}

/** Alternatives from other pools that cover the same usage, one line per pool. */
function foldedPools(group: SavingsGroup): FoldedPool[] {
  const own = group.counted.commitment?.pool;
  const pools = new Map<string, { label: string; count: number; best: number }>();
  for (const alt of group.alternatives) {
    const c = alt.commitment;
    if (c === null || c.pool === own) continue;
    const existing = pools.get(c.pool);
    if (existing === undefined) pools.set(c.pool, { label: c.poolLabel, count: 1, best: alt.monthlySavings });
    else {
      existing.count++;
      existing.best = Math.max(existing.best, alt.monthlySavings);
    }
  }
  return [...pools.entries()].map(([pool, p]) => ({ pool, ...p })).sort((a, b) => b.best - a.best);
}

function Alternatives({ group }: Readonly<{ group: SavingsGroup }>) {
  const own = group.counted.commitment?.pool;
  const sameTarget = group.alternatives.filter(a => a.commitment === null || a.commitment.pool === own);
  const folded = foldedPools(group);
  return (
    <div className="mt-4 pt-3 border-t border-border-subtle text-xs">
      <h4 className="text-text-muted uppercase tracking-wider text-[10px] font-medium mb-2">Not counted · instead of the option above</h4>
      <ul className="space-y-1">
        {sameTarget.map((alt, i) => (
          <li key={alt.recommendationId === '' ? `alternative-${String(i)}` : alt.recommendationId} className="flex items-baseline justify-between gap-6">
            <span className="text-text-secondary truncate" title={alt.summary}>
              {alt.commitment === null ? `${humanizeAction(alt.actionType)} · ${alt.summary}` : optionLabel(alt)}
            </span>
            <span className="text-text-secondary font-mono tabular-nums shrink-0">{formatDollars(alt.monthlySavings)}/mo</span>
          </li>
        ))}
        {folded.map(p => (
          <li key={p.pool} className="flex items-baseline justify-between gap-6">
            <span className="text-text-secondary truncate">{p.label} ({plural(p.count, 'option')})</span>
            <span className="text-text-secondary font-mono tabular-nums shrink-0">up to {formatDollars(p.best)}/mo</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ScaleNote({ group }: Readonly<{ group: SavingsGroup }>) {
  const commitment = group.counted.commitment;
  if (commitment === null || group.overlappingActions === 0) return null;
  const actions = plural(group.overlappingActions, 'counted resource action');
  const verb = group.overlappingActions === 1 ? 'removes' : 'remove';
  const outcome = group.monthlySavings > 0
    ? `so it counts ${formatDollars(group.monthlySavings)}/mo of its ${formatDollars(group.counted.monthlySavings)}/mo.`
    : `so none of its ${formatDollars(group.counted.monthlySavings)}/mo counts: size commitments after acting on those resources.`;
  return (
    <p className="mt-4 pt-3 border-t border-border-subtle text-xs text-text-secondary">
      Cost Optimization Hub sized this on {formatDollars(commitment.eligibleMonthlyCost)}/mo of eligible spend.
      {' '}{actions} on that usage {verb} {formatDollars(group.overlapMonthlyCost)}/mo of it, {outcome}
    </p>
  );
}

function SavingsDetail({ group }: Readonly<{ group: SavingsGroup }>) {
  const rec = group.counted;
  const current = parseResourceDetails(rec.currentDetails);
  const recommended = parseResourceDetails(rec.recommendedDetails);

  return (
    <div>
      <div className="grid grid-cols-2 gap-6 text-xs">
        <div className="space-y-3">
          <h4 className="text-text-muted uppercase tracking-wider text-[10px] font-medium">Current</h4>
          {rec.currentSummary.length > 0 && (
            <p className="text-text-secondary font-mono text-xs">{rec.currentSummary}</p>
          )}
          {current !== null && Object.keys(current.config).length > 0 && (
            <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              {Object.entries(current.config).map(([k, v]) => (
                <Fragment key={`c-${k}`}><span className="text-text-muted">{k}</span><span className="text-text-secondary">{v}</span></Fragment>
              ))}
            </div>
          )}
          {current !== null && current.usages.length > 0 && (
            <div className="space-y-1 pt-1">
              <p className="text-text-muted text-[10px] uppercase tracking-wider">Usage</p>
              {current.usages.map((u) => (
                <p key={`${u.type}-${u.amount}`} className="text-text-secondary">{u.amount} {u.unit} <span className="text-text-muted">({u.type.split('-').pop() ?? u.type})</span></p>
              ))}
            </div>
          )}
        </div>
        <div className="space-y-3">
          <h4 className="text-accent uppercase tracking-wider text-[10px] font-medium">Recommended</h4>
          <p className="text-text-secondary">{rec.summary}</p>
          {recommended !== null && Object.keys(recommended.config).length > 0 && (
            <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              {Object.entries(recommended.config).map(([k, v]) => (
                <Fragment key={`r-${k}`}><span className="text-text-muted">{k}</span><span className="text-accent">{v}</span></Fragment>
              ))}
            </div>
          )}
        </div>
      </div>
      <ScaleNote group={group} />
      {group.alternatives.length > 0 && <Alternatives group={group} />}
      <div className="flex items-center gap-6 mt-4 pt-3 border-t border-border-subtle text-xs text-text-muted">
        {rec.resourceArn.length > 0 && <span className="font-mono">{rec.resourceArn}</span>}
        <span>{rec.resourceType}</span>
        <span>{rec.recommendationSource}</span>
        <span>Restart: <span className={rec.restartNeeded ? 'text-warning' : 'text-text-secondary'}>{rec.restartNeeded ? 'Yes' : 'No'}</span></span>
        <span>Rollback: <span className={rec.rollbackPossible ? 'text-accent' : 'text-text-secondary'}>{rec.rollbackPossible ? 'Yes' : 'No'}</span></span>
      </div>
    </div>
  );
}
