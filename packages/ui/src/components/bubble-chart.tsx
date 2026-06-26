import { useCallback, useState } from 'react';
import { Group } from '@visx/group';
import { scaleLinear, scaleSymlog, scaleSqrt } from '@visx/scale';
import { AxisBottom, AxisLeft } from '@visx/axis';
import { GridRows, GridColumns } from '@visx/grid';
import { useTooltip, TooltipWithBounds } from '@visx/tooltip';
import { localPoint } from '@visx/event';
import { ParentSize } from '@visx/responsive';
import type { TrendRow, EntityRef } from '@costgoblin/core/browser';
import { TOOLTIP_STYLES } from '../lib/tooltip-styles.js';
import { formatDollars, formatPercent } from './format.js';

const MARGIN = { top: 20, right: 30, bottom: 50, left: 70 };
const MIN_RADIUS = 4;
const MAX_RADIUS = 40;

const DEFAULT_LOG_SCALE = 10;

interface BubbleChartProps {
  readonly data: readonly TrendRow[];
  /** `'linear'` selects `scaleLinear`. A number is the symlog constant. */
  readonly logScale?: number | 'linear' | undefined;
  readonly onEntityClick: (entity: EntityRef) => void;
  readonly externalHoveredName?: string | null | undefined;
  readonly onEntityHover?: ((name: string | null) => void) | undefined;
}

function BubbleChartInner({
  data,
  logScale,
  onEntityClick,
  externalHoveredName,
  onEntityHover,
  width,
  height,
}: BubbleChartProps & { readonly width: number; readonly height: number }) {
  const [localHovered, setLocalHovered] = useState<EntityRef | null>(null);
  const hoveredEntity: EntityRef | null = (externalHoveredName ?? null) === null
    ? localHovered
    : (externalHoveredName as EntityRef | null);
  const {
    showTooltip,
    hideTooltip,
    tooltipData,
    tooltipLeft,
    tooltipTop,
    tooltipOpen,
  } = useTooltip<TrendRow>();

  const handleMouseMove = useCallback(
    (row: TrendRow, event: React.MouseEvent<SVGCircleElement>) => {
      const coords = localPoint(event);
      if (coords === null) return;
      showTooltip({
        tooltipData: row,
        tooltipLeft: coords.x,
        tooltipTop: coords.y,
      });
      // SVG mousemove fires every frame; only push to global focus when the
      // pointed-at bubble actually changes, otherwise sibling charts thrash
      // (the pie's HOVER reducer was firing 60 times/s and visibly flickered).
      setLocalHovered(prev => {
        if (prev === row.entity) return prev;
        onEntityHover?.(row.entity);
        return row.entity;
      });
    },
    [showTooltip, onEntityHover],
  );

  const handleMouseLeave = useCallback(() => {
    hideTooltip();
    setLocalHovered(prev => {
      if (prev === null) return prev;
      onEntityHover?.(null);
      return null;
    });
  }, [hideTooltip, onEntityHover]);

  const innerWidth = width - MARGIN.left - MARGIN.right;
  const innerHeight = height - MARGIN.top - MARGIN.bottom;

  if (innerWidth <= 0 || innerHeight <= 0 || data.length === 0) {
    return null;
  }

  const percentValues = data.map((d) => d.percentChange);
  const absDeltas = data.map((d) => Math.abs(d.delta));
  const costs = data.map((d) => d.currentCost);

  const percentMin = Math.min(...percentValues);
  const percentMax = Math.max(...percentValues);
  const percentPad = Math.max((percentMax - percentMin) * 0.1, 1);

  const deltaMax = Math.max(...absDeltas);
  const costMax = Math.max(...costs);

  let scaleKind: 'linear' | number;
  if (logScale === 'linear') {
    scaleKind = 'linear';
  } else if (typeof logScale === 'number') {
    scaleKind = logScale;
  } else {
    scaleKind = DEFAULT_LOG_SCALE;
  }

  const xScale = scaleKind === 'linear'
    ? scaleLinear<number>({
        domain: [percentMin - percentPad, percentMax + percentPad],
        range: [0, innerWidth],
        nice: true,
      })
    : scaleSymlog<number>({
        domain: [percentMin - percentPad, percentMax + percentPad],
        range: [0, innerWidth],
        nice: true,
        constant: scaleKind,
      });

  const yScale = scaleKind === 'linear'
    ? scaleLinear<number>({
        domain: [0, deltaMax * 1.15],
        range: [innerHeight, 0],
        nice: true,
      })
    : scaleSymlog<number>({
        domain: [0, deltaMax * 1.15],
        range: [innerHeight, 0],
        nice: true,
        constant: scaleKind,
      });

  const rScale = scaleSqrt<number>({
    domain: [0, costMax],
    range: [MIN_RADIUS, MAX_RADIUS],
  });

  const sortedData = [...data].sort((a, b) => b.currentCost - a.currentCost);

  const gridColor = 'var(--color-border-subtle)';
  const axisColor = 'var(--color-text-muted)';
  const tickColor = 'var(--color-text-muted)';

  return (
    <div className="relative" onMouseLeave={handleMouseLeave}>
      <svg width={width} height={height} aria-label="Cost trend bubble chart: x-axis shows percent change, y-axis shows absolute delta, bubble size represents current cost">
        <Group left={MARGIN.left} top={MARGIN.top}>
          <GridRows
            scale={yScale}
            width={innerWidth}
            stroke={gridColor}
            strokeDasharray="2,3"
            numTicks={5}
          />
          <GridColumns
            scale={xScale}
            height={innerHeight}
            stroke={gridColor}
            strokeDasharray="2,3"
            numTicks={5}
          />

          {/* Zero reference line */}
          <line
            x1={xScale(0)}
            x2={xScale(0)}
            y1={0}
            y2={innerHeight}
            stroke={axisColor}
            strokeOpacity={0.5}
            strokeWidth={1}
          />

          <AxisBottom
            top={innerHeight}
            scale={xScale}
            numTicks={5}
            tickFormat={(v) => formatPercent(v.valueOf())}
            stroke={axisColor}
            tickStroke={axisColor}
            tickLabelProps={() => ({
              fill: tickColor,
              fontSize: 11,
              textAnchor: 'middle' as const,
              dy: '0.25em',
            })}
            label="Percent Change"
            labelProps={{
              fill: tickColor,
              fontSize: 12,
              textAnchor: 'middle',
            }}
          />

          <AxisLeft
            scale={yScale}
            numTicks={5}
            tickFormat={(v) => formatDollars(v.valueOf())}
            stroke={axisColor}
            tickStroke={axisColor}
            tickLabelProps={() => ({
              fill: tickColor,
              fontSize: 11,
              textAnchor: 'end' as const,
              dx: '-0.25em',
              dy: '0.33em',
            })}
            label="Absolute Delta ($)"
            labelProps={{
              fill: tickColor,
              fontSize: 12,
              textAnchor: 'middle',
            }}
          />

          {sortedData.map((row) => {
            const cx = xScale(row.percentChange);
            const cy = yScale(Math.abs(row.delta));
            const r = rScale(row.currentCost);
            const isIncrease = row.delta > 0;
            const isHovered = hoveredEntity === row.entity;

            return (
              <circle
                key={row.entity}
                cx={cx}
                cy={cy}
                r={r}
                fill={isIncrease ? '#ef4444' : '#10b981'}
                fillOpacity={isHovered ? 0.9 : 0.6}
                stroke={isHovered ? 'var(--color-text-primary)' : 'none'}
                strokeWidth={isHovered ? 1.5 : 0}
                className="cursor-pointer transition-opacity"
                onMouseMove={(e) => { handleMouseMove(row, e); }}
                onMouseLeave={handleMouseLeave}
                onClick={() => { onEntityClick(row.entity); }}
              />
            );
          })}
        </Group>
      </svg>

      {tooltipOpen && tooltipData !== undefined && tooltipLeft !== undefined && tooltipTop !== undefined && (
        <TooltipWithBounds
          left={tooltipLeft}
          top={tooltipTop}
          style={TOOLTIP_STYLES}
        >
          <div className="flex flex-col gap-1">
            <span className="font-medium text-text-primary">{tooltipData.entity}</span>
            <span className="text-text-secondary">
              Current: {formatDollars(tooltipData.currentCost)}
            </span>
            <span className={tooltipData.delta > 0 ? 'text-negative' : 'text-positive'}>
              Delta: {tooltipData.delta > 0 ? '+' : ''}{formatDollars(tooltipData.delta)}
            </span>
            <span className={tooltipData.delta > 0 ? 'text-negative' : 'text-positive'}>
              Change: {formatPercent(tooltipData.percentChange)}
            </span>
          </div>
        </TooltipWithBounds>
      )}
    </div>
  );
}

export function BubbleChart({ data, logScale, onEntityClick, externalHoveredName, onEntityHover }: BubbleChartProps) {
  return (
    <div className="h-[350px] w-full rounded-xl border border-border bg-bg-secondary/50">
      <ParentSize>
        {({ width, height }) => (
          <BubbleChartInner
            data={data}
            logScale={logScale}
            onEntityClick={onEntityClick}
            externalHoveredName={externalHoveredName}
            onEntityHover={onEntityHover}
            width={width}
            height={height}
          />
        )}
      </ParentSize>
    </div>
  );
}
