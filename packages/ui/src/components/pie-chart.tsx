import { useState, useCallback, useEffect, useRef } from 'react';
import { Group } from '@visx/group';
import { Pie } from '@visx/shape';
import { getColor } from '../lib/palette.js';
import { CollapsedChart } from './collapsed-chart.js';
import { useContainerWidth } from '../lib/use-container-width.js';
import { formatDollars } from './format.js';
import type { Dimension } from '@costgoblin/core/browser';
import { getDimensionId, getDimensionLabel } from '../lib/dimensions.js';
import { usePalette } from '../hooks/use-palette.js';

export interface PieSlice {
  readonly name: string;
  readonly cost: number;
  readonly percentage: number;
}

interface PieChartProps {
  readonly data: readonly PieSlice[];
  readonly title: string;
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

function aggregateOther(data: readonly PieSlice[], maxSlices: number): PieSlice[] {
  if (data.length <= maxSlices) return [...data];
  const top = data.slice(0, maxSlices);
  const rest = data.slice(maxSlices);
  const otherCost = rest.reduce((s, d) => s + d.cost, 0);
  const otherPct = rest.reduce((s, d) => s + d.percentage, 0);
  return [...top, { name: OTHER_KEY, cost: otherCost, percentage: otherPct }];
}


function legendTextClass(isDimmed: boolean, isHovered: boolean): string {
  if (isDimmed) return 'text-text-muted';
  if (isHovered) return 'text-text-primary font-semibold';
  return 'text-text-secondary';
}

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
  const { palette } = usePalette();
  const [localHovered, setLocalHovered] = useState<string | null>(null);
  const hoveredName = externalHoveredName ?? localHovered;
  const legendRefs = useRef(new Map<string, HTMLDivElement>());

  useEffect(() => {
    if (hoveredName !== null) {
      legendRefs.current.get(hoveredName)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [hoveredName]);

  const displayData = aggregateOther(data, maxSlices);
  const pieSize = showLegend ? Math.min(width * 0.38, height - 60) : Math.min(width - 32, height - 60);
  const radius = pieSize / 2;

  const handleMouseEnter = useCallback((name: string) => {
    setLocalHovered(name);
    onSliceHover?.(name);
  }, [onSliceHover]);

  const handleMouseLeave = useCallback(() => {
    setLocalHovered(null);
    onSliceHover?.(null);
  }, [onSliceHover]);

  return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-4 flex flex-col h-full">
      <div className="flex items-center justify-between mb-3">
        {dimensions !== undefined && dimensions.length > 0 && onDimensionChange !== undefined ? (
          <select
            value={activeDimensionId ?? ''}
            onChange={(e) => { onDimensionChange(e.target.value); }}
            aria-label={`Group by dimension (current: ${title})`}
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
          <svg width={pieSize + 32} height={pieSize + 16}>
            <Group top={radius + 8} left={radius + 16}>
              <Pie<PieSlice>
                data={displayData}
                pieValue={(d) => d.cost}
                outerRadius={radius}
                innerRadius={0}
                padAngle={0.015}
              >
                {(pie) =>
                  pie.arcs.map((arc, i) => {
                    const sliceName = arc.data.name;
                    const color = sliceName === OTHER_KEY ? '#374151' : getColor(i, palette);
                    const isHovered = hoveredName === sliceName;
                    const isDimmed = hoveredName !== null && !isHovered;
                    const path = pie.path(arc) ?? '';

                    return (
                      <g
                        key={sliceName}
                        onMouseEnter={() => { handleMouseEnter(sliceName); }}
                        onMouseLeave={handleMouseLeave}
                        onClick={() => { if (sliceName !== OTHER_KEY) onSliceClick?.(sliceName); }}
                        onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && sliceName !== OTHER_KEY) onSliceClick?.(sliceName); }}
                        role={sliceName !== OTHER_KEY && onSliceClick !== undefined ? 'button' : undefined}
                        tabIndex={sliceName !== OTHER_KEY && onSliceClick !== undefined ? 0 : undefined}
                        style={{ cursor: sliceName !== OTHER_KEY && onSliceClick !== undefined ? 'pointer' : 'default' }}
                      >
                        <path
                          d={path}
                          fill={color}
                          opacity={isDimmed ? 0.3 : 1}
                          stroke={isHovered ? '#ffffff' : 'transparent'}
                          strokeWidth={isHovered ? 2 : 0}
                          style={{
                            filter: isHovered ? 'brightness(1.3)' : 'none',
                            transition: 'all 0.15s ease',
                          }}
                        />
                      </g>
                    );
                  })
                }
              </Pie>
            </Group>
          </svg>
        </div>

        {/* Hover label for no-legend mode */}
        {!showLegend && hoveredName !== null && (() => {
          const d = displayData.find(s => s.name === hoveredName);
          if (d === undefined) return null;
          const prev = previousCosts?.get(d.name);
          const pctDelta = prev !== undefined && prev > 0 ? ((d.cost - prev) / prev) * 100 : undefined;
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

        {/* Legend — HTML for proper text truncation */}
        {showLegend && <div className="flex-1 min-w-0 overflow-y-auto flex flex-col gap-0.5 py-1">
          {displayData.map((d, i) => {
            const color = d.name === OTHER_KEY ? '#374151' : getColor(i, palette);
            const isHovered = hoveredName === d.name;
            const isDimmed = hoveredName !== null && !isHovered;

            return (
              <div
                key={d.name}
                ref={(el) => { if (el === null) { legendRefs.current.delete(d.name); } else { legendRefs.current.set(d.name, el); } }}
                onMouseEnter={() => { handleMouseEnter(d.name); }}
                onMouseLeave={handleMouseLeave}
                onClick={() => { if (d.name !== OTHER_KEY) onSliceClick?.(d.name); }}
                onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && d.name !== OTHER_KEY) onSliceClick?.(d.name); }}
                role={d.name !== OTHER_KEY && onSliceClick !== undefined ? 'button' : undefined}
                tabIndex={d.name !== OTHER_KEY && onSliceClick !== undefined ? 0 : undefined}
                className={[
                  'rounded text-[11px] transition-colors',
                  d.name !== OTHER_KEY && onSliceClick !== undefined ? 'cursor-pointer' : '',
                  isHovered ? 'bg-accent-muted/50 px-1.5 py-1' : 'flex items-center gap-1.5 px-1.5 py-0.5',
                ].join(' ')}
              >
                {isHovered ? (
                  <div className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-1.5">
                      <span className="inline-block w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: color }} />
                      <span className="font-semibold text-text-primary text-xs break-all">{d.name}</span>
                    </div>
                    <div className="flex items-center gap-2 pl-4">
                      <span className="tabular-nums text-text-primary font-medium">{formatDollars(d.cost)} ({d.percentage.toFixed(1)}%)</span>
                      {(() => {
                        const prev = previousCosts?.get(d.name);
                        if (prev === undefined || prev <= 0) return null;
                        const pctDelta = ((d.cost - prev) / prev) * 100;
                        return (
                          <span className={`text-[10px] tabular-nums ${pctDelta >= 0 ? 'text-negative' : 'text-positive'}`}>
                            {pctDelta >= 0 ? '↑' : '↓'}{Math.abs(pctDelta).toFixed(1)}%
                          </span>
                        );
                      })()}
                    </div>
                  </div>
                ) : (
                  <>
                    <span className="inline-block w-2 h-2 rounded-sm shrink-0" style={{ backgroundColor: color }} />
                    <span className={`truncate min-w-0 flex-1 ${legendTextClass(isDimmed, isHovered)}`}>
                      {d.name}
                    </span>
                    <span className={`tabular-nums shrink-0 whitespace-nowrap ${legendTextClass(isDimmed, isHovered)}`}>
                      {formatDollars(d.cost)} ({d.percentage.toFixed(1)}%)
                    </span>
                    {(() => {
                      const prev = previousCosts?.get(d.name);
                      if (prev === undefined || prev <= 0) return null;
                      const pctDelta = ((d.cost - prev) / prev) * 100;
                      return (
                        <span className={`text-[10px] tabular-nums shrink-0 ${pctDelta >= 0 ? 'text-negative' : 'text-positive'}`}>
                          {pctDelta >= 0 ? '↑' : '↓'}{Math.abs(pctDelta).toFixed(1)}%
                        </span>
                      );
                    })()}
                  </>
                )}
              </div>
            );
          })}
        </div>}
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
