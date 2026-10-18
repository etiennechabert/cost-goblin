import type { ReactNode } from 'react';
import { useContainerWidth } from '../lib/use-container-width.js';
import { formatDollars, signedDollars, truncate } from './format.js';
import { useChartTooltip, type ChartTooltipContent } from './chart-tooltip.js';
import { waterfallScale } from '../lib/waterfall.js';
import type { WaterfallModel, WaterfallStep, WaterfallStepKind } from '../lib/waterfall.js';

const PLOT_INNER_H = 178;
const PAD_TOP = 20;
const PAD_LEFT = 58;
const PAD_RIGHT = 14;
/** Below the plot: room for 12 characters of 10px label rotated -35°, which
 *  reach ~45px under their anchor. */
const PAD_BOTTOM_ROTATED = 66;
const PAD_BOTTOM_FLAT = 28;
/** Movers that get a value label; the rest are in the tooltip. */
const LABELLED_MOVERS = 3;
/** Narrowest column that fits a value label. */
const MIN_LABEL_SLOT = 40;
const CUT_DEPTH = 5;

function fillFor(kind: WaterfallStepKind): string {
  switch (kind) {
    case 'start':
    case 'end':
      return 'var(--color-text-secondary)';
    case 'increase':
      return 'var(--color-negative)';
    case 'decrease':
      return 'var(--color-positive)';
    case 'other':
      return 'var(--color-text-muted)';
  }
}

function isAnchor(s: WaterfallStep): boolean {
  return s.kind === 'start' || s.kind === 'end';
}

function stepTooltip(s: WaterfallStep, key: string): ChartTooltipContent {
  if (isAnchor(s)) {
    return { key, title: s.kind === 'start' ? 'Start · previous period' : 'End · this period', rows: [{ label: 'Total', value: formatDollars(s.end) }] };
  }
  return {
    key,
    title: s.name,
    rows: [
      { label: 'Change', value: signedDollars(s.delta) },
      { label: 'Running total', value: formatDollars(s.end) },
    ],
    ...(s.kind === 'other' ? { note: 'Smaller movers folded together.' } : {}),
  };
}

/** A bar whose bottom edge is a sawtooth: it continues below a cut axis. */
function cutBarPath(x: number, w: number, top: number, bottom: number): string {
  const teeth = 4;
  const parts = [`M${String(x)} ${String(top)}`, `H${String(x + w)}`, `V${String(bottom)}`];
  for (let k = 1; k <= teeth; k++) {
    parts.push(`L${String(x + w - (k * w) / teeth)} ${String(k % 2 === 1 ? bottom - CUT_DEPTH : bottom)}`);
  }
  parts.push('Z');
  return parts.join(' ');
}

interface WaterfallChartProps {
  readonly model: WaterfallModel;
  readonly title: ReactNode;
  readonly subtitle?: string | undefined;
  readonly onStepClick?: ((step: WaterfallStep) => void) | undefined;
}

export function WaterfallChart({ model, title, subtitle, onStepClick }: WaterfallChartProps) {
  const [ref, width] = useContainerWidth();
  return (
    <div ref={ref} className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-4">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-medium text-text-secondary">{title}</div>
        {subtitle !== undefined && <span className="text-[11px] text-text-muted">{subtitle}</span>}
      </div>
      {width > 10 && <WaterfallSvg model={model} width={width} onStepClick={onStepClick} />}
    </div>
  );
}

function WaterfallSvg({
  model,
  width,
  onStepClick,
}: {
  readonly model: WaterfallModel;
  readonly width: number;
  readonly onStepClick?: ((step: WaterfallStep) => void) | undefined;
}) {
  const tooltip = useChartTooltip();
  const { steps } = model;
  const innerW = Math.max(width - PAD_LEFT - PAD_RIGHT, 40);
  const n = Math.max(steps.length, 1);
  const slot = innerW / n;
  const barW = Math.min(slot * 0.62, 46);
  const rotate = n > 7;
  const baseline = PAD_TOP + PLOT_INNER_H;
  const height = baseline + (rotate ? PAD_BOTTOM_ROTATED : PAD_BOTTOM_FLAT);
  const labelY = baseline + 14;

  const { floor, ceiling, truncated } = waterfallScale(steps);
  const span = ceiling - floor || 1;
  const yOf = (v: number): number => PAD_TOP + (1 - (v - floor) / span) * PLOT_INNER_H;

  const labelled = new Set(
    steps
      .filter(s => !isAnchor(s))
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, LABELLED_MOVERS),
  );
  const showValues = slot >= MIN_LABEL_SLOT;

  return (
    <div className="relative">
      <svg width={width} height={height}>
        {[floor, ceiling].map((v, i) => (
          <g key={`grid-${String(i)}`}>
            <line x1={PAD_LEFT} x2={width - PAD_RIGHT} y1={yOf(v)} y2={yOf(v)} stroke="var(--color-border)" strokeWidth={1} />
            <text x={PAD_LEFT - 6} y={yOf(v) + 3} textAnchor="end" fontSize={10} fill="var(--color-text-muted)">{formatDollars(v)}</text>
          </g>
        ))}
        {steps.map((s, i) => {
          const key = `${s.name}-${String(i)}`;
          const cx = PAD_LEFT + slot * (i + 0.5);
          const anchor = isAnchor(s);
          // Anchors run from the axis floor (cut when the axis is zoomed); the
          // movers float between their running levels.
          const top = yOf(anchor ? s.end : Math.max(s.start, s.end));
          const bottom = anchor ? baseline : yOf(Math.min(s.start, s.end));
          const h = Math.max(bottom - top, 1.5);
          const next = steps[i + 1];
          const hovered = tooltip.active?.key === key;
          const valueLabel = anchor ? formatDollars(s.end) : (labelled.has(s) ? signedDollars(s.delta) : null);
          const clickable = s.entity !== null && onStepClick !== undefined;
          return (
            <g key={key}>
              {hovered && (
                <rect x={PAD_LEFT + slot * i} y={PAD_TOP} width={slot} height={PLOT_INNER_H} fill="var(--color-bg-tertiary)" opacity={0.45} />
              )}
              {next !== undefined && s.kind !== 'end' && (
                <line
                  x1={cx + barW / 2}
                  x2={PAD_LEFT + slot * (i + 1.5) - barW / 2}
                  y1={yOf(s.end)}
                  y2={yOf(s.end)}
                  stroke="var(--color-text-muted)"
                  strokeDasharray="3 3"
                  strokeWidth={1}
                  opacity={0.55}
                />
              )}
              {anchor && truncated
                ? <path d={cutBarPath(cx - barW / 2, barW, top, bottom)} fill={fillFor(s.kind)} data-cut="true" />
                : <rect x={cx - barW / 2} y={top} width={barW} height={h} rx={2} fill={fillFor(s.kind)} />}
              {showValues && valueLabel !== null && (
                <text x={cx} y={top - 5} textAnchor="middle" fontSize={10} className="tabular-nums" fill="var(--color-text-secondary)">
                  {valueLabel}
                </text>
              )}
              <text
                x={cx}
                y={labelY}
                textAnchor={rotate ? 'end' : 'middle'}
                fontSize={10}
                fill="var(--color-text-secondary)"
                transform={rotate ? `rotate(-35 ${String(cx)} ${String(labelY)})` : undefined}
              >
                {truncate(s.name, rotate ? 12 : 9)}
              </text>
              {/* Hit area: the whole column, so a 2px mover is as easy to
                  hover and click as a tall one. */}
              <rect
                x={PAD_LEFT + slot * i}
                y={PAD_TOP}
                width={slot}
                height={PLOT_INNER_H}
                fill="transparent"
                data-step={s.name}
                style={{ cursor: clickable ? 'pointer' : 'default' }}
                onMouseMove={(e) => { tooltip.show(e, stepTooltip(s, key)); }}
                onMouseLeave={tooltip.hide}
                onClick={() => { if (s.entity !== null) onStepClick?.(s); }}
              />
            </g>
          );
        })}
      </svg>
      {tooltip.element}
    </div>
  );
}
