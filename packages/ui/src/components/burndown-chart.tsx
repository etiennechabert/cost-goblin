import type { ReactNode } from 'react';
import { useContainerWidth } from '../lib/use-container-width.js';
import { formatDollars } from './format.js';
import type { CumulativePoint } from '../lib/day-series.js';

const PLOT_H = 240;
const PAD_TOP = 16;
const PAD_BOTTOM = 26;
const PAD_LEFT = 56;
const PAD_RIGHT = 16;

export interface BurndownChartProps {
  readonly current: readonly CumulativePoint[];
  readonly previous?: readonly CumulativePoint[] | null;
  readonly totalDays: number;
  readonly projected?: number | null;
  readonly budget?: number | undefined;
  readonly title: ReactNode;
  readonly subtitle?: string | undefined;
}

function linePath(points: readonly { readonly x: number; readonly y: number }[]): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${String(p.x)} ${String(p.y)}`).join(' ');
}

export function BurndownChart(props: BurndownChartProps) {
  const [ref, width] = useContainerWidth();
  return (
    <div ref={ref} className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-4">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-medium text-text-secondary">{props.title}</div>
        {props.subtitle !== undefined && <span className="text-[11px] text-text-muted">{props.subtitle}</span>}
      </div>
      {width > 10 && <BurndownSvg {...props} width={width} />}
    </div>
  );
}

function BurndownSvg({
  current,
  previous,
  totalDays,
  projected,
  budget,
  width,
}: BurndownChartProps & { readonly width: number }) {
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

  return (
    <svg width={width} height={PLOT_H}>
      {/* axes */}
      <line x1={PAD_LEFT} x2={PAD_LEFT} y1={PAD_TOP} y2={baseline} stroke="var(--color-border)" strokeWidth={1} />
      <line x1={PAD_LEFT} x2={width - PAD_RIGHT} y1={baseline} y2={baseline} stroke="var(--color-border)" strokeWidth={1} />
      <text x={PAD_LEFT - 6} y={PAD_TOP + 4} textAnchor="end" fontSize={10} fill="var(--color-text-muted)">{formatDollars(yMax)}</text>
      <text x={width - PAD_RIGHT} y={baseline + 16} textAnchor="end" fontSize={10} fill="var(--color-text-muted)">day {String(totalDays)}</text>

      {/* budget reference */}
      {budget !== undefined && budget > 0 && (
        <>
          <line x1={PAD_LEFT} x2={width - PAD_RIGHT} y1={yOf(budget)} y2={yOf(budget)} stroke="var(--color-warning)" strokeWidth={1.2} strokeDasharray="5 4" opacity={0.8} />
          <text x={width - PAD_RIGHT} y={yOf(budget) - 4} textAnchor="end" fontSize={10} fill="var(--color-warning)">Budget {formatDollars(budget)}</text>
        </>
      )}

      {/* previous period ghost */}
      {prevPts.length > 1 && (
        <path d={linePath(prevPts)} fill="none" stroke="var(--color-text-muted)" strokeWidth={1.6} strokeDasharray="4 4" opacity={0.7} />
      )}

      {/* projection */}
      {lastCur !== undefined && projected !== null && projected !== undefined && (
        <path
          d={linePath([lastCur, { x: xOf(lastDay), y: yOf(projected) }])}
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth={1.8}
          strokeDasharray="5 4"
        />
      )}

      {/* current cumulative */}
      {curPts.length > 1 && <path d={linePath(curPts)} fill="none" stroke="var(--color-accent)" strokeWidth={2.4} />}
      {lastCur !== undefined && <circle cx={lastCur.x} cy={lastCur.y} r={3.2} fill="var(--color-accent)" />}

      {/* today marker */}
      {current.length > 0 && (
        <line x1={xOf(todayIdx)} x2={xOf(todayIdx)} y1={PAD_TOP} y2={baseline} stroke="var(--color-text-muted)" strokeWidth={1} strokeDasharray="2 3" opacity={0.6} />
      )}
    </svg>
  );
}
