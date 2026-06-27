import type { ReactNode } from 'react';
import { useContainerWidth } from '../lib/use-container-width.js';
import { formatDollars, truncate } from './format.js';
import type { WaterfallModel, WaterfallStep, WaterfallStepKind } from '../lib/waterfall.js';

const PLOT_H = 240;
const PAD_TOP = 14;
const PAD_BOTTOM = 48;
const PAD_LEFT = 58;
const PAD_RIGHT = 14;

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

function stepTooltip(s: WaterfallStep): string {
  if (s.kind === 'start' || s.kind === 'end') return `${s.name}: ${formatDollars(s.end)}`;
  return `${s.name}: ${s.delta >= 0 ? '+' : ''}${formatDollars(s.delta)}`;
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
  const { steps } = model;
  const innerW = Math.max(width - PAD_LEFT - PAD_RIGHT, 40);
  const plotH = PLOT_H - PAD_TOP - PAD_BOTTOM;

  const levels = steps.flatMap(s => [s.start, s.end]);
  const maxV = Math.max(...levels, 0);
  const minV = Math.min(...levels, 0);
  const span = maxV - minV || 1;
  const yOf = (v: number): number => PAD_TOP + (1 - (v - minV) / span) * plotH;

  const n = Math.max(steps.length, 1);
  const slot = innerW / n;
  const barW = Math.min(slot * 0.62, 46);
  const rotate = n > 7;
  const labelY = PLOT_H - PAD_BOTTOM + 14;

  return (
    <svg width={width} height={PLOT_H}>
      {[minV, maxV].map((v, i) => (
        <g key={`grid-${String(i)}`}>
          <line x1={PAD_LEFT} x2={width - PAD_RIGHT} y1={yOf(v)} y2={yOf(v)} stroke="var(--color-border)" strokeWidth={1} />
          <text x={PAD_LEFT - 6} y={yOf(v) + 3} textAnchor="end" fontSize={10} fill="var(--color-text-muted)">{formatDollars(v)}</text>
        </g>
      ))}
      {steps.map((s, i) => {
        const cx = PAD_LEFT + slot * (i + 0.5);
        const top = yOf(Math.max(s.start, s.end));
        const bottom = yOf(Math.min(s.start, s.end));
        const h = Math.max(bottom - top, 1.5);
        const clickable = s.entity !== null && onStepClick !== undefined;
        const next = steps[i + 1];
        return (
          <g key={`${s.name}-${String(i)}`}>
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
            <rect
              x={cx - barW / 2}
              y={top}
              width={barW}
              height={h}
              rx={2}
              fill={fillFor(s.kind)}
              style={{ cursor: clickable ? 'pointer' : 'default' }}
              onClick={() => { if (s.entity !== null) onStepClick?.(s); }}
            >
              <title>{stepTooltip(s)}</title>
            </rect>
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
          </g>
        );
      })}
    </svg>
  );
}
