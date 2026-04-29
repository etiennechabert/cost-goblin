import { useCallback, useMemo } from 'react';
import { Group } from '@visx/group';
import { LinePath } from '@visx/shape';
import { scaleLinear, scaleTime } from '@visx/scale';
import { AxisBottom, AxisLeft } from '@visx/axis';
import { GridRows } from '@visx/grid';
import { ParentSize } from '@visx/responsive';
import { localPoint } from '@visx/event';
import { TooltipWithBounds, useTooltip } from '@visx/tooltip';
import { curveMonotoneX } from '@visx/curve';
import { getColor } from '../lib/palette.js';
import { TOOLTIP_STYLES } from '../lib/tooltip-styles.js';
import { formatDollars } from './format.js';
import { usePalette } from '../hooks/use-palette.js';
import type { TagCoverageSnapshot } from '@costgoblin/core/browser';

interface TagCoverageChartProps {
  readonly snapshots: readonly TagCoverageSnapshot[];
  readonly height?: number | undefined;
}

const MARGIN = { top: 20, right: 24, bottom: 36, left: 60 };

interface TooltipPayload {
  readonly timestamp: string;
  readonly coveragePercentage: number;
  readonly actionableCount: number;
  readonly totalActionableCost: number;
}

interface CoverageSvgProps {
  readonly snapshots: readonly TagCoverageSnapshot[];
  readonly width: number;
  readonly height: number;
}

function CoverageSvg({ snapshots, width, height }: CoverageSvgProps) {
  const { palette } = usePalette();
  const {
    showTooltip, hideTooltip, tooltipData, tooltipLeft, tooltipTop, tooltipOpen,
  } = useTooltip<TooltipPayload>();

  const innerW = Math.max(width - MARGIN.left - MARGIN.right, 10);
  const innerH = Math.max(height - MARGIN.top - MARGIN.bottom, 10);

  const sortedSnapshots = useMemo(
    () => [...snapshots].sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
    [snapshots],
  );

  const minDate = sortedSnapshots[0]?.timestamp;
  const maxDate = sortedSnapshots.at(-1)?.timestamp;

  const xScale = useMemo(() => {
    const start = minDate === undefined ? new Date() : new Date(minDate);
    const end = maxDate === undefined ? new Date() : new Date(maxDate);
    return scaleTime<number>({
      domain: [start, end],
      range: [0, innerW],
    });
  }, [minDate, maxDate, innerW]);

  const yScale = useMemo(() => scaleLinear<number>({
    domain: [0, 100],
    range: [innerH, 0],
    nice: true,
  }), [innerH]);

  const lineColor = getColor(2, palette); // Use a consistent color from palette

  const handleMove = useCallback((event: React.MouseEvent<SVGRectElement>) => {
    const point = localPoint(event);
    if (point === null) return;
    const x = point.x - MARGIN.left;
    if (x < 0 || x > innerW || sortedSnapshots.length === 0) return;
    const date = xScale.invert(x);
    let nearest = sortedSnapshots[0];
    let nearestDiff = Infinity;
    for (const snap of sortedSnapshots) {
      const diff = Math.abs(new Date(snap.timestamp).getTime() - date.getTime());
      if (diff < nearestDiff) {
        nearestDiff = diff;
        nearest = snap;
      }
    }
    if (nearest === undefined) return;
    showTooltip({
      tooltipData: {
        timestamp: nearest.timestamp,
        coveragePercentage: nearest.coveragePercentage,
        actionableCount: nearest.actionableCount,
        totalActionableCost: nearest.totalActionableCost,
      },
      tooltipLeft: point.x,
      tooltipTop: point.y,
    });
  }, [innerW, sortedSnapshots, xScale, showTooltip]);

  if (sortedSnapshots.length === 0) {
    return (
      <div className="flex items-center justify-center text-text-muted" style={{ width, height }}>
        No coverage data available
      </div>
    );
  }

  return (
    <div className="relative" style={{ width, height }}>
      <svg width={width} height={height}>
        <Group left={MARGIN.left} top={MARGIN.top}>
          <GridRows
            scale={yScale}
            width={innerW}
            stroke="var(--color-border-subtle)"
            strokeDasharray="2,3"
            numTicks={5}
          />
          <AxisBottom
            top={innerH}
            scale={xScale}
            numTicks={Math.min(6, Math.max(2, Math.floor(innerW / 80)))}
            tickFormat={(v) => {
              const d = v instanceof Date ? v : new Date(v.valueOf());
              return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            }}
            stroke="var(--color-text-muted)"
            tickStroke="var(--color-text-muted)"
            tickLabelProps={() => ({
              fill: 'var(--color-text-muted)',
              fontSize: 10,
              textAnchor: 'middle' as const,
              dy: '0.25em',
            })}
          />
          <AxisLeft
            scale={yScale}
            numTicks={5}
            tickFormat={(v) => `${String(v.valueOf())}%`}
            stroke="var(--color-text-muted)"
            tickStroke="var(--color-text-muted)"
            tickLabelProps={() => ({
              fill: 'var(--color-text-muted)',
              fontSize: 10,
              textAnchor: 'end' as const,
              dx: '-0.25em',
              dy: '0.33em',
            })}
          />
          <LinePath<TagCoverageSnapshot>
            data={sortedSnapshots}
            x={(d) => xScale(new Date(d.timestamp))}
            y={(d) => yScale(d.coveragePercentage)}
            stroke={lineColor}
            strokeWidth={1.75}
            curve={curveMonotoneX}
          />
          <rect
            width={innerW}
            height={innerH}
            fill="transparent"
            onMouseMove={handleMove}
            onMouseLeave={hideTooltip}
          />
        </Group>
      </svg>

      {tooltipOpen && tooltipData !== undefined && tooltipLeft !== undefined && tooltipTop !== undefined && (
        <TooltipWithBounds left={tooltipLeft} top={tooltipTop} style={TOOLTIP_STYLES}>
          <div className="flex flex-col gap-0.5">
            <span className="font-medium text-text-primary mb-1">
              {new Date(tooltipData.timestamp).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })}
            </span>
            <span className="text-text-secondary">
              Coverage: <span className="text-text-primary tabular-nums">{tooltipData.coveragePercentage.toFixed(1)}%</span>
            </span>
            <span className="text-text-secondary">
              Untagged: <span className="text-text-primary tabular-nums">{tooltipData.actionableCount}</span> resources
            </span>
            <span className="text-text-secondary">
              Cost impact: <span className="text-text-primary tabular-nums">{formatDollars(tooltipData.totalActionableCost)}</span>
            </span>
          </div>
        </TooltipWithBounds>
      )}
    </div>
  );
}

export function TagCoverageChart({ snapshots, height = 300 }: TagCoverageChartProps) {
  return (
    <ParentSize>
      {({ width }) => (
        <CoverageSvg
          snapshots={snapshots}
          width={width}
          height={height}
        />
      )}
    </ParentSize>
  );
}
