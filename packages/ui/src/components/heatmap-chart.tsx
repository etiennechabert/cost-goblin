import { useMemo } from 'react';
import { Group } from '@visx/group';
import { scaleBand, scaleLinear } from '@visx/scale';
import { ParentSize } from '@visx/responsive';
import { formatDollars } from './format.js';

export interface HeatmapCell {
  readonly date: string;
  readonly group: string;
  readonly cost: number;
}

interface HeatmapChartProps {
  readonly cells: readonly HeatmapCell[];
  readonly groups: readonly string[];
  readonly dates: readonly string[];
  readonly title?: string | undefined;
  readonly subtitle?: string | undefined;
  readonly height?: number | undefined;
  readonly onCellClick?: ((group: string, date: string) => void) | undefined;
}

const MARGIN = { top: 8, right: 12, bottom: 26, left: 110 };
const COLOR_LOW = '#0f172a';
const COLOR_HIGH = '#10b981';

function HeatmapInner({
  cells,
  groups,
  dates,
  width,
  height,
  onCellClick,
}: HeatmapChartProps & { readonly width: number; readonly height: number }) {
  const innerW = Math.max(width - MARGIN.left - MARGIN.right, 10);
  const innerH = Math.max(height - MARGIN.top - MARGIN.bottom, 10);

  const xScale = useMemo(() => scaleBand<string>({
    domain: [...dates],
    range: [0, innerW],
    padding: 0.05,
  }), [dates, innerW]);

  const yScale = useMemo(() => scaleBand<string>({
    domain: [...groups],
    range: [0, innerH],
    padding: 0.08,
  }), [groups, innerH]);

  const max = useMemo(
    () => cells.reduce((m, c) => Math.max(m, c.cost), 0),
    [cells],
  );

  const colorScale = useMemo(() => scaleLinear<string>({
    domain: [0, max || 1],
    range: [COLOR_LOW, COLOR_HIGH],
  }), [max]);

  const cellW = xScale.bandwidth();
  const cellH = yScale.bandwidth();

  return (
    <svg width={width} height={height}>
      <Group left={MARGIN.left} top={MARGIN.top}>
        {cells.map((c) => {
          const x = xScale(c.date) ?? 0;
          const y = yScale(c.group) ?? 0;
          return (
            <rect
              key={`${c.group}-${c.date}`}
              x={x}
              y={y}
              width={cellW}
              height={cellH}
              fill={colorScale(c.cost)}
              rx={2}
              onClick={() => { onCellClick?.(c.group, c.date); }}
              style={{ cursor: onCellClick !== undefined ? 'pointer' : 'default' }}
            >
              <title>{`${c.group} • ${c.date} — ${formatDollars(c.cost)}`}</title>
            </rect>
          );
        })}
        {groups.map((g) => {
          const y = (yScale(g) ?? 0) + cellH / 2;
          return (
            <text
              key={g}
              x={-8}
              y={y}
              fontSize={10}
              textAnchor="end"
              dy="0.33em"
              fill="var(--color-text-secondary)"
            >
              {g.length > 16 ? `${g.slice(0, 15)}…` : g}
            </text>
          );
        })}
        {dates.length > 0 && (() => {
          const tickEvery = Math.max(1, Math.ceil(dates.length / Math.max(4, Math.floor(innerW / 60))));
          return dates
            .map((d, i) => ({ d, i }))
            .filter(({ i }) => i % tickEvery === 0)
            .map(({ d, i: idx }) => {
              const x = (xScale(d) ?? 0) + cellW / 2;
              return (
                <text
                  key={`${d}-${String(idx)}`}
                  x={x}
                  y={innerH + 14}
                  fontSize={9}
                  textAnchor="middle"
                  fill="var(--color-text-muted)"
                >
                  {d.slice(5)}
                </text>
              );
            });
        })()}
      </Group>
    </svg>
  );
}

export function HeatmapChart({
  cells,
  groups,
  dates,
  title,
  subtitle,
  height = 320,
  onCellClick,
}: HeatmapChartProps) {
  return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-4 flex flex-col" style={{ height }}>
      {(title !== undefined || subtitle !== undefined) && (
        <div className="flex items-center justify-between mb-2">
          {title !== undefined && <h3 className="text-sm font-medium text-text-secondary">{title}</h3>}
          {subtitle !== undefined && <span className="text-[11px] text-text-muted">{subtitle}</span>}
        </div>
      )}
      <div className="flex-1 min-h-0">
        {cells.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-text-muted">No data</div>
        ) : (
          <ParentSize>
            {({ width, height: h }) => (
              width > 10 && h > 10 ? (
                <HeatmapInner
                  cells={cells}
                  groups={groups}
                  dates={dates}
                  width={width}
                  height={h}
                  onCellClick={onCellClick}
                />
              ) : null
            )}
          </ParentSize>
        )}
      </div>
    </div>
  );
}
