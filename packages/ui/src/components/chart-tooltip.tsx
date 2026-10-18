import { useCallback } from 'react';
import type { ReactNode } from 'react';
import { localPoint } from '@visx/event';
import { TooltipWithBounds, useTooltip } from '@visx/tooltip';
import { TOOLTIP_STYLES } from '../lib/tooltip-styles.js';

export interface ChartTooltipRow {
  readonly label: string;
  readonly value: string;
  /** Swatch identifying a series; omit for plain rows. */
  readonly color?: string | undefined;
  /** Draws the swatch as a dash, for a ghost or projected series. */
  readonly dashed?: boolean | undefined;
}

export interface ChartTooltipContent {
  /** Identifies the hovered mark, so a chart can highlight it. */
  readonly key: string;
  readonly title: string;
  readonly rows: readonly ChartTooltipRow[];
  /** Muted line under the rows, for a caveat. */
  readonly note?: string | undefined;
}

export interface ChartTooltip {
  /** Show `content` at the pointer. Wire to a mark's (or hit area's) mouse move. */
  readonly show: (event: React.MouseEvent<SVGElement>, content: ChartTooltipContent) => void;
  readonly hide: () => void;
  /** The content on screen, or null. */
  readonly active: ChartTooltipContent | null;
  /** Render next to the chart's SVG, inside a `relative` wrapper whose top-left
   *  is the SVG's, so pointer coordinates and tooltip placement agree. */
  readonly element: ReactNode;
}

/** Styled hover tooltip for the hand-drawn SVG charts, matching the line and
 *  bubble charts (visx tooltip, TOOLTIP_STYLES), instead of a native `<title>`
 *  that shows late, unstyled and on one line. */
export function useChartTooltip(): ChartTooltip {
  const { showTooltip, hideTooltip, tooltipData, tooltipLeft, tooltipTop, tooltipOpen } = useTooltip<ChartTooltipContent>();

  const show = useCallback((event: React.MouseEvent<SVGElement>, content: ChartTooltipContent) => {
    const point = localPoint(event);
    if (point === null) return;
    showTooltip({ tooltipData: content, tooltipLeft: point.x, tooltipTop: point.y });
  }, [showTooltip]);

  const active = tooltipOpen && tooltipData !== undefined ? tooltipData : null;
  const element = active !== null && tooltipLeft !== undefined && tooltipTop !== undefined
    ? (
      <TooltipWithBounds left={tooltipLeft} top={tooltipTop} style={TOOLTIP_STYLES}>
        <div className="flex flex-col gap-0.5" role="tooltip">
          <span className="font-medium text-text-primary mb-1">{active.title}</span>
          {active.rows.map(r => (
            <span key={r.label} className="flex items-center gap-1.5">
              {r.color !== undefined && (
                r.dashed === true
                  ? <span className="inline-block w-2.5 border-t-2 border-dashed" style={{ borderColor: r.color }} />
                  : <span className="inline-block w-2 h-2 rounded-sm" style={{ background: r.color }} />
              )}
              <span className="text-text-secondary">{r.label}</span>
              <span className="text-text-primary tabular-nums ml-auto pl-3">{r.value}</span>
            </span>
          ))}
          {active.note !== undefined && <span className="text-text-muted mt-1 max-w-[220px]">{active.note}</span>}
        </div>
      </TooltipWithBounds>
    )
    : null;

  return { show, hide: hideTooltip, active, element };
}
