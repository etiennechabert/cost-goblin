import type { ReactNode } from 'react';
import { useContainerWidth } from '../lib/use-container-width.js';
import { formatDollars } from './format.js';
import type { ParetoModel } from '../lib/concentration.js';

const PLOT_H = 240;
const PAD_TOP = 18;
const PAD_BOTTOM = 26;
const PAD_LEFT = 52;
const PAD_RIGHT = 44;

interface ParetoChartProps {
  readonly model: ParetoModel;
  readonly title: ReactNode;
  readonly subtitle?: string | undefined;
  readonly onBarClick?: ((name: string) => void) | undefined;
}

export function ParetoChart({ model, title, subtitle, onBarClick }: ParetoChartProps) {
  const [ref, width] = useContainerWidth();
  return (
    <div ref={ref} className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-4">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-medium text-text-secondary">{title}</div>
        {subtitle !== undefined && <span className="text-[11px] text-text-muted">{subtitle}</span>}
      </div>
      {width > 10 && <ParetoSvg model={model} width={width} onBarClick={onBarClick} />}
    </div>
  );
}

function ParetoSvg({
  model,
  width,
  onBarClick,
}: {
  readonly model: ParetoModel;
  readonly width: number;
  readonly onBarClick?: ((name: string) => void) | undefined;
}) {
  const { points } = model;
  const innerW = Math.max(width - PAD_LEFT - PAD_RIGHT, 40);
  const plotH = PLOT_H - PAD_TOP - PAD_BOTTOM;
  const baseline = PLOT_H - PAD_BOTTOM;
  const maxCost = points[0]?.cost ?? 1;
  const n = Math.max(points.length, 1);
  const slot = innerW / n;
  const barW = Math.max(slot * 0.78, 1);

  const xOf = (i: number): number => PAD_LEFT + slot * i;
  const yCum = (p: number): number => PAD_TOP + (1 - p) * plotH;
  const yBar = (cost: number): number => baseline - (cost / maxCost) * plotH;

  const cumPath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${String(xOf(i) + slot / 2)} ${String(yCum(p.cumPct))}`).join(' ');
  const cutoff = model.cutoff;
  const cutoffX = cutoff === null ? null : xOf(cutoff.count - 1) + slot / 2;
  const giniLabel = `Gini ${model.gini.toFixed(2)}`;

  return (
    <svg width={width} height={PLOT_H}>
      {/* axes */}
      <line x1={PAD_LEFT} x2={PAD_LEFT} y1={PAD_TOP} y2={baseline} stroke="var(--color-border)" strokeWidth={1} />
      <line x1={PAD_LEFT} x2={width - PAD_RIGHT} y1={baseline} y2={baseline} stroke="var(--color-border)" strokeWidth={1} />
      <text x={PAD_LEFT - 6} y={PAD_TOP + 4} textAnchor="end" fontSize={10} fill="var(--color-text-muted)">{formatDollars(maxCost)}</text>
      <text x={width - PAD_RIGHT + 6} y={PAD_TOP + 4} textAnchor="start" fontSize={10} fill="var(--color-text-muted)">100%</text>
      <text x={width - PAD_RIGHT + 6} y={baseline + 3} textAnchor="start" fontSize={10} fill="var(--color-text-muted)">0%</text>

      {/* 80% reference */}
      <line x1={PAD_LEFT} x2={width - PAD_RIGHT} y1={yCum(0.8)} y2={yCum(0.8)} stroke="var(--color-warning)" strokeWidth={1} strokeDasharray="4 4" opacity={0.7} />
      <text x={width - PAD_RIGHT + 6} y={yCum(0.8) + 3} textAnchor="start" fontSize={10} fill="var(--color-warning)">80%</text>

      {/* bars */}
      {points.map((p, i) => {
        const h = Math.max(baseline - yBar(p.cost), 0.5);
        return (
          <rect
            key={`${p.name}-${String(i)}`}
            x={xOf(i) + (slot - barW) / 2}
            y={yBar(p.cost)}
            width={barW}
            height={h}
            fill="var(--color-text-secondary)"
            opacity={0.45}
            style={{ cursor: onBarClick === undefined ? 'default' : 'pointer' }}
            onClick={() => { onBarClick?.(p.name); }}
          >
            <title>{`${p.name}: ${formatDollars(p.cost)} (${(p.cumPct * 100).toFixed(0)}% cumulative)`}</title>
          </rect>
        );
      })}

      {/* cutoff marker */}
      {cutoffX !== null && (
        <line x1={cutoffX} x2={cutoffX} y1={PAD_TOP} y2={baseline} stroke="var(--color-accent)" strokeWidth={1.4} strokeDasharray="3 3" opacity={0.8} />
      )}

      {/* cumulative curve */}
      <path d={cumPath} fill="none" stroke="var(--color-accent)" strokeWidth={2} />

      {/* gini badge */}
      <g transform={`translate(${String(width - PAD_RIGHT - 64)}, ${String(PAD_TOP)})`}>
        <rect x={0} y={0} width={64} height={18} rx={6} fill="var(--color-accent-muted)" />
        <text x={32} y={13} textAnchor="middle" fontSize={11} fill="var(--color-accent)">{giniLabel}</text>
      </g>
    </svg>
  );
}
