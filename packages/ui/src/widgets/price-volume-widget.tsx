import { useMemo, useState } from 'react';
import { PriceVolumeChart } from '../components/price-volume-chart.js';
import { CoinRainLoader } from '../components/coin-rain-loader.js';
import { GroupByTitle } from '../components/group-by-title.js';
import { signedDollars } from '../components/format.js';
import { asEntityRef, asTagValue } from '@costgoblin/core/browser';
import type { DimensionId } from '@costgoblin/core/browser';
import type { WidgetCommonProps } from './widget.js';
import { dimensionLabelFor } from './widget.js';
import { usePairedGroups } from '../hooks/use-aggregated-groups.js';
import type { AggGroupPair } from '../hooks/use-aggregated-groups.js';
import { decomposePriceVolume } from '../lib/price-volume.js';
import type { PriceVolumeDecomp } from '../lib/price-volume.js';

// The groups decomposed: each period's ROW_LIMIT largest by the size of their
// cost, each paired with its real cost in the other period. When a period has
// more groups than that, the ones past the limit in both are left out of the
// ranking and the totals, and the subtitle says so. A left-out group is no
// bigger than the last one listed in either period, so it changed by at most
// those two sizes together: it can only outrank a shown change smaller than
// that.
const ROW_LIMIT = 500;

function decomposePair({ name, current, previous }: AggGroupPair): PriceVolumeDecomp {
  return decomposePriceVolume({
    name,
    entity: asEntityRef(name),
    prevCost: previous?.cost ?? 0,
    currCost: current?.cost ?? 0,
    prevUsage: previous?.usageAmount ?? 0,
    currUsage: current?.usageAmount ?? 0,
    ...(previous === null ? {} : { prevListCost: previous.listCost }),
    ...(current === null ? {} : { currListCost: current.listCost }),
  });
}

export function PriceVolumeWidget({ spec, dateRange, previousDateRange, granularity, globalFilters, dimensions, onSetFilter }: WidgetCommonProps) {
  const [groupByOverride, setGroupByOverride] = useState<DimensionId | undefined>(undefined);
  const specGroupBy = spec.type === 'priceVolume' ? spec.groupBy : undefined;
  const effectiveGroupBy = groupByOverride ?? specGroupBy;
  const topN = spec.type === 'priceVolume' ? (spec.topN ?? 6) : 6;

  // Always compares — the decomposition is inherently period-over-period.
  const query = usePairedGroups({
    groupBy: effectiveGroupBy,
    dateRange,
    previousDateRange,
    granularity,
    globalFilters,
    rowLimit: ROW_LIMIT,
    origin: `widget:priceVolume:${String(effectiveGroupBy ?? '')}`,
  });
  const paired = query.status === 'success' ? query.data : null;

  const all = useMemo<PriceVolumeDecomp[]>(
    () => (paired === null ? [] : paired.pairs.map(decomposePair).filter(d => d.totalDelta !== 0)),
    [paired],
  );

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

  if (query.status === 'loading' || query.status === 'idle') return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-4">
      <CoinRainLoader height={260} count={5} />
    </div>
  );

  if (query.status === 'error') return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-4">
      <div className="mb-2">{title}</div>
      <div className="flex items-center justify-center h-[240px] text-xs text-warning">Query failed: {query.error.message}</div>
    </div>
  );

  if (shown.length === 0) return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-4">
      <div className="mb-2">{title}</div>
      <div className="flex items-center justify-center h-[240px] text-xs text-text-muted">No period-over-period change to decompose.</div>
    </div>
  );

  const capNote = paired?.capped === true ? ` · top ${String(ROW_LIMIT)} per period` : '';
  const subtitle = `Net ${signedDollars(totals.net)} · Vol ${signedDollars(totals.volume)} / Rate ${signedDollars(totals.rate)}${capNote}`;

  return (
    <PriceVolumeChart
      rows={shown}
      title={title}
      subtitle={subtitle}
      onRowClick={(row) => { onSetFilter(effectiveGroupBy, asTagValue(row.name)); }}
    />
  );
}
