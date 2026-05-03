import { useEffect, useRef, useState } from 'react';
import { getColor } from '../lib/palette.js';
import { formatDollars } from './format.js';
import { CoinRainLoader } from './coin-rain-loader.js';
import { usePalette } from '../hooks/use-palette.js';

export interface BarDay {
  readonly date: string;
  readonly total: number;
  readonly breakdown: Readonly<Record<string, number>>;
}

export type HistogramTab = 'owner' | 'product' | 'service';

interface StackedBarChartProps {
  readonly days: readonly BarDay[];
  readonly highlightedGroup?: string | null;
  readonly tab?: HistogramTab | undefined;
  readonly onTabChange?: ((tab: HistogramTab) => void) | undefined;
  readonly expanded?: boolean | undefined;
  readonly onExpandToggle?: (() => void) | undefined;
  readonly title?: string | undefined;
  readonly loading?: boolean | undefined;
  readonly onSegmentClick?: ((name: string) => void) | undefined;
}

export function bucketBars(bars: readonly BarDay[], maxBuckets: number): readonly BarDay[] {
  if (bars.length <= maxBuckets) return bars;
  const size = Math.ceil(bars.length / maxBuckets);
  const result: BarDay[] = [];
  for (let i = 0; i < bars.length; i += size) {
    const chunk = bars.slice(i, i + size);
    const merged: Record<string, number> = {};
    let total = 0;
    for (const bar of chunk) {
      total += bar.total;
      for (const [key, val] of Object.entries(bar.breakdown)) {
        merged[key] = (merged[key] ?? 0) + val;
      }
    }
    const first = chunk[0];
    if (first !== undefined) {
      result.push({ date: first.date, total, breakdown: merged });
    }
  }
  return result;
}

interface BarSegmentProps {
  readonly seg: { readonly key: string; readonly value: number; readonly colorIdx: number };
  readonly segTotal: number;
  readonly highlightedGroup?: string | null | undefined;
  readonly palette: readonly string[];
  readonly onMouseEnter: () => void;
  readonly onSegmentClick?: ((name: string) => void) | undefined;
}

function BarSegment({ seg, segTotal, highlightedGroup, palette, onMouseEnter, onSegmentClick }: BarSegmentProps) {
  const pct = segTotal > 0 ? (seg.value / segTotal) * 100 : 0;
  const color = getColor(seg.colorIdx, palette);
  const isDimmed = highlightedGroup !== null && highlightedGroup !== undefined && highlightedGroup !== seg.key;
  return (
    <div
      onMouseEnter={onMouseEnter}
      onClick={(e) => { e.stopPropagation(); onSegmentClick?.(seg.key); }}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); onSegmentClick?.(seg.key); } }}
      role={onSegmentClick !== undefined ? 'button' : undefined}
      tabIndex={onSegmentClick !== undefined ? 0 : undefined}
      style={{
        height: `${String(pct)}%`,
        backgroundColor: color,
        opacity: isDimmed ? 0.25 : 0.85,
        transition: 'opacity 0.15s',
        cursor: onSegmentClick !== undefined ? 'pointer' : undefined,
      }}
    />
  );
}

export function StackedBarChart({ days, highlightedGroup, tab, onTabChange, expanded, onExpandToggle, title, loading, onSegmentClick }: StackedBarChartProps) {
  const { palette } = usePalette();
  const [hoveredDay, setHoveredDay] = useState<string | null>(null);
  const [hoveredSegment, setHoveredSegment] = useState<string | null>(null);
  const highlightRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    highlightRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [hoveredSegment]);

  const allKeys = new Set<string>();
  for (const day of days) {
    for (const key of Object.keys(day.breakdown)) {
      allKeys.add(key);
    }
  }
  const breakdownKeys = [...allKeys];

  const maxCost = days.reduce((m, d) => Math.max(m, d.total), 0);

  return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 px-5 py-4 flex flex-col h-full">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-text-secondary">{title ?? 'Daily Costs'}</h3>
        <div className="flex items-center gap-2">
        {tab !== undefined && onTabChange !== undefined && (
          <div className="flex items-center gap-1 rounded-lg border border-border bg-bg-tertiary/30 p-0.5">
            {([
              { key: 'owner' as const, label: 'Groups' },
              { key: 'product' as const, label: 'Products' },
              { key: 'service' as const, label: 'Services' },
            ]).map(t => (
              <button
                key={t.key}
                type="button"
                onClick={() => { onTabChange(t.key); }}
                className={[
                  'rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors',
                  tab === t.key
                    ? 'bg-accent text-bg-primary shadow-sm'
                    : 'text-text-secondary hover:text-text-primary',
                ].join(' ')}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}
        {onExpandToggle !== undefined && (
          <button
            type="button"
            onClick={onExpandToggle}
            className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-tertiary/50 transition-colors"
            title={expanded ? 'Collapse' : 'Expand'}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M1 5V1h4M9 1h4v4M1 9v4h4M9 13h4v-4" />
            </svg>
          </button>
        )}
        </div>
      </div>

      {days.length > 0 ? (() => {
        const minChartHeight = expanded ? 360 : 180;
        const ticks = [1, 0.75, 0.5, 0.25, 0];
        return (
        <div className="relative flex-1 pb-7" style={{ minHeight: `${String(minChartHeight)}px` }}>
          {/* Y axis ticks */}
          <div className="absolute left-0 top-0 bottom-7 w-10">
            {ticks.map(pct => (
              <div
                key={pct}
                className="absolute right-0 flex items-center"
                style={{ top: `${String((1 - pct) * 100)}%`, transform: 'translateY(-50%)' }}
              >
                <span className="text-[10px] text-text-muted tabular-nums">{formatDollars(maxCost * pct)}</span>
              </div>
            ))}
          </div>

          {/* Grid lines */}
          <div className="absolute left-12 right-0 top-0 bottom-7">
            {ticks.map(pct => (
              <div
                key={pct}
                className="absolute left-0 right-0 border-b border-border-subtle/50"
                style={{ top: `${String((1 - pct) * 100)}%` }}
              />
            ))}
          </div>

          {/* Floating tooltip — opposite side of hovered bar, full height */}
          {hoveredDay !== null && (() => {
            const idx = days.findIndex(d => d.date === hoveredDay);
            if (idx < 0) return null;
            const day = days[idx];
            if (day === undefined) return null;
            const onLeft = idx < days.length / 2;
            const prev = idx > 0 ? days[idx - 1] : undefined;
            const prevTotal = prev?.total ?? 0;
            const totalDelta = prev !== undefined && prevTotal > 0
              ? ((day.total - prevTotal) / prevTotal) * 100
              : undefined;
            const segs = breakdownKeys
              .map((key, ki) => ({ key, value: day.breakdown[key] ?? 0, colorIdx: ki }))
              .filter(s => s.value > 0)
              .sort((a, b) => b.value - a.value);
            const segTotal = segs.reduce((sum, s) => sum + s.value, 0);
            return (
              <div className={`pointer-events-none absolute top-0 bottom-0 z-20 ${onLeft ? 'right-0 mr-1' : 'left-12 ml-1'}`}>
                <div className="rounded-lg bg-bg-secondary/95 px-4 py-3 text-[11px] text-text-primary whitespace-nowrap shadow-lg border border-border min-w-[280px] max-h-full overflow-y-auto">
                  <div className="flex items-center justify-between mb-2 pb-2 border-b border-border-subtle">
                    <span className="font-semibold text-xs">{day.date}</span>
                    <span className="font-semibold text-xs">
                      Total: {formatDollars(day.total)}
                      {totalDelta !== undefined && (
                        <span className={`ml-1.5 text-[10px] font-normal ${totalDelta >= 0 ? 'text-negative' : 'text-positive'}`}>
                          {totalDelta >= 0 ? '↑' : '↓'}{Math.abs(totalDelta).toFixed(1)}%
                        </span>
                      )}
                    </span>
                  </div>
                  <div className="flex flex-col gap-px">
                    {segs.slice(0, 12).map(seg => {
                      const color = getColor(seg.colorIdx, palette);
                      const isHigh = highlightedGroup === seg.key || hoveredSegment === seg.key;
                      const pct = segTotal > 0 ? (seg.value / segTotal) * 100 : 0;
                      const prevVal = prev?.breakdown[seg.key] ?? 0;
                      const delta = prev !== undefined && prevVal > 0
                        ? ((seg.value - prevVal) / prevVal) * 100
                        : undefined;
                      return (
                        <div key={seg.key} ref={isHigh ? highlightRef : undefined} className={`flex items-center gap-2 rounded py-0.5 px-1 -mx-1 ${isHigh ? 'bg-white/10' : ''}`}>
                          <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
                          <span className={`truncate flex-1 min-w-0 ${isHigh ? 'text-text-primary font-semibold' : 'text-text-secondary'}`}>{seg.key}</span>
                          <span className={`tabular-nums shrink-0 ${isHigh ? 'font-semibold' : ''}`}>
                            {formatDollars(seg.value)} <span className="text-text-muted">({pct.toFixed(1)}%)</span>
                          </span>
                          {delta !== undefined && (
                            <span className={`tabular-nums text-[10px] shrink-0 ${delta >= 0 ? 'text-negative' : 'text-positive'}`}>
                              {delta >= 0 ? '↑' : '↓'}{Math.abs(delta).toFixed(1)}%
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })()}

          <div className="absolute left-12 right-0 top-0 bottom-7 flex items-end z-10" style={{ gap: days.length > 100 ? '1px' : '2px' }}>
            {days.map((day) => {
              const barPct = maxCost > 0 ? (day.total / maxCost) * 100 : 0;
              const segments = breakdownKeys
                .map((key, ki) => ({
                  key,
                  value: day.breakdown[key] ?? 0,
                  colorIdx: ki,
                }))
                .filter(s => s.value > 0)
                .sort((a, b) => b.value - a.value);
              const segTotal = segments.reduce((sum, s) => sum + s.value, 0);

              return (
                <button
                  type="button"
                  key={day.date}
                  className="group relative flex-1 min-w-0"
                  style={{ height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}
                  onMouseEnter={() => { setHoveredDay(day.date); }}
                  onMouseLeave={() => { setHoveredDay(null); setHoveredSegment(null); }}
                >
                  <div
                    className="w-full overflow-hidden rounded-t-sm"
                    style={{ height: `${String(barPct)}%`, minHeight: barPct > 0 ? '2px' : '0' }}
                  >
                    {segments.map(seg => (
                      <BarSegment
                        key={seg.key}
                        seg={seg}
                        segTotal={segTotal}
                        highlightedGroup={highlightedGroup}
                        palette={palette}
                        onMouseEnter={() => { setHoveredSegment(seg.key); }}
                        onSegmentClick={onSegmentClick}
                      />
                    ))}
                  </div>

                </button>
              );
            })}
          </div>

          {/* X axis — pinned to bottom of pb-5 zone */}
          <div className="absolute bottom-0 left-12 right-0 h-5">
            {days.map((day, idx) => {
              const step = Math.max(1, Math.ceil(days.length / 7));
              if (idx % step !== 0) return null;
              const pct = days.length > 1 ? (idx / (days.length - 1)) * 100 : 0;
              const isFirst = idx === 0;
              const isLast = idx >= days.length - step;
              let align = '-translate-x-1/2';
              if (isFirst) align = '';
              else if (isLast) align = '-translate-x-full';
              return (
                <span
                  key={day.date}
                  className={`absolute text-[10px] text-text-muted whitespace-nowrap ${align}`}
                  style={{ left: `${String(pct)}%` }}
                >
                  {day.date.slice(5)}
                </span>
              );
            })}
          </div>
        </div>
        );
      })() : (() => {
        const placeholder = loading === true ? (
          <div className="flex-1 min-h-40 flex items-center justify-center">
            <CoinRainLoader height={expanded ? 340 : 160} count={6} />
          </div>
        ) : (
          <div className="flex items-center justify-center flex-1 min-h-40 text-sm text-text-muted">No daily data</div>
        );
        return placeholder;
      })()}
    </div>
  );
}
