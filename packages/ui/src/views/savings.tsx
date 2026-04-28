import type { SavingsResult, SavingsRecommendation } from '@costgoblin/core/browser';
import type { SortingState } from '@tanstack/react-table';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { formatDollars } from '../components/format.js';
import { DataTable } from '../components/data-table.js';
import type { TableColumn } from '../lib/table-types.js';
import { useState, useMemo, Fragment } from 'react';

const EFFORT_ORDER: Record<string, number> = { 'VeryLow': 0, 'Low': 1, 'Medium': 2, 'High': 3 };

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

export function Savings() {
  const api = useCostApi();
  const savingsQuery = useQuery(() => api.querySavings(), [api]);
  const prefsQuery = useQuery(() => api.getSavingsPreferences(), [api]);
  const [sorting, setSorting] = useState<SortingState>([{ id: 'monthlySavings', desc: true }]);
  const [activeFilter, setActiveFilter] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [hiddenTypes, setHiddenTypes] = useState(new Set<string>());
  const [prefsLoaded, setPrefsLoaded] = useState(false);

  const data: SavingsResult | null =
    savingsQuery.status === 'success' ? savingsQuery.data : null;

  // Load saved preferences once
  if (!prefsLoaded && prefsQuery.status === 'success') {
    setPrefsLoaded(true);
    if (prefsQuery.data.hiddenActionTypes.length > 0) {
      setHiddenTypes(new Set(prefsQuery.data.hiddenActionTypes));
    }
  }

  // Apply hidden filter before anything else
  const visibleRecs = useMemo(() => {
    if (data === null) return [];
    return hiddenTypes.size === 0
      ? data.recommendations
      : data.recommendations.filter(r => !hiddenTypes.has(r.actionType));
  }, [data, hiddenTypes]);

  const actionTypes = useMemo(() => {
    const map = new Map<string, { count: number; savings: number }>();
    for (const rec of visibleRecs) {
      const existing = map.get(rec.actionType);
      if (existing === undefined) {
        map.set(rec.actionType, { count: 1, savings: rec.monthlySavings });
      } else {
        existing.count++;
        existing.savings += rec.monthlySavings;
      }
    }
    return [...map.entries()]
      .sort((a, b) => b[1].savings - a[1].savings)
      .map(([type, info]) => ({ type, ...info }));
  }, [visibleRecs]);

  // All action types including hidden ones (for the settings panel)
  const allActionTypes = useMemo(() => {
    if (data === null) return [];
    const map = new Map<string, { count: number; savings: number }>();
    for (const rec of data.recommendations) {
      const existing = map.get(rec.actionType);
      if (existing === undefined) {
        map.set(rec.actionType, { count: 1, savings: rec.monthlySavings });
      } else {
        existing.count++;
        existing.savings += rec.monthlySavings;
      }
    }
    return [...map.entries()]
      .sort((a, b) => b[1].savings - a[1].savings)
      .map(([type, info]) => ({ type, ...info }));
  }, [data]);

  function toggleHiddenType(actionType: string) {
    setHiddenTypes(prev => {
      const next = new Set(prev);
      if (next.has(actionType)) {
        next.delete(actionType);
      } else {
        next.add(actionType);
        if (activeFilter === actionType) setActiveFilter(null);
      }
      api.saveSavingsPreferences({ hiddenActionTypes: [...next] }).catch(() => undefined);
      return next;
    });
  }

  const filtered = useMemo(() => {
    if (activeFilter === null) return visibleRecs;
    return visibleRecs.filter(r => r.actionType === activeFilter);
  }, [visibleRecs, activeFilter]);

  const filteredSavings = filtered.reduce((s, r) => s + r.monthlySavings, 0);

  const savingsColumns = useMemo<readonly TableColumn<SavingsRecommendation>[]>(() => [
    {
      id: 'recommendation', header: 'Recommendation', sortable: false,
      accessorFn: r => r.actionType,
      cell: (_v, row) => (
        <div className="max-w-lg">
          <div className="flex items-baseline gap-2">
            <span className="text-text-primary text-xs font-medium shrink-0">{humanizeAction(row.actionType)}</span>
            {row.resourceArn.length > 0 && (
              <span className="text-text-muted text-[10px] font-mono truncate" title={row.resourceArn}>{row.resourceArn.split(':').pop() ?? row.resourceArn}</span>
            )}
          </div>
          <p className="text-text-muted text-xs mt-0.5 truncate" title={row.summary}>{row.summary}</p>
        </div>
      ),
    },
    {
      id: 'accountName', header: 'Account',
      accessorFn: r => r.accountName,
      cell: (_v, row) => (
        <>
          <p className="text-text-secondary text-xs">{row.accountName}</p>
          <p className="text-text-muted text-[10px] font-mono">{row.accountId}</p>
        </>
      ),
    },
    { id: 'region', header: 'Region', accessorFn: r => r.region, sortable: false },
    {
      id: 'monthlyCost', header: 'Monthly Cost', align: 'right', mono: true,
      accessorFn: r => r.monthlyCost,
      cell: v => formatDollars(v as number),
    },
    {
      id: 'monthlySavings', header: 'Savings/mo', align: 'right', mono: true,
      accessorFn: r => r.monthlySavings,
      cell: v => <span className="font-medium text-accent">{formatDollars(v as number)}</span>,
    },
    {
      id: 'savingsPercentage', header: '%', align: 'right', mono: true,
      accessorFn: r => r.savingsPercentage,
      cell: v => `${String(Math.round(v as number))}%`,
    },
    {
      id: 'effort', header: 'Effort',
      accessorFn: r => EFFORT_ORDER[r.effort] ?? 4,
      cell: (_v, row) => (
        <span className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-medium ${effortColor(row.effort)}`}>
          {effortLabel(row.effort)}
        </span>
      ),
    },
  ], []);

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-text-primary">Savings Opportunities</h2>
          <p className="text-sm text-text-secondary mt-1">AWS cost optimization recommendations</p>
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
            title="Configure visible recommendation types"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
        )}
      </div>

      {showSettings && allActionTypes.length > 0 && (
        <div className="rounded-xl border border-border bg-bg-secondary/50 px-5 py-4">
          <h3 className="text-sm font-medium text-text-secondary mb-3">Visible recommendation types</h3>
          <div className="flex flex-col gap-2">
            {allActionTypes.map(at => (
              <label key={at.type} className="flex items-center gap-3 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={!hiddenTypes.has(at.type)}
                  onChange={() => { toggleHiddenType(at.type); }}
                  className="h-4 w-4 rounded accent-emerald-500"
                />
                <span className="text-text-primary">{humanizeAction(at.type)}</span>
                <span className="text-text-muted text-xs">({String(at.count)} items, {formatDollars(at.savings)}/mo)</span>
              </label>
            ))}
          </div>
          {hiddenTypes.size > 0 && (
            <p className="text-xs text-text-muted mt-3">
              {String(hiddenTypes.size)} type{hiddenTypes.size > 1 ? 's' : ''} hidden. Settings saved automatically.
            </p>
          )}
        </div>
      )}

      {data !== null && (
        <div className="flex items-center gap-6">
          <div className="rounded-xl border border-border bg-bg-secondary/50 px-6 py-4">
            <p className="text-xs text-text-muted uppercase tracking-wider">Potential Monthly Savings</p>
            <p className="text-2xl font-bold text-accent mt-1">{formatDollars(filteredSavings)}</p>
          </div>
          <div className="rounded-xl border border-border bg-bg-secondary/50 px-6 py-4">
            <p className="text-xs text-text-muted uppercase tracking-wider">Recommendations</p>
            <p className="text-2xl font-bold text-text-primary mt-1">{String(filtered.length)}</p>
          </div>
        </div>
      )}

      {actionTypes.length > 1 && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => { setActiveFilter(null); }}
            className={[
              'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
              activeFilter === null
                ? 'border-accent/50 bg-accent/10 text-accent'
                : 'border-border bg-bg-tertiary/30 text-text-secondary hover:text-text-primary',
            ].join(' ')}
          >
            All ({String(visibleRecs.length)})
          </button>
          {actionTypes.map(at => (
            <button
              key={at.type}
              type="button"
              onClick={() => { setActiveFilter(activeFilter === at.type ? null : at.type); }}
              className={[
                'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                activeFilter === at.type
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
        <div className="text-sm text-text-secondary">Loading recommendations...</div>
      )}
      {savingsQuery.status === 'error' && (
        <div className="rounded-lg border border-negative bg-negative-muted px-4 py-3 text-sm text-negative">
          {savingsQuery.error.message}
        </div>
      )}

      {filtered.length > 0 && (
        <div className="rounded-xl border border-border bg-bg-secondary/50 overflow-hidden p-4">
          <DataTable<SavingsRecommendation>
            data={filtered}
            columns={savingsColumns}
            sorting={sorting}
            onSortingChange={setSorting}
            renderExpandedRow={(rec) => <SavingsDetail rec={rec} />}
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

function SavingsDetail({ rec }: Readonly<{ rec: SavingsRecommendation }>) {
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
