import { useMemo } from 'react';
import { Group } from '@visx/group';
import { Treemap, treemapSquarify, stratify } from '@visx/hierarchy';
import { ParentSize } from '@visx/responsive';
import { PALETTE_STANDARD } from '../lib/palette.js';
import { formatDollars } from './format.js';

export interface TreemapCell {
  readonly name: string;
  readonly cost: number;
}

interface TreemapChartProps {
  readonly data: readonly TreemapCell[];
  readonly title?: string | undefined;
  readonly subtitle?: string | undefined;
  readonly height?: number | undefined;
  readonly onCellClick?: ((name: string) => void) | undefined;
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
}: TreemapChartProps & { readonly width: number; readonly height: number }) {
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
              const color = PALETTE_STANDARD[i % PALETTE_STANDARD.length] ?? '#374151';
              const name = node.data.id;
              const cost = node.value ?? 0;
              const showLabel = w > 60 && h > 24;
              return (
                <Group key={`${name}-${String(i)}`} top={node.y0} left={node.x0}>
                  <rect
                    width={w}
                    height={h}
                    fill={color}
                    fillOpacity={0.85}
                    stroke="var(--color-bg-secondary)"
                    strokeWidth={1.5}
                    style={{ cursor: onCellClick !== undefined ? 'pointer' : 'default' }}
                    onClick={() => { onCellClick?.(name); }}
                  >
                    <title>{`${name} — ${formatDollars(cost)}`}</title>
                  </rect>
                  {showLabel && (
                    <>
                      <text
                        x={6}
                        y={14}
                        fontSize={11}
                        fontWeight={600}
                        fill="var(--color-bg-primary)"
                        pointerEvents="none"
                      >
                        {name.length > Math.floor(w / 7) ? `${name.slice(0, Math.floor(w / 7) - 1)}…` : name}
                      </text>
                      {h > 38 && (
                        <text
                          x={6}
                          y={28}
                          fontSize={10}
                          fill="var(--color-bg-primary)"
                          fillOpacity={0.85}
                          pointerEvents="none"
                        >
                          {formatDollars(cost)}
                        </text>
                      )}
                    </>
                  )}
                </Group>
              );
            })}
          </Group>
        )}
      </Treemap>
    </svg>
  );
}

export function TreemapChart({ data, title, subtitle, height = 320, onCellClick }: TreemapChartProps) {
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
            <TreemapInner
              data={data}
              title={title}
              subtitle={subtitle}
              width={width}
              height={h}
              onCellClick={onCellClick}
            />
          )}
        </ParentSize>
      </div>
    </div>
  );
}
