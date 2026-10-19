import { useMemo } from 'react';
import { Group } from '@visx/group';
import { Treemap, treemapSquarify, stratify } from '@visx/hierarchy';
import { ParentSize } from '@visx/responsive';
import { formatDollars, formatPercent, formatShare } from './format.js';
import { useChartTooltip, type ChartTooltipContent } from './chart-tooltip.js';
import { useSeriesColors } from '../hooks/use-palette.js';

export interface TreemapCell {
  readonly name: string;
  readonly cost: number;
}

interface TreemapChartProps {
  readonly data: readonly TreemapCell[];
  readonly title?: React.ReactNode | undefined;
  readonly subtitle?: string | undefined;
  readonly height?: number | undefined;
  readonly onCellClick?: ((name: string) => void) | undefined;
  readonly onCellHover?: ((name: string | null) => void) | undefined;
  readonly externalHoveredName?: string | null | undefined;
  readonly previousCosts?: ReadonlyMap<string, number> | undefined;
}

/** The cell's accessible name: name, cost and the change, e.g. "S3 — $250.00 (↑25.0%)". */
function cellLabel(name: string, cost: number, previous: number | undefined): string {
  const base = `${name} — ${formatDollars(cost)}`;
  if (previous === undefined || previous <= 0) return base;
  const pct = ((cost - previous) / previous) * 100;
  return `${base} (${pct >= 0 ? '↑' : '↓'}${Math.abs(pct).toFixed(1)}%)`;
}

function cellTooltip(name: string, cost: number, total: number, previous: number | undefined): ChartTooltipContent {
  return {
    key: name,
    title: name,
    rows: [
      { label: 'Cost', value: formatDollars(cost) },
      { label: 'Share of spend', value: formatShare(total > 0 ? cost / total : 0) },
      ...(previous === undefined
        ? []
        : [
          { label: 'Previous period', value: formatDollars(previous) },
          ...(previous > 0 ? [{ label: 'Change', value: formatPercent(((cost - previous) / previous) * 100) }] : []),
        ]),
    ],
  };
}

interface FlatNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly cost: number;
}

function TreemapInner({
  data,
  width,
  height,
  onCellClick,
  onCellHover,
  externalHoveredName,
  previousCosts,
}: Omit<TreemapChartProps, 'title' | 'subtitle'> & { readonly width: number; readonly height: number }) {
  const seriesColor = useSeriesColors(data);
  const tooltip = useChartTooltip();
  const total = useMemo(() => data.reduce((sum, d) => sum + d.cost, 0), [data]);
  const root = useMemo(() => {
    const flat: FlatNode[] = [
      { id: 'root', parentId: null, cost: 0 },
      ...data.map(d => ({ id: d.name, parentId: 'root', cost: d.cost })),
    ];
    const stratifier = stratify<FlatNode>()
      .id((n) => n.id)
      .parentId((n) => n.parentId);
    return stratifier(flat).sum((n) => n.cost);
  }, [data]);

  if (data.length === 0 || width <= 10 || height <= 10) {
    return <div className="flex h-full items-center justify-center text-xs text-text-muted">No data</div>;
  }

  return (
    <div className="relative" style={{ width, height }}>
      <svg width={width} height={height}>
        <Treemap<FlatNode>
          top={0}
          root={root}
          size={[width, height]}
          tile={treemapSquarify}
          round
        >
          {(treemap) => (
            <Group>
              {treemap.descendants().map((node, i) => {
                if (node.depth === 0) return null;
                const w = node.x1 - node.x0;
                const h = node.y1 - node.y0;
                const name = node.data.id;
                const color = seriesColor(name);
                const cost = node.value ?? 0;
                const showLabel = w > 60 && h > 24;
                const isHovered = externalHoveredName === name;
                const isDimmed = externalHoveredName !== null && externalHoveredName !== undefined && !isHovered;
                return (
                  <Group key={`${name}-${String(i)}`} top={node.y0} left={node.x0}>
                    <rect
                      width={w}
                      height={h}
                      fill={color}
                      fillOpacity={isDimmed ? 0.35 : 0.85}
                      stroke={isHovered ? '#ffffff' : 'var(--color-bg-secondary)'}
                      strokeWidth={isHovered ? 2 : 1.5}
                      style={{ cursor: onCellClick === undefined ? 'default' : 'pointer', transition: 'fill-opacity 0.15s, stroke 0.15s' }}
                      data-cell={name}
                      aria-label={cellLabel(name, cost, previousCosts?.get(name))}
                      onClick={() => { onCellClick?.(name); }}
                      onMouseEnter={() => { onCellHover?.(name); }}
                      onMouseMove={(e) => { tooltip.show(e, cellTooltip(name, cost, total, previousCosts?.get(name))); }}
                      onMouseLeave={() => { onCellHover?.(null); tooltip.hide(); }}
                    />
                    {showLabel && (() => {
                      const prev = previousCosts?.get(name);
                      const pctDelta = prev !== undefined && prev > 0 ? ((cost - prev) / prev) * 100 : undefined;
                      return (
                      <>
                        <text
                          x={6}
                          y={14}
                          fontSize={11}
                          fontWeight={600}
                          fill="white"
                          pointerEvents="none"
                          style={{ textShadow: '0 1px 2px rgba(0,0,0,0.6), 0 0 4px rgba(0,0,0,0.3)' }}
                        >
                          {name.length > Math.floor(w / 7) ? `${name.slice(0, Math.floor(w / 7) - 1)}…` : name}
                        </text>
                        {h > 38 && (
                          <text
                            x={6}
                            y={28}
                            fontSize={10}
                            fill="white"
                            fillOpacity={0.9}
                            pointerEvents="none"
                            style={{ textShadow: '0 1px 2px rgba(0,0,0,0.6), 0 0 4px rgba(0,0,0,0.3)' }}
                          >
                            {formatDollars(cost)}
                            {pctDelta !== undefined && (
                              <tspan fill={pctDelta >= 0 ? '#fecaca' : '#bbf7d0'} fillOpacity={1}>
                                {' '}{pctDelta >= 0 ? '↑' : '↓'}{Math.abs(pctDelta).toFixed(1)}%
                              </tspan>
                            )}
                          </text>
                        )}
                      </>
                      );
                    })()}
                  </Group>
                );
              })}
            </Group>
          )}
        </Treemap>
      </svg>
      {tooltip.element}
    </div>
  );
}

export function TreemapChart({ data, title, subtitle, height = 320, onCellClick, onCellHover, externalHoveredName, previousCosts }: TreemapChartProps) {
  return (
    <div
      className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-4 flex flex-col"
      style={{ height }}
      onMouseLeave={() => { onCellHover?.(null); }}
    >
      {(title !== undefined || subtitle !== undefined) && (
        <div className="flex items-center justify-between mb-2">
          {title !== undefined && <h3 className="text-sm font-medium text-text-secondary">{title}</h3>}
          {subtitle !== undefined && <span className="text-[11px] text-text-muted">{subtitle}</span>}
        </div>
      )}
      <div className="flex-1 min-h-0">
        <ParentSize>
          {({ width, height: h }) => (
            <TreemapInner
              data={data}
              width={width}
              height={h}
              onCellClick={onCellClick}
              onCellHover={onCellHover}
              externalHoveredName={externalHoveredName}
              previousCosts={previousCosts}
            />
          )}
        </ParentSize>
      </div>
    </div>
  );
}
