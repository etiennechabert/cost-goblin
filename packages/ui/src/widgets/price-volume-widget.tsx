import { useMemo, useState } from 'react';
import { PriceVolumeChart } from '../components/price-volume-chart.js';
import { CoinRainLoader } from '../components/coin-rain-loader.js';
import { GroupByTitle } from '../components/group-by-title.js';
import { signedDollars } from '../components/format.js';
import { asEntityRef, asTagValue } from '@costgoblin/core/browser';
import type { DimensionId } from '@costgoblin/core/browser';
import type { WidgetCommonProps } from './widget.js';
import { dimensionLabelFor } from './widget.js';
import { useAggregatedGroups } from '../hooks/use-aggregated-groups.js';
import { decomposePriceVolume } from '../lib/price-volume.js';
import type { PriceVolumeDecomp } from '../lib/price-volume.js';

// Current and previous periods are fetched as independent top-N-by-cost sets;
// a group present in one cap but not the other is treated as zero on the
// missing side, which can fabricate a spurious volume spike. Keep the cap well
// above the distinct-group count of realistic price-volume dimensions
// (service, sku_meter, tags) so that boundary only ever falls on negligible
// long-tail groups.
const ROW_LIMIT = 500;

export function PriceVolumeWidget({ spec, dateRange, previousDateRange, granularity, globalFilters, dimensions, onSetFilter }: WidgetCommonProps) {
  const [groupByOverride, setGroupByOverride] = useState<DimensionId | undefined>(undefined);
  const specGroupBy = spec.type === 'priceVolume' ? spec.groupBy : undefined;
  const effectiveGroupBy = groupByOverride ?? specGroupBy;
  const topN = spec.type === 'priceVolume' ? (spec.topN ?? 6) : 6;

  // Always compares — the decomposition is inherently period-over-period.
  const { status, error, rows, prevByName } = useAggregatedGroups({
    groupBy: effectiveGroupBy,
    dateRange,
    previousDateRange,
    comparePrev: true,
    granularity,
    globalFilters,
    rowLimit: ROW_LIMIT,
    origin: `widget:priceVolume:${String(effectiveGroupBy ?? '')}`,
  });

  const all = useMemo<PriceVolumeDecomp[]>(() => {
    if (prevByName === null) return [];
    const curByName = new Map(rows.map(r => [r.name, r]));
    const names = new Set<string>([...curByName.keys(), ...prevByName.keys()]);
    return [...names].map(name => {
      const cur = curByName.get(name);
      const prev = prevByName.get(name);
      return decomposePriceVolume({
        name,
        entity: asEntityRef(name),
        prevCost: prev?.cost ?? 0,
        currCost: cur?.cost ?? 0,
        prevUsage: prev?.usageAmount ?? 0,
        currUsage: cur?.usageAmount ?? 0,
        ...(prev === undefined ? {} : { prevListCost: prev.listCost }),
        ...(cur === undefined ? {} : { currListCost: cur.listCost }),
      });
    }).filter(d => d.totalDelta !== 0);
  }, [rows, prevByName]);

  const shown = useMemo(
    () => [...all].sort((a, b) => Math.abs(b.totalDelta) - Math.abs(a.totalDelta)).slice(0, topN),
    [all, topN],
  );

  const totals = useMemo(() => ({
    net: all.reduce((s, d) => s + d.totalDelta, 0),
    volume: all.reduce((s, d) => s + d.volumeEffect, 0),
    rate: all.reduce((s, d) => s + d.rateEffect, 0),
  }), [all]);

  if (spec.type !== 'priceVolume' || effectiveGroupBy === undefined) return null;

  const label = dimensionLabelFor(dimensions, effectiveGroupBy);
  const title = spec.title ?? (
    <GroupByTitle dimensions={dimensions} currentGroupBy={effectiveGroupBy} onGroupByChange={setGroupByOverride} label={label} suffix="price vs volume" />
  );

  if (status === 'loading' || status === 'idle') return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-4">
      <CoinRainLoader height={260} count={5} />
    </div>
  );

  if (status === 'error') return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-4">
      <div className="mb-2">{title}</div>
      <div className="flex items-center justify-center h-[240px] text-xs text-warning">Query failed: {error?.message ?? 'unknown error'}</div>
    </div>
  );

  if (shown.length === 0) return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-4">
      <div className="mb-2">{title}</div>
      <div className="flex items-center justify-center h-[240px] text-xs text-text-muted">No period-over-period change to decompose.</div>
    </div>
  );

  const subtitle = `Net ${signedDollars(totals.net)} · Vol ${signedDollars(totals.volume)} / Rate ${signedDollars(totals.rate)}`;

  return (
    <PriceVolumeChart
      rows={shown}
      title={title}
      subtitle={subtitle}
      onRowClick={(row) => { onSetFilter(effectiveGroupBy, asTagValue(row.name)); }}
    />
  );
}
