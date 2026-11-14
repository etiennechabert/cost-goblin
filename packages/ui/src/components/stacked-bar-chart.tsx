import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { formatDollars } from './format.js';
import { CoinRainLoader } from './coin-rain-loader.js';
import { useSeriesColors } from '../hooks/use-palette.js';
import { brighten } from '../lib/palette.js';
import type { SeriesColors } from '../lib/palette.js';
import { useBarDragSelect } from '../hooks/use-bar-drag-select.js';
import type { Granularity } from '@costgoblin/core/browser';
import { isPeriodGranularity } from '@costgoblin/core/browser';
import { costsTitle } from '../lib/dates.js';
import { formatBucketKey } from '../lib/drag-select.js';

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
  readonly title?: React.ReactNode | undefined;
  readonly loading?: boolean | undefined;
  readonly onSegmentClick?: ((name: string) => void) | undefined;
  /** Previous period daily totals, aligned by position index. Rendered as
   *  a dashed line overlay when present. */
  readonly previousTotals?: readonly number[] | undefined;
  readonly onRangeSelect?: ((startIdx: number, endIdx: number) => void) | undefined;
  /** What a bar's `date` is: a weekly/monthly period start is labelled as its
   *  period (`W43 2026`, `Oct 2026`) on the axis, the tooltip and the drag edges. */
  readonly granularity?: Granularity | undefined;
  /** Fires when the focused series changes — either the user moused into a
   *  bar segment or hovered a row in the floating tooltip. Lets the host
   *  widget propagate to the global cross-chart focus so sibling pies dim
   *  the same way pie→histogram already does. Called with null on leave. */
  readonly onSegmentHover?: ((name: string | null) => void) | undefined;
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

type Segment = { readonly key: string; readonly value: number; readonly color: string };

/** A day's positive series, largest first. */
function daySegments(day: BarDay, seriesColor: SeriesColors): Segment[] {
  return Object.entries(day.breakdown)
    .filter(([, value]) => value > 0)
    .map(([key, value]) => ({ key, value, color: seriesColor(key) }))
    .sort((a, b) => b.value - a.value);
}

// How much of its color a segment shows: most of it, a quarter while another
// series is focused, all of it (brightened, outlined) when it is the focused
// one. The first two are one number the plot sets and every segment's color
// reads, not an `opacity` on each segment: an element with its own opacity (or
// filter) is a compositing group of its own, and Chromium regroups them all
// (Layerize) on every frame in which anything on the page moves. A month of
// daily bars with a few hundred series is thousands of segments, which made
// each such frame cost several milliseconds.
const SERIES_ALPHA = '--series-alpha';
const SEGMENT_ALPHA = 0.85;
const DIMMED_ALPHA = 0.25;
const FOCUSED_BRIGHTNESS = 1.2;

/** The most segments a chart fades between those looks. Each fading segment
 *  is restyled and repainted on every frame of the fade, so a chart with more
 *  switches at once. */
const FADE_MAX_SEGMENTS = 1500;

type PlotStyle = React.CSSProperties & Readonly<Record<typeof SERIES_ALPHA, number>>;

interface TooltipSegmentRowProps {
  readonly seg: Segment;
  readonly isHigh: boolean;
  readonly pct: number;
  readonly delta: number | undefined;
  readonly highlightRef: React.RefObject<HTMLDivElement | null>;
  readonly setHoveredSegment: (key: string | null) => void;
}

function TooltipSegmentRow({ seg, isHigh, pct, delta, highlightRef, setHoveredSegment }: TooltipSegmentRowProps) {
  return (
    <div
      ref={isHigh ? highlightRef : undefined}
      onMouseEnter={() => { setHoveredSegment(seg.key); }}
      onMouseLeave={() => { setHoveredSegment(null); }}
      className={`pointer-events-auto flex items-center gap-2 rounded py-0.5 px-1 -mx-1 cursor-default ${isHigh ? 'bg-white/10' : ''}`}
    >
      <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: seg.color }} />
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
}

// A chart of a month of daily bars with a few hundred series draws thousands
// of segments, and the pointer moving over it changes the hovered day or the
// focused series on most frames. BarColumn and BarSegment are drawn through
// `memo` so that such a change renders what it changes: nothing for the
// hovered day, the segments that take or lose the focus for the series. That
// holds only while every prop they get keeps its identity across the chart's
// renders: state setters, values from `bars`, primitives, and callbacks that
// don't change (`onSegmentClick` is the chart's own, not the host's).

interface BarSegmentProps {
  readonly seg: Segment;
  readonly segTotal: number;
  readonly focused: boolean;
  readonly fades: boolean;
  readonly setHoveredSegment: (key: string | null) => void;
  readonly onSegmentClick?: ((name: string) => void) | undefined;
}

function BarSegment({ seg, segTotal, focused, fades, setHoveredSegment, onSegmentClick }: BarSegmentProps) {
  const onMouseEnter = (): void => { setHoveredSegment(seg.key); };
  const pct = segTotal > 0 ? (seg.value / segTotal) * 100 : 0;
  // Match the pie chart's emphasis: the other series fade to a quarter (the
  // plot's --series-alpha), the focused one shows at full strength with a
  // subtle brightness boost and a thin white outline inset, so it reads as
  // "selected" the way a pie slice does on hover.
  const baseStyle: React.CSSProperties = {
    height: `${String(pct)}%`,
    backgroundColor: focused
      ? brighten(seg.color, FOCUSED_BRIGHTNESS)
      : `rgb(from ${seg.color} r g b / var(${SERIES_ALPHA}))`,
    boxShadow: focused ? 'inset 0 0 0 1.5px rgb(255 255 255)' : 'none',
    transition: fades ? 'background-color 0.15s, box-shadow 0.15s' : 'none',
  };
  if (onSegmentClick !== undefined) {
    return (
      <button
        type="button"
        onMouseEnter={onMouseEnter}
        onClick={(e) => { e.stopPropagation(); onSegmentClick(seg.key); }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); onSegmentClick(seg.key); } }}
        className="w-full cursor-pointer border-none p-0 m-0 bg-transparent block"
        style={baseStyle}
      />
    );
  }
  return (
    <div
      onMouseEnter={onMouseEnter}
      style={baseStyle}
    />
  );
}

const MemoBarSegment = memo(BarSegment);

/** A day's bar: its segments and what they add up to. */
interface Bar {
  readonly day: BarDay;
  readonly segments: readonly Segment[];
  readonly segTotal: number;
}

interface BarColumnProps extends Bar {
  readonly barPct: number;
  readonly highlightedGroup?: string | null | undefined;
  readonly fades: boolean;
  readonly onSegmentClick?: ((name: string) => void) | undefined;
  readonly setHoveredDay: (date: string | null) => void;
  readonly setHoveredSegment: (key: string | null) => void;
}

function BarColumn({ day, segments, segTotal, barPct, highlightedGroup, fades, onSegmentClick, setHoveredDay, setHoveredSegment }: BarColumnProps) {
  return (
    <div
      className="group relative flex-1 min-w-0"
      style={{ height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}
      onMouseEnter={() => { setHoveredDay(day.date); setHoveredSegment(null); }}
    >
      <div
        className="w-full overflow-hidden rounded-t-sm"
        style={{ height: `${String(barPct)}%`, minHeight: barPct > 0 ? '2px' : '0' }}
      >
        {segments.map(seg => (
          <MemoBarSegment
            key={seg.key}
            seg={seg}
            segTotal={segTotal}
            focused={highlightedGroup === seg.key}
            fades={fades}
            setHoveredSegment={setHoveredSegment}
            onSegmentClick={onSegmentClick}
          />
        ))}
      </div>
    </div>
  );
}

const MemoBarColumn = memo(BarColumn);

export function StackedBarChart({ days, highlightedGroup, tab, onTabChange, expanded, onExpandToggle, title, loading, onSegmentClick, previousTotals, onRangeSelect, granularity, onSegmentHover }: StackedBarChartProps) {
  const [hoveredDay, setHoveredDay] = useState<string | null>(null);
  const [hoveredSegment, setHoveredSegment] = useState<string | null>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const barsRef = useRef<HTMLDivElement>(null);

  const { isDragging, overlay, selection, handleMouseDown } = useBarDragSelect({
    containerRef: barsRef,
    bucketCount: days.length,
    onRangeSelect,
    disabled: onRangeSelect === undefined || loading === true,
  });

  const periodLabels = granularity !== undefined && isPeriodGranularity(granularity);
  // Daily and hourly axes keep their compact MM-DD form.
  const axisLabel = (date: string): string => periodLabels ? formatBucketKey(date, granularity) : date.slice(5);

  const dragLabels = (() => {
    if (selection === null) return null;
    const startBar = days[selection.startIdx];
    const endBar = days[selection.endIdx];
    if (startBar === undefined || endBar === undefined) return null;
    return { start: formatBucketKey(startBar.date, granularity), end: formatBucketKey(endBar.date, granularity) };
  })();

  useEffect(() => {
    highlightRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [hoveredSegment]);

  // Surface the local hover to the widget host so it can lift it into the
  // global cross-chart focus. Mirror of the pie chart's onSliceHover. The
  // callback is held in a ref so an unstable parent reference can't retrigger
  // the effect on every render — that path is an infinite-update loop when
  // the parent's dispatch causes any re-render.
  const onSegmentHoverRef = useRef(onSegmentHover);
  onSegmentHoverRef.current = onSegmentHover;
  useEffect(() => {
    onSegmentHoverRef.current?.(hoveredSegment);
  }, [hoveredSegment]);

  // The host hands over a new click closure on each of its renders, and it
  // renders on every cross-chart hover (this chart reporting its own focus,
  // for one). The bars get one callback for the chart's life, which calls the
  // closure of the render on screen: the ref is set at commit, so a render
  // React has started and not committed (a transition) can't change what a
  // click on the bars it hasn't replaced yet does.
  const onSegmentClickRef = useRef(onSegmentClick);
  useLayoutEffect(() => { onSegmentClickRef.current = onSegmentClick; });
  const clickSegment = useCallback((name: string) => { onSegmentClickRef.current?.(name); }, []);
  const segmentClick = onSegmentClick === undefined ? undefined : clickSegment;

  // Each series' cost over the whole range ranks it for color, the way the
  // pie and every other widget over the same range rank it.
  const seriesTotals = useMemo(() => {
    const totals = new Map<string, number>();
    for (const day of days) {
      for (const [name, cost] of Object.entries(day.breakdown)) {
        totals.set(name, (totals.get(name) ?? 0) + cost);
      }
    }
    return [...totals].map(([name, cost]) => ({ name, cost }));
  }, [days]);
  const seriesColor = useSeriesColors(seriesTotals);

  const prevMax = previousTotals === undefined ? 0 : previousTotals.reduce((m, v) => Math.max(m, v), 0);
  const maxCost = Math.max(days.reduce((m, d) => Math.max(m, d.total), 0), prevMax);

  const bars = useMemo(() => days.map((day): Bar => {
    const segments = daySegments(day, seriesColor);
    return { day, segments, segTotal: segments.reduce((sum, seg) => sum + seg.value, 0) };
  }), [days, seriesColor]);
  const fades = bars.reduce((count, bar) => count + bar.segments.length, 0) <= FADE_MAX_SEGMENTS;

  // Either an external focus signal or a row the user is currently pointing at
  // in the tooltip should fade the other series to match how pies behave.
  const focusedKey = highlightedGroup ?? hoveredSegment;
  const plotStyle: PlotStyle = {
    gap: days.length > 100 ? '1px' : '2px',
    [SERIES_ALPHA]: focusedKey === null ? SEGMENT_ALPHA : DIMMED_ALPHA,
  };

  return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 px-5 py-4 flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-text-secondary">{title ?? costsTitle(granularity ?? 'daily')}</h3>
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
        <div
          className="relative flex-1 pb-7"
          style={{ minHeight: `${String(minChartHeight)}px` }}
          onMouseLeave={() => { setHoveredDay(null); setHoveredSegment(null); }}
        >
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
          {hoveredDay !== null && !isDragging && (() => {
            const idx = days.findIndex(d => d.date === hoveredDay);
            if (idx < 0) return null;
            const day = days[idx];
            if (day === undefined) return null;
            const onLeft = idx < days.length / 2;
            const prevPeriodTotal = previousTotals === undefined ? undefined : previousTotals[idx];
            const prev = idx > 0 ? days[idx - 1] : undefined;
            const compTotal = prevPeriodTotal ?? prev?.total;
            const totalDelta = compTotal !== undefined && compTotal > 0
              ? ((day.total - compTotal) / compTotal) * 100
              : undefined;
            const segs = daySegments(day, seriesColor);
            const segTotal = segs.reduce((sum, s) => sum + s.value, 0);
            return (
              <div className={`absolute top-0 bottom-0 z-20 ${onLeft ? 'right-0 mr-1' : 'left-12 ml-1'}`}>
                <div className="rounded-lg bg-bg-secondary/95 px-4 py-3 text-[11px] text-text-primary whitespace-nowrap shadow-lg border border-border min-w-[280px] max-h-full overflow-y-auto">
                  <div className="mb-2 pb-2 border-b border-border-subtle flex flex-col gap-0.5">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-xs">{periodLabels ? axisLabel(day.date) : day.date}</span>
                      <span className="font-semibold text-xs">
                        Total: {formatDollars(day.total)}
                        {totalDelta !== undefined && (
                          <span className={`ml-1.5 text-[10px] font-normal ${totalDelta >= 0 ? 'text-negative' : 'text-positive'}`}>
                            {totalDelta >= 0 ? '↑' : '↓'}{Math.abs(totalDelta).toFixed(1)}%
                          </span>
                        )}
                      </span>
                    </div>
                    {prevPeriodTotal !== undefined && prevPeriodTotal > 0 && (
                      <div className="flex items-center justify-between text-text-muted">
                        <span className="text-[10px]">Previous period</span>
                        <span className="text-[10px] tabular-nums">Total: {formatDollars(prevPeriodTotal)}</span>
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col gap-px">
                    {segs.slice(0, 12).map(seg => {
                      const isHigh = highlightedGroup === seg.key || hoveredSegment === seg.key;
                      const pct = segTotal > 0 ? (seg.value / segTotal) * 100 : 0;
                      const prevVal = prev?.breakdown[seg.key] ?? 0;
                      const delta = prev !== undefined && prevVal > 0
                        ? ((seg.value - prevVal) / prevVal) * 100
                        : undefined;
                      return (
                        <TooltipSegmentRow
                          key={seg.key}
                          seg={seg}
                          isHigh={isHigh}
                          pct={pct}
                          delta={delta}
                          highlightRef={highlightRef}
                          setHoveredSegment={setHoveredSegment}
                        />
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })()}

          <div
            ref={barsRef}
            role={onRangeSelect === undefined ? undefined : 'button'}
            tabIndex={onRangeSelect === undefined ? undefined : 0}
            // The plot draws its own drag selection: no app-wide state layer over it.
            data-feedback="none"
            className={[
              'absolute left-12 right-0 top-0 bottom-7 flex items-end z-10 outline-none',
              onRangeSelect === undefined ? '' : 'cursor-crosshair select-none',
            ].join(' ')}
            style={plotStyle}
            onMouseDown={handleMouseDown}
            onKeyDown={() => { /* pixel drag has no keyboard equivalent */ }}
          >
            {bars.map(({ day, segments, segTotal }) => {
              const barPct = maxCost > 0 ? (day.total / maxCost) * 100 : 0;

              return (
                <MemoBarColumn
                  key={day.date}
                  day={day}
                  segments={segments}
                  segTotal={segTotal}
                  barPct={barPct}
                  highlightedGroup={focusedKey}
                  fades={fades}
                  onSegmentClick={segmentClick}
                  setHoveredDay={setHoveredDay}
                  setHoveredSegment={setHoveredSegment}
                />
              );
            })}
            {overlay !== null && (
              <div
                className="pointer-events-none absolute top-0 bottom-0 bg-accent/20 border-l border-r border-accent z-30"
                style={{ left: overlay.left, width: overlay.width }}
              />
            )}
            {overlay !== null && dragLabels !== null && (
              <>
                <div
                  className="pointer-events-none absolute -top-5 z-40 -translate-x-1/2 rounded bg-accent px-1.5 py-0.5 text-[10px] font-medium text-bg-primary shadow whitespace-nowrap tabular-nums"
                  style={{ left: overlay.left }}
                >
                  {dragLabels.start}
                </div>
                <div
                  className="pointer-events-none absolute -top-5 z-40 -translate-x-1/2 rounded bg-accent px-1.5 py-0.5 text-[10px] font-medium text-bg-primary shadow whitespace-nowrap tabular-nums"
                  style={{ left: overlay.left + overlay.width }}
                >
                  {dragLabels.end}
                </div>
              </>
            )}
          </div>

          {/* Previous period overlay line */}
          {previousTotals !== undefined && previousTotals.length > 0 && maxCost > 0 && (
            <div className="absolute left-12 right-0 top-0 bottom-7 z-[11] pointer-events-none">
              <svg
                width="100%"
                height="100%"
                viewBox="0 0 1000 1000"
                preserveAspectRatio="none"
              >
                <polyline
                  fill="none"
                  stroke="var(--color-text-secondary)"
                  strokeWidth="2.5"
                  strokeDasharray="6,3"
                  strokeOpacity="0.8"
                  vectorEffect="non-scaling-stroke"
                  points={previousTotals.map((val, i) => {
                    const x = previousTotals.length > 1
                      ? (i / (previousTotals.length - 1)) * 1000
                      : 500;
                    const y = (1 - val / maxCost) * 1000;
                    return `${String(x)},${String(y)}`;
                  }).join(' ')}
                />
              </svg>
            </div>
          )}

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
                  {axisLabel(day.date)}
                </span>
              );
            })}
          </div>
        </div>
        );
      })() : (() => {
        const placeholder = loading === true ? (
          <div className="flex-1 min-h-40">
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
