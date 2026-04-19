import { useCallback, useMemo, useState } from 'react';
import { PALETTE_STANDARD } from '../lib/palette.js';
import { useContainerWidth } from '../lib/use-container-width.js';
import { formatDollars } from './format.js';
import type { Dimension } from '@costgoblin/core/browser';
import { getDimensionId, getDimensionLabel } from '../lib/dimensions.js';

export interface TopNBar {
  readonly name: string;
  readonly cost: number;
  readonly percentage: number;
}

interface TopNBarChartProps {
  readonly data: readonly TopNBar[];
  readonly title: string;
  readonly subtitle?: string | undefined;
  readonly topN?: number | undefined;
  readonly onBarClick?: ((name: string) => void) | undefined;
  readonly onBarHover?: ((name: string | null) => void) | undefined;
  readonly externalHoveredName?: string | null | undefined;
  readonly collapsed?: boolean | undefined;
  readonly onExpandToggle?: (() => void) | undefined;
  readonly dimensions?: readonly Dimension[] | undefined;
  readonly activeDimensionId?: string | undefined;
  readonly onDimensionChange?: ((dimId: string) => void) | undefined;
}

const ROW_HEIGHT = 24;
const ROW_GAP = 6;
const LABEL_WIDTH = 140;
const RIGHT_GUTTER = 90;
const CHART_HEIGHT = 320;

function CollapsedBar({ title, onExpandToggle }: { title: string; onExpandToggle?: (() => void) | undefined }) {
  return (
    <button
      type="button"
      onClick={onExpandToggle}
      className="flex flex-col items-center justify-center gap-2 rounded-xl border border-border bg-bg-secondary/50 px-2 py-6 hover:bg-bg-tertiary/30 transition-colors min-h-[260px]"
    >
      <span className="text-xs font-medium text-text-secondary [writing-mode:vertical-rl] rotate-180">
        {title}
      </span>
    </button>
  );
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function TopNBarChartInner({
  data,
  title,
  subtitle,
  topN = 12,
  onBarClick,
  onBarHover,
  externalHoveredName,
  onExpandToggle,
  dimensions,
  activeDimensionId,
  onDimensionChange,
  width,
}: Omit<TopNBarChartProps, 'collapsed'> & { width: number }) {
  const [localHovered, setLocalHovered] = useState<string | null>(null);
  const hoveredName = externalHoveredName ?? localHovered;

  const sliced = useMemo(
    () => [...data].sort((a, b) => b.cost - a.cost).slice(0, topN),
    [data, topN],
  );

  const max = sliced.length > 0 ? sliced[0]?.cost ?? 0 : 0;
  const barAreaWidth = Math.max(width - LABEL_WIDTH - RIGHT_GUTTER, 40);

  const handleEnter = useCallback((name: string) => {
    setLocalHovered(name);
    onBarHover?.(name);
  }, [onBarHover]);

  const handleLeave = useCallback(() => {
    setLocalHovered(null);
    onBarHover?.(null);
  }, [onBarHover]);

  return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-4 flex flex-col" style={{ height: CHART_HEIGHT }}>
      <div className="flex items-center justify-between mb-3">
        {dimensions !== undefined && dimensions.length > 0 && onDimensionChange !== undefined ? (
          <select
            value={activeDimensionId ?? ''}
            onChange={(e) => { onDimensionChange(e.target.value); }}
            className="text-sm font-medium text-text-secondary bg-transparent border-none outline-none cursor-pointer hover:text-text-primary transition-colors appearance-none pr-4"
            style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg width=\'10\' height=\'6\' viewBox=\'0 0 10 6\' fill=\'none\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cpath d=\'M1 1l4 4 4-4\' stroke=\'%236b7280\' stroke-width=\'1.5\' stroke-linecap=\'round\'/%3E%3C/svg%3E")', backgroundRepeat: 'no-repeat', backgroundPosition: 'right center' }}
          >
            {dimensions.map(d => (
              <option key={getDimensionId(d)} value={getDimensionId(d)}>
                {getDimensionLabel(d)}
              </option>
            ))}
          </select>
        ) : (
          <h3 className="text-sm font-medium text-text-secondary">{title}</h3>
        )}
        <div className="flex items-center gap-2">
          {subtitle !== undefined && (
            <span className="text-[11px] text-text-muted">{subtitle}</span>
          )}
          {onExpandToggle !== undefined && (
            <button
              type="button"
              onClick={onExpandToggle}
              className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-tertiary/50 transition-colors"
              title="Toggle expand"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M1 5V1h4M9 1h4v4M1 9v4h4M9 13h4v-4" />
              </svg>
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto" style={{ minWidth: 0 }}>
        {sliced.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-text-muted">No data</div>
        ) : (
          <ul className="flex flex-col" style={{ gap: ROW_GAP }}>
            {sliced.map((row, i) => {
              const isHovered = hoveredName === row.name;
              const isDimmed = hoveredName !== null && !isHovered;
              const ratio = max > 0 ? row.cost / max : 0;
              const barW = Math.max(ratio * barAreaWidth, 1);
              const color = PALETTE_STANDARD[i % PALETTE_STANDARD.length] ?? '#374151';

              return (
                <li
                  key={row.name}
                  onMouseEnter={() => { handleEnter(row.name); }}
                  onMouseLeave={handleLeave}
                  onClick={() => { onBarClick?.(row.name); }}
                  className="flex items-center gap-3 rounded px-1 transition-colors"
                  style={{
                    cursor: onBarClick !== undefined ? 'pointer' : 'default',
                    height: ROW_HEIGHT,
                    opacity: isDimmed ? 0.4 : 1,
                    backgroundColor: isHovered ? 'rgba(255,255,255,0.05)' : 'transparent',
                  }}
                  title={`${row.name} — ${formatDollars(row.cost)}`}
                >
                  <span
                    className="text-xs tabular-nums text-text-secondary text-right shrink-0"
                    style={{ width: LABEL_WIDTH - 16 }}
                  >
                    {truncate(row.name, 22)}
                  </span>
                  <div className="flex-1 relative" style={{ height: ROW_HEIGHT - 8 }}>
                    <div
                      className="absolute inset-y-0 left-0 rounded-sm"
                      style={{
                        width: barW,
                        background: color,
                        transition: 'width 0.2s ease, filter 0.15s ease',
                        filter: isHovered ? 'brightness(1.2)' : 'none',
                      }}
                    />
                  </div>
                  <span
                    className="text-xs tabular-nums text-text-primary font-medium shrink-0 text-right"
                    style={{ width: RIGHT_GUTTER - 8 }}
                  >
                    {formatDollars(row.cost)}
                    <span className="ml-1 text-text-muted font-normal">
                      ({row.percentage.toFixed(1)}%)
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

export function TopNBarChart(props: TopNBarChartProps) {
  const [containerRef, width] = useContainerWidth();

  if (props.collapsed === true) {
    return <CollapsedBar title={props.title} onExpandToggle={props.onExpandToggle} />;
  }

  return (
    <div ref={containerRef} style={{ width: '100%' }}>
      {width > 10 && <TopNBarChartInner {...props} width={width} />}
    </div>
  );
}
