import { useCallback, useMemo, useState } from 'react';
import { Group } from '@visx/group';
import { LinePath } from '@visx/shape';
import { scaleLinear, scaleTime } from '@visx/scale';
import { AxisBottom, AxisLeft } from '@visx/axis';
import { GridRows } from '@visx/grid';
import { ParentSize } from '@visx/responsive';
import { localPoint } from '@visx/event';
import { TooltipWithBounds, useTooltip } from '@visx/tooltip';
import { curveMonotoneX } from '@visx/curve';
import { PALETTE_STANDARD } from '../lib/palette.js';
import { TOOLTIP_STYLES } from '../lib/tooltip-styles.js';
import { formatDollars } from './format.js';

export interface LineSeriesPoint {
  readonly date: string;
  readonly cost: number;
}

export interface LineSeries {
  readonly name: string;
  readonly points: readonly LineSeriesPoint[];
}

interface LineChartProps {
  readonly series: readonly LineSeries[];
  readonly title?: string | undefined;
  readonly subtitle?: string | undefined;
  readonly height?: number | undefined;
  readonly onSeriesClick?: ((name: string) => void) | undefined;
}

const MARGIN = { top: 20, right: 24, bottom: 36, left: 60 };

interface TooltipPayload {
  readonly date: string;
  readonly entries: readonly { readonly name: string; readonly cost: number; readonly color: string }[];
}

interface LineSvgProps {
  readonly series: readonly LineSeries[];
  readonly visible: readonly LineSeries[];
  readonly width: number;
  readonly height: number;
}

function LineSvg({ series, visible, width, height }: LineSvgProps) {
  const {
    showTooltip, hideTooltip, tooltipData, tooltipLeft, tooltipTop, tooltipOpen,
  } = useTooltip<TooltipPayload>();

  const innerW = Math.max(width - MARGIN.left - MARGIN.right, 10);
  const innerH = Math.max(height - MARGIN.top - MARGIN.bottom, 10);

  const sortedDates = useMemo(() => {
    const all = new Set<string>();
    for (const s of series) for (const p of s.points) all.add(p.date);
    return [...all].sort();
  }, [series]);

  const minDate = sortedDates[0];
  const maxDate = sortedDates[sortedDates.length - 1];

  const xScale = useMemo(() => {
    const start = minDate !== undefined ? new Date(minDate) : new Date();
    const end = maxDate !== undefined ? new Date(maxDate) : new Date();
    return scaleTime<number>({
      domain: [start, end],
      range: [0, innerW],
    });
  }, [minDate, maxDate, innerW]);

  const maxY = useMemo(
    () => visible.reduce((m, s) => s.points.reduce((mm, p) => Math.max(mm, p.cost), m), 0),
    [visible],
  );

  const yScale = useMemo(() => scaleLinear<number>({
    domain: [0, maxY * 1.1 || 1],
    range: [innerH, 0],
    nice: true,
  }), [maxY, innerH]);

  const seriesColorIndex = useMemo(() => {
    const m = new Map<string, number>();
    series.forEach((s, i) => m.set(s.name, i));
    return m;
  }, [series]);

  const handleMove = useCallback((event: React.MouseEvent<SVGRectElement>) => {
    const point = localPoint(event);
    if (point === null) return;
    const x = point.x - MARGIN.left;
    if (x < 0 || x > innerW || sortedDates.length === 0) return;
    const date = xScale.invert(x);
    let nearest = sortedDates[0] ?? '';
    let nearestDiff = Infinity;
    for (const d of sortedDates) {
      const diff = Math.abs(new Date(d).getTime() - date.getTime());
      if (diff < nearestDiff) {
        nearestDiff = diff;
        nearest = d;
      }
    }
    const entries = visible
      .map((s) => {
        const p = s.points.find(x2 => x2.date === nearest);
        const colorIdx = seriesColorIndex.get(s.name) ?? 0;
        const color = PALETTE_STANDARD[colorIdx % PALETTE_STANDARD.length] ?? '#999';
        return p !== undefined ? { name: s.name, cost: p.cost, color } : null;
      })
      .filter((e): e is { name: string; cost: number; color: string } => e !== null);
    showTooltip({
      tooltipData: { date: nearest, entries },
      tooltipLeft: point.x,
      tooltipTop: point.y,
    });
  }, [innerW, sortedDates, visible, xScale, showTooltip, seriesColorIndex]);

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
            tickFormat={(v) => formatDollars(v.valueOf())}
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
          {visible.map((s) => {
            const colorIdx = seriesColorIndex.get(s.name) ?? 0;
            const color = PALETTE_STANDARD[colorIdx % PALETTE_STANDARD.length] ?? '#999';
            return (
              <LinePath<LineSeriesPoint>
                key={s.name}
                data={[...s.points]}
                x={(d) => xScale(new Date(d.date))}
                y={(d) => yScale(d.cost)}
                stroke={color}
                strokeWidth={1.75}
                curve={curveMonotoneX}
              />
            );
          })}
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
            <span className="font-medium text-text-primary mb-1">{tooltipData.date}</span>
            {tooltipData.entries.map(e => (
              <span key={e.name} className="flex items-center gap-1.5">
                <span className="inline-block w-2 h-2 rounded-sm" style={{ background: e.color }} />
                <span className="text-text-secondary">{e.name}</span>
                <span className="text-text-primary tabular-nums ml-1">{formatDollars(e.cost)}</span>
              </span>
            ))}
          </div>
        </TooltipWithBounds>
      )}
    </div>
  );
}

export function LineChart({ series, title, subtitle, height = 320, onSeriesClick }: LineChartProps) {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const visible = useMemo(
    () => series.filter(s => !hidden.has(s.name)),
    [series, hidden],
  );

  function toggle(name: string) {
    setHidden(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-4 flex flex-col" style={{ height }}>
      {(title !== undefined || subtitle !== undefined) && (
        <div className="flex items-center justify-between mb-2">
          {title !== undefined && <h3 className="text-sm font-medium text-text-secondary">{title}</h3>}
          {subtitle !== undefined && <span className="text-[11px] text-text-muted">{subtitle}</span>}
        </div>
      )}
      <div className="flex-1 min-h-0">
        <ParentSize>
          {({ width, height: h }) => (
            width > 10 && h > 10 ? (
              <LineSvg series={series} visible={visible} width={width} height={h} />
            ) : null
          )}
        </ParentSize>
      </div>
      <div className="mt-2 flex flex-wrap gap-2 shrink-0">
        {series.map((s) => {
          const colorIdx = series.findIndex(x => x.name === s.name);
          const color = PALETTE_STANDARD[colorIdx % PALETTE_STANDARD.length] ?? '#999';
          const off = hidden.has(s.name);
          return (
            <button
              key={s.name}
              type="button"
              onClick={() => {
                if (onSeriesClick !== undefined) onSeriesClick(s.name);
                else toggle(s.name);
              }}
              onDoubleClick={() => { toggle(s.name); }}
              className="flex items-center gap-1.5 text-[11px] px-1.5 py-0.5 rounded hover:bg-bg-tertiary/40 transition-colors"
              style={{ opacity: off ? 0.4 : 1 }}
              title={off ? 'Show series' : 'Click to filter, double-click to hide'}
            >
              <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: color }} />
              <span className="text-text-secondary">{s.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
