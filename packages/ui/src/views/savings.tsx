import type { SavingsResult, SavingsRecommendation } from '@costgoblin/core/browser';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { formatDollars } from '../components/format.js';
import { useState, useMemo, Fragment } from 'react';

type SortField = 'monthlySavings' | 'savingsPercentage' | 'monthlyCost' | 'effort' | 'accountName';

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
  return action.replace(/([a-z])([A-Z])/g, '$1 $2');
}

interface ParsedDetails {
  config: Record<string, string>;
  usages: { type: string; amount: string; unit: string }[];
}

function parseResourceDetails(json: string): ParsedDetails | null {
  if (json.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const topKey = Object.keys(parsed)[0];
    if (topKey === undefined) return null;
    const inner = (parsed as Record<string, unknown>)[topKey];
    if (typeof inner !== 'object' || inner === null) return null;
    const obj = inner as Record<string, unknown>;

    const config: Record<string, string> = {};
    const rawConfig = obj['configuration'];
    if (typeof rawConfig === 'object' && rawConfig !== null) {
      for (const [section, value] of Object.entries(rawConfig as Record<string, unknown>)) {
        if (typeof value === 'object' && value !== null) {
          for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            config[`${section}.${k}`] = String(v);
          }
        } else {
          config[section] = String(value);
        }
      }
    }

    const usages: ParsedDetails['usages'] = [];
    const costCalc = obj['costCalculation'];
    if (typeof costCalc === 'object' && costCalc !== null) {
      const rawUsages = (costCalc as Record<string, unknown>)['usages'];
      if (Array.isArray(rawUsages)) {
        for (const u of rawUsages) {
          if (typeof u === 'object' && u !== null) {
            const usage = u as Record<string, unknown>;
            const uType = usage['usageType'];
            const uAmount = usage['usageAmount'];
            const uUnit = usage['unit'];
            usages.push({
              type: typeof uType === 'string' ? uType : '',
              amount: typeof uAmount === 'number' ? String(uAmount) : typeof uAmount === 'string' ? uAmount : '',
              unit: typeof uUnit === 'string' ? uUnit : '',
            });
          }
        }
      }
    }

    return { config, usages };
  } catch {
    return null;
  }
}

export function Savings() {
  const api = useCostApi();
  const savingsQuery = useQuery(() => api.querySavings(), [api]);
  const [sortField, setSortField] = useState<SortField>('monthlySavings');
  const [sortAsc, setSortAsc] = useState(false);
  const [activeFilter, setActiveFilter] = useState<string | null>(null);
  const [expandedRow, setExpandedRow] = useState<number | null>(null);

  const data: SavingsResult | null =
    savingsQuery.status === 'success' ? savingsQuery.data : null;

  const actionTypes = useMemo(() => {
    if (data === null) return [];
    const map = new Map<string, { count: number; savings: number }>();
    for (const rec of data.recommendations) {
      const existing = map.get(rec.actionType);
      if (existing !== undefined) {
        existing.count++;
        existing.savings += rec.monthlySavings;
      } else {
        map.set(rec.actionType, { count: 1, savings: rec.monthlySavings });
      }
    }
    return [...map.entries()]
      .sort((a, b) => b[1].savings - a[1].savings)
      .map(([type, info]) => ({ type, ...info }));
  }, [data]);

  const filtered = useMemo(() => {
    if (data === null) return [];
    const recs = activeFilter !== null
      ? data.recommendations.filter(r => r.actionType === activeFilter)
      : [...data.recommendations];
    return recs.sort((a, b) => {
      let cmp: number;
      switch (sortField) {
        case 'monthlySavings': cmp = a.monthlySavings - b.monthlySavings; break;
        case 'savingsPercentage': cmp = a.savingsPercentage - b.savingsPercentage; break;
        case 'monthlyCost': cmp = a.monthlyCost - b.monthlyCost; break;
        case 'effort': cmp = (EFFORT_ORDER[a.effort] ?? 4) - (EFFORT_ORDER[b.effort] ?? 4); break;
        case 'accountName': cmp = a.accountName.localeCompare(b.accountName); break;
        default: cmp = 0;
      }
      return sortAsc ? cmp : -cmp;
    });
  }, [data, activeFilter, sortField, sortAsc]);

  const filteredSavings = filtered.reduce((s, r) => s + r.monthlySavings, 0);

  function handleSort(field: SortField) {
    if (sortField === field) {
      setSortAsc(prev => !prev);
    } else {
      setSortField(field);
      setSortAsc(false);
    }
  }

  function sortIndicator(field: SortField): string {
    if (sortField !== field) return '';
    return sortAsc ? ' \u25B2' : ' \u25BC';
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <h2 className="text-xl font-semibold text-text-primary">Savings Opportunities</h2>
        <p className="text-sm text-text-secondary mt-1">AWS cost optimization recommendations</p>
      </div>

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
            All ({String(data?.recommendations.length ?? 0)})
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
        <div className="rounded-xl border border-border bg-bg-secondary/50 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-text-secondary">
                <th className="px-4 pb-3 pt-4 font-medium">Recommendation</th>
                <th className="px-4 pb-3 pt-4 font-medium cursor-pointer hover:text-text-primary" onClick={() => { handleSort('accountName'); }}>
                  Account{sortIndicator('accountName')}
                </th>
                <th className="px-4 pb-3 pt-4 font-medium">Region</th>
                <th className="px-4 pb-3 pt-4 text-right font-medium cursor-pointer hover:text-text-primary" onClick={() => { handleSort('monthlyCost'); }}>
                  Monthly Cost{sortIndicator('monthlyCost')}
                </th>
                <th className="px-4 pb-3 pt-4 text-right font-medium cursor-pointer hover:text-text-primary" onClick={() => { handleSort('monthlySavings'); }}>
                  Savings/mo{sortIndicator('monthlySavings')}
                </th>
                <th className="px-4 pb-3 pt-4 text-right font-medium cursor-pointer hover:text-text-primary" onClick={() => { handleSort('savingsPercentage'); }}>
                  %{sortIndicator('savingsPercentage')}
                </th>
                <th className="px-4 pb-3 pt-4 font-medium cursor-pointer hover:text-text-primary" onClick={() => { handleSort('effort'); }}>
                  Effort{sortIndicator('effort')}
                </th>
              </tr>
            </thead>
              {filtered.map((rec: SavingsRecommendation, i: number) => {
                const isExpanded = expandedRow === i;
                const current = isExpanded ? parseResourceDetails(rec.currentDetails) : null;
                const recommended = isExpanded ? parseResourceDetails(rec.recommendedDetails) : null;
                return (
                  <tbody key={`group-${String(i)}`}>
                  <tr className={`border-b ${isExpanded ? 'border-border bg-bg-tertiary/20' : 'border-border-subtle'} hover:bg-bg-tertiary/30 transition-colors cursor-pointer`} onClick={() => { setExpandedRow(isExpanded ? null : i); }}>
                    <td className="px-4 py-3 max-w-lg">
                      <div className="flex items-baseline gap-2">
                        <span className="text-text-primary text-xs font-medium shrink-0">{humanizeAction(rec.actionType)}</span>
                        {rec.resourceArn.length > 0 && (
                          <span className="text-text-muted text-[10px] font-mono truncate" title={rec.resourceArn}>{rec.resourceArn.split(':').pop() ?? rec.resourceArn}</span>
                        )}
                      </div>
                      <p className="text-text-muted text-xs mt-0.5 truncate" title={rec.summary}>{rec.summary}</p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-text-secondary text-xs">{rec.accountName}</p>
                      <p className="text-text-muted text-[10px] font-mono">{rec.accountId}</p>
                    </td>
                    <td className="px-4 py-3 text-text-secondary text-xs">{rec.region}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-text-secondary">{formatDollars(rec.monthlyCost)}</td>
                    <td className="px-4 py-3 text-right tabular-nums font-medium text-accent">{formatDollars(rec.monthlySavings)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-text-secondary">{String(Math.round(rec.savingsPercentage))}%</td>
                    <td className="px-4 py-3">
                      <span className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-medium ${effortColor(rec.effort)}`}>
                        {effortLabel(rec.effort)}
                      </span>
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr key={`detail-${String(i)}`} className="border-b border-border bg-bg-tertiary/10">
                      <td colSpan={7} className="px-6 py-4">
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
                                {current.usages.map((u, ui) => (
                                  <p key={ui} className="text-text-secondary">{u.amount} {u.unit} <span className="text-text-muted">({u.type.split('-').pop() ?? u.type})</span></p>
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
                      </td>
                    </tr>
                  )}
                  </tbody>
                );
              })}
          </table>
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
