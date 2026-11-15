import { memo, useState, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Group } from '@visx/group';
import { Pie } from '@visx/shape';
import { OTHER_COLOR } from '../lib/palette.js';
import type { SeriesColors } from '../lib/palette.js';
import { CollapsedChart } from './collapsed-chart.js';
import { useContainerWidth } from '../lib/use-container-width.js';
import { formatDollars } from './format.js';
import type { Dimension } from '@costgoblin/core/browser';
import { getDimensionId, getDimensionLabel } from '../lib/dimensions.js';
import { useSeriesColors } from '../hooks/use-palette.js';

export interface PieSlice {
  readonly name: string;
  readonly cost: number;
  readonly percentage: number;
}

interface PieChartProps {
  readonly data: readonly PieSlice[];
  readonly title: React.ReactNode;
  readonly subtitle?: string;
  readonly onSliceClick?: (name: string) => void;
  readonly onSliceHover?: (name: string | null) => void;
  readonly externalHoveredName?: string | null;
  readonly collapsed?: boolean;
  readonly onExpandToggle?: () => void;
  readonly maxSlices?: number;
  readonly dimensions?: readonly Dimension[] | undefined;
  readonly activeDimensionId?: string | undefined;
  readonly onDimensionChange?: ((dimId: string) => void) | undefined;
  readonly previousCosts?: ReadonlyMap<string, number> | undefined;
  readonly showLegend?: boolean | undefined;
}

const OTHER_KEY = 'Other';

/** A drawn slice. `folded` marks the remainder aggregateOther adds, so a real
 *  entity that happens to be named "Other" is colored and clickable. */
interface DisplaySlice extends PieSlice {
  readonly folded: boolean;
}

// Keys and hover state for the folded remainder. No billing value starts with
// a NUL, so a real "Other" keeps its own row and its own hover.
const FOLDED_ID = '\u0000other';

function sliceId(slice: DisplaySlice): string {
  return slice.folded ? FOLDED_ID : slice.name;
}

function aggregateOther(data: readonly PieSlice[], maxSlices: number): DisplaySlice[] {
  const top = data.slice(0, maxSlices).map(d => ({ ...d, folded: false }));
  if (data.length <= maxSlices) return top;
  const rest = data.slice(maxSlices);
  const otherCost = rest.reduce((s, d) => s + d.cost, 0);
  const otherPct = rest.reduce((s, d) => s + d.percentage, 0);
  return [...top, { name: OTHER_KEY, cost: otherCost, percentage: otherPct, folded: true }];
}


function legendTextClass(isDimmed: boolean, isHovered: boolean): string {
  if (isDimmed) return 'text-text-muted';
  if (isHovered) return 'text-text-primary font-semibold';
  return 'text-text-secondary';
}

function sliceColor(slice: DisplaySlice, seriesColor: SeriesColors): string {
  return slice.folded ? OTHER_COLOR : seriesColor(slice.name);
}

/** A slice's change since the previous period, in percent. None without a
 *  previous cost to divide by. */
function percentDelta(cost: number, previousCost: number | undefined): number | undefined {
  return previousCost !== undefined && previousCost > 0 ? ((cost - previousCost) / previousCost) * 100 : undefined;
}

// A dashboard renders its pies on every cross-chart hover, whichever chart
// the pointer is over: the widget reads the focus, and hands the pie new
// handler closures and a new title element. The plot, the legend, the slices
// and the legend rows are drawn through `memo` so that such a render draws
// what it changes: nothing when the focus is on another dimension, the slice
// and the row that take or lose it when it moves. (A focus that appears or
// goes dims or lights every slice, so all of them render.) That holds only
// while every prop they get keeps its identity across the chart's renders:
// the memoized slices and colors, primitives, and callbacks that don't change
// (`onSliceClick` is the chart's own, not the host's).

/** What a slice and its legend row do with the pointer. */
interface SliceHandlers {
  readonly onEnter: (slice: DisplaySlice) => void;
  readonly onLeave: () => void;
  readonly onSliceClick: ((name: string) => void) | undefined;
}

interface PieSliceMarkProps extends SliceHandlers {
  readonly slice: DisplaySlice;
  readonly path: string;
  readonly color: string;
  readonly hovered: boolean;
  readonly dimmed: boolean;
}

function PieSliceMark({ slice, path, color, hovered, dimmed, onEnter, onLeave, onSliceClick }: PieSliceMarkProps) {
  const sliceName = slice.name;
  const interactive = !slice.folded && onSliceClick !== undefined;

  return (
    <g
      onMouseEnter={() => { onEnter(slice); }}
      onMouseLeave={onLeave}
      onClick={() => { if (interactive) onSliceClick(sliceName); }}
      onKeyDown={(e) => { if (interactive && (e.key === 'Enter' || e.key === ' ')) onSliceClick(sliceName); }}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      style={{ cursor: interactive ? 'pointer' : 'default' }}
    >
      <path
        d={path}
        fill={color}
        opacity={dimmed ? 0.3 : 1}
        stroke={hovered ? '#ffffff' : 'transparent'}
        strokeWidth={hovered ? 2 : 0}
        style={{
          filter: hovered ? 'brightness(1.3)' : 'none',
          transition: 'all 0.15s ease',
        }}
      />
    </g>
  );
}

const MemoPieSliceMark = memo(PieSliceMark);

interface PiePlotProps extends SliceHandlers {
  // visx takes a mutable array.
  readonly slices: DisplaySlice[];
  readonly pieSize: number;
  readonly hoveredId: string | null;
  readonly seriesColor: SeriesColors;
}

function PiePlot({ slices, pieSize, hoveredId, seriesColor, onEnter, onLeave, onSliceClick }: PiePlotProps) {
  const radius = pieSize / 2;

  return (
    <svg width={pieSize + 32} height={pieSize + 16}>
      <Group top={radius + 8} left={radius + 16}>
        <Pie<DisplaySlice>
          data={slices}
          pieValue={(d) => d.cost}
          outerRadius={radius}
          innerRadius={0}
          padAngle={0.015}
        >
          {(pie) =>
            pie.arcs.map((arc) => {
              const id = sliceId(arc.data);
              return (
                <MemoPieSliceMark
                  key={id}
                  slice={arc.data}
                  path={pie.path(arc) ?? ''}
                  color={sliceColor(arc.data, seriesColor)}
                  hovered={hoveredId === id}
                  dimmed={hoveredId !== null && hoveredId !== id}
                  onEnter={onEnter}
                  onLeave={onLeave}
                  onSliceClick={onSliceClick}
                />
              );
            })
          }
        </Pie>
      </Group>
    </svg>
  );
}

const MemoPiePlot = memo(PiePlot);

interface PieLegendRowProps extends SliceHandlers {
  readonly slice: DisplaySlice;
  readonly color: string;
  readonly hovered: boolean;
  readonly dimmed: boolean;
  readonly previousCost: number | undefined;
  /** Tells the chart which element draws the row, or null when it's gone. */
  readonly registerRow: (id: string, el: HTMLElement | null) => void;
}

function PieLegendRow({ slice, color, hovered, dimmed, previousCost, registerRow, onEnter, onLeave, onSliceClick }: PieLegendRowProps) {
  const id = sliceId(slice);
  const itemRef = useCallback((el: HTMLElement | null) => { registerRow(id, el); }, [id, registerRow]);
  const pctDelta = percentDelta(slice.cost, previousCost);

  const isInteractive = !slice.folded && onSliceClick !== undefined;
  const itemClassName = [
    'rounded text-[11px] transition-colors w-full text-left',
    isInteractive ? 'cursor-pointer' : '',
    hovered ? 'bg-accent-muted/50 px-1.5 py-1' : 'flex items-center gap-1.5 px-1.5 py-0.5',
  ].join(' ');
  const itemProps = {
    onMouseEnter: () => { onEnter(slice); },
    onMouseLeave: onLeave,
  };

  const content = hovered ? (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1.5">
        <span className="inline-block w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: color }} />
        <span className="font-semibold text-text-primary text-xs break-all">{slice.name}</span>
      </div>
      <div className="flex items-center gap-2 pl-4">
        <span className="tabular-nums text-text-primary font-medium">{formatDollars(slice.cost)} ({slice.percentage.toFixed(1)}%)</span>
        {pctDelta !== undefined && (
          <span className={`text-[10px] tabular-nums ${pctDelta >= 0 ? 'text-negative' : 'text-positive'}`}>
            {pctDelta >= 0 ? '↑' : '↓'}{Math.abs(pctDelta).toFixed(1)}%
          </span>
        )}
      </div>
    </div>
  ) : (
    <>
      <span className="inline-block w-2 h-2 rounded-sm shrink-0" style={{ backgroundColor: color }} />
      <span className={`truncate min-w-0 flex-1 ${legendTextClass(dimmed, hovered)}`}>
        {slice.name}
      </span>
      <span className={`tabular-nums shrink-0 whitespace-nowrap ${legendTextClass(dimmed, hovered)}`}>
        {formatDollars(slice.cost)} ({slice.percentage.toFixed(1)}%)
      </span>
      {pctDelta !== undefined && (
        <span className={`text-[10px] tabular-nums shrink-0 ${pctDelta >= 0 ? 'text-negative' : 'text-positive'}`}>
          {pctDelta >= 0 ? '↑' : '↓'}{Math.abs(pctDelta).toFixed(1)}%
        </span>
      )}
    </>
  );

  if (isInteractive) {
    return (
      <button
        type="button"
        ref={itemRef}
        {...itemProps}
        onClick={() => { onSliceClick(slice.name); }}
        className={`${itemClassName} bg-transparent border-none p-0 font-[inherit]`}
      >
        {content}
      </button>
    );
  }

  return (
    <div
      ref={itemRef}
      {...itemProps}
      className={itemClassName}
    >
      {content}
    </div>
  );
}

const MemoPieLegendRow = memo(PieLegendRow);

interface PieLegendProps extends SliceHandlers {
  readonly slices: readonly DisplaySlice[];
  readonly hoveredId: string | null;
  readonly seriesColor: SeriesColors;
  readonly previousCosts: ReadonlyMap<string, number> | undefined;
  readonly registerRow: (id: string, el: HTMLElement | null) => void;
}

/** The legend — HTML for proper text truncation. */
function PieLegend({ slices, hoveredId, seriesColor, previousCosts, registerRow, onEnter, onLeave, onSliceClick }: PieLegendProps) {
  return (
    <div className="flex-1 min-w-0 overflow-y-auto flex flex-col gap-0.5 py-1">
      {slices.map((d) => {
        const id = sliceId(d);
        return (
          <MemoPieLegendRow
            key={id}
            slice={d}
            color={sliceColor(d, seriesColor)}
            hovered={hoveredId === id}
            dimmed={hoveredId !== null && hoveredId !== id}
            previousCost={previousCosts?.get(d.name)}
            registerRow={registerRow}
            onEnter={onEnter}
            onLeave={onLeave}
            onSliceClick={onSliceClick}
          />
        );
      })}
    </div>
  );
}

const MemoPieLegend = memo(PieLegend);

function PieChartInner({
  data,
  title,
  subtitle,
  onSliceClick,
  onSliceHover,
  externalHoveredName,
  onExpandToggle,
  maxSlices = 50,
  dimensions,
  activeDimensionId,
  onDimensionChange,
  previousCosts,
  showLegend = true,
  width,
  height,
}: Omit<PieChartProps, 'collapsed'> & { width: number; height: number }) {
  const [localHovered, setLocalHovered] = useState<string | null>(null);
  const hoveredName = externalHoveredName ?? localHovered;
  const legendRows = useRef(new Map<string, HTMLElement>());
  const registerRow = useCallback((id: string, el: HTMLElement | null) => {
    if (el === null) { legendRows.current.delete(id); } else { legendRows.current.set(id, el); }
  }, []);

  useEffect(() => {
    if (hoveredName !== null) {
      legendRows.current.get(hoveredName)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [hoveredName]);

  const displayData = useMemo(() => aggregateOther(data, maxSlices), [data, maxSlices]);
  const ranked = useMemo(() => displayData.filter(d => !d.folded), [displayData]);
  const seriesColor = useSeriesColors(ranked);
  const pieSize = showLegend ? Math.min(width * 0.38, height - 60) : Math.min(width - 32, height - 60);

  // The host hands over new closures on each of its renders, and it renders
  // on every cross-chart hover. The slices and rows get callbacks that last
  // the chart's life, which call the closures of the render on screen: the
  // refs are set at commit, so a render React has started and not committed
  // (a transition) can't change what the slices on screen do.
  const onSliceHoverRef = useRef(onSliceHover);
  const onSliceClickRef = useRef(onSliceClick);
  useLayoutEffect(() => {
    onSliceHoverRef.current = onSliceHover;
    onSliceClickRef.current = onSliceClick;
  });

  // The folded remainder is no entity, so it highlights nothing elsewhere.
  const handleMouseEnter = useCallback((slice: DisplaySlice) => {
    setLocalHovered(sliceId(slice));
    onSliceHoverRef.current?.(slice.folded ? null : slice.name);
  }, []);

  const handleMouseLeave = useCallback(() => {
    setLocalHovered(null);
    onSliceHoverRef.current?.(null);
  }, []);

  const clickSlice = useCallback((name: string) => { onSliceClickRef.current?.(name); }, []);
  const sliceClick = onSliceClick === undefined ? undefined : clickSlice;

  return (
    <div
      className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-4 flex flex-col h-full"
      onMouseLeave={handleMouseLeave}
    >
      <div className="flex items-center justify-between mb-3">
        {dimensions !== undefined && dimensions.length > 0 && onDimensionChange !== undefined ? (
          <select
            value={activeDimensionId ?? ''}
            onChange={(e) => { onDimensionChange(e.target.value); }}
            aria-label="Group by dimension"
            className="text-sm font-medium text-text-secondary bg-transparent border-none outline-none cursor-pointer hover:text-text-primary transition-colors appearance-none pr-4"
            style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg width=\'10\' height=\'6\' viewBox=\'0 0 10 6\' fill=\'none\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cpath d=\'M1 1l4 4 4-4\' stroke=\'%236b7280\' stroke-width=\'1.5\' stroke-linecap=\'round\'/%3E%3C/svg%3E")', backgroundRepeat: 'no-repeat', backgroundPosition: 'right center' }}
          >
            {dimensions.map(d => (
              <option key={getDimensionId(d)} value={getDimensionId(d)}>
                {getDimensionLabel(d)}
              </option>
            ))}
          </select>
        ) : (
          <h3 className="text-sm font-medium text-text-secondary">{title}</h3>
        )}
        <div className="flex items-center gap-2">
          {subtitle !== undefined && (
            <span className="text-[11px] text-text-muted">{subtitle}</span>
          )}
          {onExpandToggle !== undefined && (
            <button
              type="button"
              onClick={onExpandToggle}
              className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-tertiary/50 transition-colors"
              title="Toggle expand"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M1 5V1h4M9 1h4v4M1 9v4h4M9 13h4v-4" />
              </svg>
            </button>
          )}
        </div>
      </div>
      <div className="flex flex-1 min-h-0 gap-2 relative">
        {/* Pie */}
        <div className={showLegend ? 'shrink-0' : 'flex-1 flex justify-center'} style={showLegend ? { width: pieSize + 32 } : undefined}>
          <MemoPiePlot
            slices={displayData}
            pieSize={pieSize}
            hoveredId={hoveredName}
            seriesColor={seriesColor}
            onEnter={handleMouseEnter}
            onLeave={handleMouseLeave}
            onSliceClick={sliceClick}
          />
        </div>

        {/* Hover label for no-legend mode */}
        {!showLegend && hoveredName !== null && (() => {
          const d = displayData.find(s => sliceId(s) === hoveredName);
          if (d === undefined) return null;
          const pctDelta = percentDelta(d.cost, previousCosts?.get(d.name));
          return (
            <div className="absolute left-1/2 -translate-x-1/2 bottom-2 z-10 rounded-lg bg-bg-secondary/95 border border-border shadow-lg px-3 py-2 text-xs pointer-events-none whitespace-nowrap">
              <span className="font-semibold text-text-primary">{d.name}</span>
              <span className="ml-2 tabular-nums text-text-secondary">{formatDollars(d.cost)} ({d.percentage.toFixed(1)}%)</span>
              {pctDelta !== undefined && (
                <span className={`ml-1.5 tabular-nums text-[10px] ${pctDelta >= 0 ? 'text-negative' : 'text-positive'}`}>
                  {pctDelta >= 0 ? '↑' : '↓'}{Math.abs(pctDelta).toFixed(1)}%
                </span>
              )}
            </div>
          );
        })()}

        {showLegend && (
          <MemoPieLegend
            slices={displayData}
            hoveredId={hoveredName}
            seriesColor={seriesColor}
            previousCosts={previousCosts}
            registerRow={registerRow}
            onEnter={handleMouseEnter}
            onLeave={handleMouseLeave}
            onSliceClick={sliceClick}
          />
        )}
      </div>
    </div>
  );
}

const PIE_HEIGHT = 320;

export function PieChart(props: PieChartProps) {
  const [containerRef, width] = useContainerWidth();

  if (props.collapsed) {
    return <CollapsedChart title={props.title} onExpandToggle={props.onExpandToggle} />;
  }

  return (
    <div ref={containerRef} style={{ height: PIE_HEIGHT, overflow: 'hidden' }}>
      {width > 10 && <PieChartInner {...props} width={width} height={PIE_HEIGHT} />}
    </div>
  );
}
