import type { ReactNode } from 'react';
import { useContainerWidth } from '../lib/use-container-width.js';
import { usePalette } from '../hooks/use-palette.js';
import { getColor } from '../lib/palette.js';
import { formatDollars, signedDollars, truncate } from './format.js';
import { useChartTooltip, type ChartTooltipContent } from './chart-tooltip.js';
import type { PriceVolumeDecomp } from '../lib/price-volume.js';

const ROW_H = 28;
const LABEL_W = 116;
const RIGHT_GUTTER = 66;

function rowTooltip(r: PriceVolumeDecomp, key: string, volColor: string, rateColor: string): ChartTooltipContent {
  const discount = r.prevDiscount !== null && r.currDiscount !== null
    ? [{ label: 'Discount vs list', value: `${(r.prevDiscount * 100).toFixed(1)}% → ${(r.currDiscount * 100).toFixed(1)}%` }]
    : [];
  return {
    key,
    title: r.name,
    rows: [
      { label: 'Previous', value: formatDollars(r.prevCost) },
      { label: 'Current', value: formatDollars(r.currCost) },
      ...(r.decomposable
        ? [
          { label: 'Volume (usage)', value: signedDollars(r.volumeEffect), color: volColor },
          { label: 'Rate (price)', value: signedDollars(r.rateEffect), color: rateColor },
        ]
        : [{ label: 'Change', value: signedDollars(r.totalDelta) }]),
      ...discount,
    ],
    ...(r.decomposable ? {} : { note: 'Usage is missing on one side, so the change can\'t be split into volume and rate.' }),
  };
}

interface PriceVolumeChartProps {
  readonly rows: readonly PriceVolumeDecomp[];
  readonly title: ReactNode;
  readonly subtitle?: string | undefined;
  readonly onRowClick?: ((row: PriceVolumeDecomp) => void) | undefined;
}

export function PriceVolumeChart({ rows, title, subtitle, onRowClick }: PriceVolumeChartProps) {
  const [ref, width] = useContainerWidth();
  const { palette } = usePalette();
  // Volume / rate are two fixed categories; pull two distinct, theme- and
  // colorblind-aware hues from the active palette rather than hardcoding.
  const volColor = getColor(0, palette);
  const rateColor = getColor(2, palette);
  return (
    <div ref={ref} className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-4">
      <div className="flex items-center justify-between mb-1">
        <div className="text-sm font-medium text-text-secondary">{title}</div>
        {subtitle !== undefined && <span className="text-[11px] text-text-muted">{subtitle}</span>}
      </div>
      <div className="flex items-center gap-3 mb-2 text-[11px] text-text-muted">
        <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm" style={{ background: volColor }} />Volume</span>
        <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm" style={{ background: rateColor }} />Rate</span>
      </div>
      {width > 10 && <PriceVolumeSvg rows={rows} width={width} volColor={volColor} rateColor={rateColor} onRowClick={onRowClick} />}
    </div>
  );
}

function PriceVolumeSvg({
  rows,
  width,
  volColor,
  rateColor,
  onRowClick,
}: {
  readonly rows: readonly PriceVolumeDecomp[];
  readonly width: number;
  readonly volColor: string;
  readonly rateColor: string;
  readonly onRowClick?: ((row: PriceVolumeDecomp) => void) | undefined;
}) {
  const tooltip = useChartTooltip();
  const barAreaX = LABEL_W + 8;
  const barAreaW = Math.max(width - barAreaX - RIGHT_GUTTER, 40);
  const xMid = barAreaX + barAreaW / 2;

  const maxAbs = Math.max(
    1,
    ...rows.map(r => Math.max(Math.abs(r.totalDelta), Math.abs(r.volumeEffect), Math.abs(r.volumeEffect + r.rateEffect))),
  );
  const xOf = (v: number): number => xMid + (v / maxAbs) * (barAreaW / 2);
  const height = rows.length * ROW_H + 6;

  return (
    <div className="relative">
      <svg width={width} height={height}>
        <line x1={xMid} x2={xMid} y1={2} y2={height - 2} stroke="var(--color-border)" strokeWidth={1} />
        {rows.map((r, i) => {
          const key = `${r.name}-${String(i)}`;
          const cy = i * ROW_H + ROW_H / 2 + 2;
          const barY = cy - 7;
          const volX0 = xOf(0);
          const volX1 = xOf(r.volumeEffect);
          const rateX1 = xOf(r.volumeEffect + r.rateEffect);
          const volFill = r.decomposable ? volColor : 'var(--color-text-muted)';
          const clickable = onRowClick !== undefined;
          return (
            <g key={key}>
              {tooltip.active?.key === key && (
                <rect x={0} y={i * ROW_H + 2} width={width} height={ROW_H} rx={4} fill="var(--color-bg-tertiary)" opacity={0.45} />
              )}
              <text x={0} y={cy + 3} fontSize={11} fill="var(--color-text-secondary)">{truncate(r.name, 16)}</text>
              <rect x={Math.min(volX0, volX1)} y={barY} width={Math.max(Math.abs(volX1 - volX0), 0.5)} height={14} fill={volFill} rx={1.5} />
              {r.decomposable && (
                <rect x={Math.min(volX1, rateX1)} y={barY} width={Math.max(Math.abs(rateX1 - volX1), 0.5)} height={14} fill={rateColor} rx={1.5} />
              )}
              <text
                x={width - 6}
                y={cy + 3}
                textAnchor="end"
                fontSize={11}
                className="tabular-nums"
                fill={r.totalDelta >= 0 ? 'var(--color-negative)' : 'var(--color-positive)'}
              >
                {signedDollars(r.totalDelta)}
              </text>
              {/* Hit area: the whole row, not just the (often thin) bars. */}
              <rect
                x={0}
                y={i * ROW_H + 2}
                width={width}
                height={ROW_H}
                fill="transparent"
                data-row={r.name}
                style={{ cursor: clickable ? 'pointer' : 'default' }}
                onMouseMove={(e) => { tooltip.show(e, rowTooltip(r, key, volColor, rateColor)); }}
                onMouseLeave={tooltip.hide}
                onClick={() => { onRowClick?.(r); }}
              />
            </g>
          );
        })}
      </svg>
      {tooltip.element}
    </div>
  );
}
