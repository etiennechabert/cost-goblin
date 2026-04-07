import { useState, useCallback } from 'react';
import { Group } from '@visx/group';
import { Pie } from '@visx/shape';
import { ParentSize } from '@visx/responsive';
import { PALETTE_STANDARD } from '../lib/palette.js';
import { formatDollars } from './format.js';

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
  donut?: boolean;
  maxSlices?: number;
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

function PieChartInner({
  data,
  title,
  subtitle,
  onSliceClick,
  onSliceHover,
  externalHoveredName,
  donut = false,
  maxSlices = 12,
  width,
  height,
}: PieChartProps & { width: number; height: number }) {
  const [localHovered, setLocalHovered] = useState<string | null>(null);
  const hoveredName = externalHoveredName ?? localHovered;

  const displayData = aggregateOther(data, maxSlices);
  const pieSize = Math.min(width * 0.45, height - 60);
  const radius = pieSize / 2;
  const innerRadius = donut ? radius * 0.55 : 0;
  const centerX = pieSize / 2 + 16;
  const centerY = height / 2;

  const handleMouseEnter = useCallback((name: string) => {
    setLocalHovered(name);
    onSliceHover?.(name);
  }, [onSliceHover]);

  const handleMouseLeave = useCallback(() => {
    setLocalHovered(null);
    onSliceHover?.(null);
  }, [onSliceHover]);

  const legendX = pieSize + 40;
  const legendWidth = width - legendX - 8;

  return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-4 flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-text-secondary">{title}</h3>
        {subtitle !== undefined && (
          <span className="text-[11px] text-text-muted">{subtitle}</span>
        )}
      </div>
      <svg width={width} height={height - 50}>
        <Group top={centerY - 25} left={centerX}>
          <Pie<PieSlice>
            data={displayData}
            pieValue={(d) => d.cost}
            outerRadius={radius}
            innerRadius={innerRadius}
            padAngle={0.02}
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
                      style={{
                        filter: isHovered ? 'brightness(1.2) drop-shadow(0 0 6px rgba(0,0,0,0.4))' : 'none',
                        transform: isHovered ? 'scale(1.04)' : 'scale(1)',
                        transformOrigin: 'center',
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
        {legendWidth > 80 && (
          <Group top={10} left={legendX}>
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
                  style={{ cursor: d.name !== OTHER_KEY && onSliceClick !== undefined ? 'pointer' : 'default', opacity: isDimmed ? 0.4 : 1, transition: 'opacity 0.15s' }}
                >
                  <rect x={0} y={y} width={8} height={8} rx={2} fill={color} />
                  <text
                    x={14}
                    y={y + 8}
                    fontSize={11}
                    fill={isHovered ? '#e5e7eb' : '#9ca3af'}
                    fontWeight={isHovered ? 600 : 400}
                    style={{ transition: 'all 0.15s' }}
                  >
                    {d.name.length > 18 ? `${d.name.slice(0, 17)}…` : d.name}
                    {' — '}
                    {formatDollars(d.cost)}
                    {` (${d.percentage.toFixed(1)}%)`}
                  </text>
                </g>
              );
            })}
          </Group>
        )}
      </svg>
    </div>
  );
}

export function PieChart(props: PieChartProps) {
  return (
    <ParentSize>
      {({ width }) => {
        if (width < 10) return null;
        const h = Math.max(220, Math.min(320, width * 0.6));
        return <PieChartInner {...props} width={width} height={h} />;
      }}
    </ParentSize>
  );
}
