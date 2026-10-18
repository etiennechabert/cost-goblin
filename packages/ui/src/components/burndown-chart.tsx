import type { ReactNode } from 'react';
import { localPoint } from '@visx/event';
import { useContainerWidth } from '../lib/use-container-width.js';
import { formatDollars, formatPercent, formatShortDate, signedDollars } from './format.js';
import { useChartTooltip, type ChartTooltipContent, type ChartTooltipRow } from './chart-tooltip.js';
import { cumulativeAt, projectedAt, type CumulativePoint } from '../lib/day-series.js';
import { shiftDay } from '../lib/dates.js';

const PLOT_H = 240;
const PAD_TOP = 16;
const PAD_BOTTOM = 26;
const PAD_LEFT = 56;
const PAD_RIGHT = 16;

const CURRENT_COLOR = 'var(--color-accent)';
const PREVIOUS_COLOR = 'var(--color-text-muted)';
const BUDGET_COLOR = 'var(--color-warning)';

export interface BurndownChartProps {
  readonly current: readonly CumulativePoint[];
  readonly previous?: readonly CumulativePoint[] | null;
  readonly totalDays: number;
  readonly projected?: number | null;
  readonly budget?: number | undefined;
  /** First day of the period (YYYY-MM-DD), for dates on the axis and tooltip. */
  readonly periodStart?: string | undefined;
  readonly title: ReactNode;
  readonly subtitle?: string | undefined;
}

function linePath(points: readonly { readonly x: number; readonly y: number }[]): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${String(p.x)} ${String(p.y)}`).join(' ');
}

function dayLabel(periodStart: string | undefined, dayIndex: number): string {
  return periodStart === undefined ? `Day ${String(dayIndex + 1)}` : formatShortDate(shiftDay(periodStart, dayIndex));
}

/** This period (actual, or the projection past the last data day) against the
 *  previous period at the same calendar position. */
function dayTooltip(
  { current, previous, projected, totalDays, periodStart }: BurndownChartProps,
  dayIndex: number,
): ChartTooltipContent {
  const projectedValue = projected === null || projected === undefined ? null : projectedAt(current, projected, totalDays, dayIndex);
  const thisValue = projectedValue ?? cumulativeAt(current, dayIndex);
  const rows: ChartTooltipRow[] = [
    projectedValue === null
      ? { label: 'This period', value: formatDollars(thisValue), color: CURRENT_COLOR }
      : { label: 'Projected', value: formatDollars(thisValue), color: CURRENT_COLOR, dashed: true },
  ];
  if (previous !== null && previous !== undefined && previous.length > 0) {
    const prevValue = cumulativeAt(previous, dayIndex);
    rows.push({ label: 'Previous period', value: formatDollars(prevValue), color: PREVIOUS_COLOR, dashed: true });
    const diff = thisValue - prevValue;
    rows.push({
      label: 'Difference',
      value: prevValue > 0 ? `${signedDollars(diff)} (${formatPercent((diff / prevValue) * 100)})` : signedDollars(diff),
    });
  }
  const title = periodStart === undefined
    ? `Day ${String(dayIndex + 1)}`
    : `${dayLabel(periodStart, dayIndex)} · day ${String(dayIndex + 1)}`;
  return { key: String(dayIndex), title, rows };
}

function LegendSwatch({ color, dashed }: { readonly color: string; readonly dashed: boolean }) {
  return <span className={`inline-block w-3 border-t-2 ${dashed ? 'border-dashed' : ''}`} style={{ borderColor: color }} />;
}

export function BurndownChart(props: BurndownChartProps) {
  const [ref, width] = useContainerWidth();
  const lastDayIndex = props.current.at(-1)?.dayIndex ?? 0;
  const showsProjection = props.projected !== null && props.projected !== undefined && lastDayIndex < props.totalDays - 1;
  const showsPrevious = props.previous !== null && props.previous !== undefined && props.previous.length > 1;
  return (
    <div ref={ref} className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-4">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-medium text-text-secondary">{props.title}</div>
        {props.subtitle !== undefined && <span className="text-[11px] text-text-muted">{props.subtitle}</span>}
      </div>
      {width > 10 && <BurndownSvg {...props} width={width} />}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1 text-[11px] text-text-muted">
        <span className="flex items-center gap-1.5"><LegendSwatch color={CURRENT_COLOR} dashed={false} />This period</span>
        {showsPrevious && <span className="flex items-center gap-1.5"><LegendSwatch color={PREVIOUS_COLOR} dashed />Previous period</span>}
        {showsProjection && <span className="flex items-center gap-1.5"><LegendSwatch color={CURRENT_COLOR} dashed />Projection</span>}
        {props.budget !== undefined && props.budget > 0 && (
          <span className="flex items-center gap-1.5"><LegendSwatch color={BUDGET_COLOR} dashed />Budget</span>
        )}
      </div>
    </div>
  );
}

function BurndownSvg(props: BurndownChartProps & { readonly width: number }) {
  const { current, previous, totalDays, projected, budget, periodStart, width } = props;
  const tooltip = useChartTooltip();
  const innerW = Math.max(width - PAD_LEFT - PAD_RIGHT, 40);
  const plotH = PLOT_H - PAD_TOP - PAD_BOTTOM;
  const baseline = PLOT_H - PAD_BOTTOM;
  const lastDay = Math.max(totalDays - 1, 1);

  const curMax = current.length > 0 ? (current.at(-1)?.cumulative ?? 0) : 0;
  const prevMax = previous && previous.length > 0 ? (previous.at(-1)?.cumulative ?? 0) : 0;
  const yMax = Math.max(curMax, prevMax, projected ?? 0, budget ?? 0, 1);

  const xOf = (idx: number): number => PAD_LEFT + (idx / lastDay) * innerW;
  const yOf = (v: number): number => baseline - (v / yMax) * plotH;

  const curPts = current.map(p => ({ x: xOf(p.dayIndex), y: yOf(p.cumulative) }));
  const prevPts = (previous ?? []).map(p => ({ x: xOf(p.dayIndex), y: yOf(p.cumulative) }));
  const todayIdx = current.length > 0 ? (current.at(-1)?.dayIndex ?? 0) : 0;
  const lastCur = curPts.at(-1);

  const hoveredDay = tooltip.active === null ? null : Number(tooltip.active.key);
  const hoverDots = hoveredDay === null ? [] : [
    { key: 'cur', color: CURRENT_COLOR, value: (projected === null || projected === undefined ? null : projectedAt(current, projected, totalDays, hoveredDay)) ?? cumulativeAt(current, hoveredDay) },
    ...(previous !== null && previous !== undefined && previous.length > 0
      ? [{ key: 'prev', color: PREVIOUS_COLOR, value: cumulativeAt(previous, hoveredDay) }]
      : []),
  ];

  function handleMove(event: React.MouseEvent<SVGRectElement>) {
    const point = localPoint(event);
    if (point === null) return;
    const dayIndex = Math.min(Math.max(Math.round(((point.x - PAD_LEFT) / innerW) * lastDay), 0), totalDays - 1);
    tooltip.show(event, dayTooltip(props, dayIndex));
  }

  return (
    <div className="relative">
      <svg width={width} height={PLOT_H}>
        {/* axes */}
        <line x1={PAD_LEFT} x2={PAD_LEFT} y1={PAD_TOP} y2={baseline} stroke="var(--color-border)" strokeWidth={1} />
        <line x1={PAD_LEFT} x2={width - PAD_RIGHT} y1={baseline} y2={baseline} stroke="var(--color-border)" strokeWidth={1} />
        <text x={PAD_LEFT - 6} y={PAD_TOP + 4} textAnchor="end" fontSize={10} fill="var(--color-text-muted)">{formatDollars(yMax)}</text>
        {periodStart !== undefined && (
          <text x={PAD_LEFT} y={baseline + 16} textAnchor="start" fontSize={10} fill="var(--color-text-muted)">{dayLabel(periodStart, 0)}</text>
        )}
        <text x={width - PAD_RIGHT} y={baseline + 16} textAnchor="end" fontSize={10} fill="var(--color-text-muted)">
          {periodStart === undefined ? `day ${String(totalDays)}` : dayLabel(periodStart, totalDays - 1)}
        </text>

        {/* budget reference */}
        {budget !== undefined && budget > 0 && (
          <>
            <line x1={PAD_LEFT} x2={width - PAD_RIGHT} y1={yOf(budget)} y2={yOf(budget)} stroke={BUDGET_COLOR} strokeWidth={1.2} strokeDasharray="5 4" opacity={0.8} />
            <text x={width - PAD_RIGHT} y={yOf(budget) - 4} textAnchor="end" fontSize={10} fill={BUDGET_COLOR}>Budget {formatDollars(budget)}</text>
          </>
        )}

        {/* previous period ghost */}
        {prevPts.length > 1 && (
          <path d={linePath(prevPts)} fill="none" stroke={PREVIOUS_COLOR} strokeWidth={1.6} strokeDasharray="4 4" opacity={0.7} />
        )}

        {/* projection */}
        {lastCur !== undefined && projected !== null && projected !== undefined && (
          <path
            d={linePath([lastCur, { x: xOf(lastDay), y: yOf(projected) }])}
            fill="none"
            stroke={CURRENT_COLOR}
            strokeWidth={1.8}
            strokeDasharray="5 4"
          />
        )}

        {/* current cumulative */}
        {curPts.length > 1 && <path d={linePath(curPts)} fill="none" stroke={CURRENT_COLOR} strokeWidth={2.4} />}
        {lastCur !== undefined && <circle cx={lastCur.x} cy={lastCur.y} r={3.2} fill={CURRENT_COLOR} />}

        {/* today marker */}
        {current.length > 0 && (
          <line x1={xOf(todayIdx)} x2={xOf(todayIdx)} y1={PAD_TOP} y2={baseline} stroke="var(--color-text-muted)" strokeWidth={1} strokeDasharray="2 3" opacity={0.6} />
        )}

        {/* hover crosshair */}
        {hoveredDay !== null && (
          <g pointerEvents="none">
            <line x1={xOf(hoveredDay)} x2={xOf(hoveredDay)} y1={PAD_TOP} y2={baseline} stroke="var(--color-text-secondary)" strokeWidth={1} opacity={0.6} />
            {hoverDots.map(d => (
              <circle key={d.key} cx={xOf(hoveredDay)} cy={yOf(d.value)} r={4} fill={d.color} stroke="var(--color-bg-secondary)" strokeWidth={2} />
            ))}
          </g>
        )}

        <rect
          x={PAD_LEFT}
          y={PAD_TOP}
          width={innerW}
          height={baseline - PAD_TOP}
          fill="transparent"
          data-testid="burndown-hit-area"
          onMouseMove={handleMove}
          onMouseLeave={tooltip.hide}
        />
      </svg>
      {tooltip.element}
    </div>
  );
}
