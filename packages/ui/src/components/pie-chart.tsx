import { useState, useCallback, useRef, useEffect } from 'react';
import { Group } from '@visx/group';
import { Pie } from '@visx/shape';
import { PALETTE_STANDARD } from '../lib/palette.js';
import { formatDollars } from './format.js';
import type { Dimension } from '@costgoblin/core/browser';
import { getDimensionId, getDimensionLabel } from '../lib/dimensions.js';

export interface PieSlice {
  readonly name: string;
  readonly cost: number;
  readonly percentage: number;
}

interface PieChartProps {
  data: readonly PieSlice[];
  title: string;
  subtitle?: string;
  onSliceClick?: (name: string) => void;
  onSliceHover?: (name: string | null) => void;
  externalHoveredName?: string | null;
  collapsed?: boolean;
  onExpandToggle?: () => void;
  maxSlices?: number;
  dimensions?: readonly Dimension[] | undefined;
  activeDimensionId?: string | undefined;
  onDimensionChange?: ((dimId: string) => void) | undefined;
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

function CollapsedPie({ title, onExpandToggle }: { title: string; onExpandToggle?: (() => void) | undefined }) {
  return (
    <button
      type="button"
      onClick={onExpandToggle}
      className="flex flex-col items-center justify-center gap-2 rounded-xl border border-border bg-bg-secondary/50 px-2 py-6 hover:bg-bg-tertiary/30 transition-colors min-h-[260px]"
    >
      <span className="text-xs font-medium text-text-secondary [writing-mode:vertical-rl] rotate-180">
        {title}
      </span>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-text-muted">
        <rect x="2" y="2" width="12" height="12" rx="2" />
        <path d="M6 4v8M10 4v8" />
      </svg>
    </button>
  );
}

function PieChartInner({
  data,
  title,
  subtitle,
  onSliceClick,
  onSliceHover,
  externalHoveredName,
  onExpandToggle,
  maxSlices = 15,
  dimensions,
  activeDimensionId,
  onDimensionChange,
  width,
  height,
}: Omit<PieChartProps, 'collapsed'> & { width: number; height: number }) {
  const [localHovered, setLocalHovered] = useState<string | null>(null);
  const hoveredName = externalHoveredName ?? localHovered;

  const displayData = aggregateOther(data, maxSlices);
  const pieSize = Math.min(width * 0.42, height - 60);
  const radius = pieSize / 2;
  const centerX = radius + 16;
  const centerY = height / 2;

  const handleMouseEnter = useCallback((name: string) => {
    setLocalHovered(name);
    onSliceHover?.(name);
  }, [onSliceHover]);

  const handleMouseLeave = useCallback(() => {
    setLocalHovered(null);
    onSliceHover?.(null);
  }, [onSliceHover]);

  const legendX = pieSize + 44;

  return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-4 flex flex-col">
      <div className="flex items-center justify-between mb-3">
        {dimensions !== undefined && dimensions.length > 0 && onDimensionChange !== undefined ? (
          <select
            value={activeDimensionId ?? ''}
            onChange={(e) => { onDimensionChange(e.target.value); }}
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
      <svg width={width} height={height - 50}>
        <Group top={centerY - 25} left={centerX}>
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
                const color = sliceName === OTHER_KEY ? '#374151' : PALETTE_STANDARD[i % PALETTE_STANDARD.length] ?? '#374151';
                const isHovered = hoveredName === sliceName;
                const isDimmed = hoveredName !== null && !isHovered;
                const path = pie.path(arc) ?? '';

                return (
                  <g
                    key={sliceName}
                    onMouseEnter={() => { handleMouseEnter(sliceName); }}
                    onMouseLeave={handleMouseLeave}
                    onClick={() => { if (sliceName !== OTHER_KEY) onSliceClick?.(sliceName); }}
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

        {/* Legend */}
        <Group top={6} left={legendX}>
          {displayData.map((d, i) => {
            const color = d.name === OTHER_KEY ? '#374151' : PALETTE_STANDARD[i % PALETTE_STANDARD.length] ?? '#374151';
            const isHovered = hoveredName === d.name;
            const isDimmed = hoveredName !== null && !isHovered;
            const y = i * 22;
            if (y > height - 80) return null;

            return (
              <g
                key={d.name}
                onMouseEnter={() => { handleMouseEnter(d.name); }}
                onMouseLeave={handleMouseLeave}
                onClick={() => { if (d.name !== OTHER_KEY) onSliceClick?.(d.name); }}
                style={{ cursor: d.name !== OTHER_KEY && onSliceClick !== undefined ? 'pointer' : 'default' }}
              >
                {isHovered && (
                  <rect
                    x={-6}
                    y={y - 4}
                    width={width - legendX}
                    height={20}
                    rx={4}
                    fill="rgba(255,255,255,0.08)"
                  />
                )}
                <rect x={0} y={y} width={8} height={8} rx={2} fill={color} />
                <text
                  x={14}
                  y={y + 8}
                  fontSize={isHovered ? 12 : 11}
                  fill={isDimmed ? '#4b5563' : isHovered ? '#f3f4f6' : '#9ca3af'}
                  fontWeight={isHovered ? 600 : 400}
                  style={{ transition: 'all 0.12s' }}
                >
                  {d.name.length > 22 ? `${d.name.slice(0, 21)}…` : d.name}
                  {' — '}
                  {formatDollars(d.cost)}
                  {` (${d.percentage.toFixed(1)}%)`}
                </text>
              </g>
            );
          })}
        </Group>
      </svg>
    </div>
  );
}

function useContainerWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) {
        setWidth(entry.contentRect.width);
      }
    });
    ro.observe(el);
    return () => { ro.disconnect(); };
  }, []);

  return [ref, width];
}

const PIE_HEIGHT = 320;

export function PieChart(props: PieChartProps) {
  const [containerRef, width] = useContainerWidth();

  if (props.collapsed) {
    return <CollapsedPie title={props.title} onExpandToggle={props.onExpandToggle} />;
  }

  return (
    <div ref={containerRef} style={{ height: PIE_HEIGHT, overflow: 'hidden' }}>
      {width > 10 && <PieChartInner {...props} width={width} height={PIE_HEIGHT} />}
    </div>
  );
}
