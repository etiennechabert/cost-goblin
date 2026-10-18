import type { EntityRef, TrendRow } from '@costgoblin/core/browser';

export type WaterfallStepKind = 'start' | 'increase' | 'decrease' | 'other' | 'end';

/** One bar in a cost bridge. `start`/`end` are cumulative running levels in $;
 *  for the anchor bars (`start`/`end`) they run from 0 to the period total. */
export interface WaterfallStep {
  readonly name: string;
  /** The underlying entity, for click-to-filter. Null for anchors and "Other". */
  readonly entity: EntityRef | null;
  readonly delta: number;
  readonly start: number;
  readonly end: number;
  readonly kind: WaterfallStepKind;
}

export interface WaterfallModel {
  readonly steps: readonly WaterfallStep[];
  readonly startTotal: number;
  readonly endTotal: number;
  readonly netDelta: number;
  /** How many movers were folded into the "Other" step. */
  readonly otherCount: number;
}

/** Decompose a period-over-period delta into an additive bridge: a start anchor,
 *  the `topN` largest signed movers, a folded "Other" remainder, and an end
 *  anchor. Reconciles by construction — Σ(step deltas) === endTotal − startTotal —
 *  regardless of how many movers are folded. */
export function buildWaterfall(rows: readonly TrendRow[], topN = 8): WaterfallModel {
  const startTotal = rows.reduce((s, r) => s + r.previousCost, 0);
  const endTotal = rows.reduce((s, r) => s + r.currentCost, 0);

  const movers = rows.filter(r => r.delta !== 0).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const named = movers.slice(0, topN);
  const rest = movers.slice(topN);
  const otherDelta = rest.reduce((s, r) => s + r.delta, 0);

  const steps: WaterfallStep[] = [
    { name: 'Start', entity: null, delta: startTotal, start: 0, end: startTotal, kind: 'start' },
  ];

  let running = startTotal;
  for (const r of named) {
    const end = running + r.delta;
    steps.push({
      name: r.entity,
      entity: r.entity,
      delta: r.delta,
      start: running,
      end,
      kind: r.delta >= 0 ? 'increase' : 'decrease',
    });
    running = end;
  }

  if (rest.length > 0 && otherDelta !== 0) {
    const end = running + otherDelta;
    steps.push({ name: `Other (${String(rest.length)})`, entity: null, delta: otherDelta, start: running, end, kind: 'other' });
  }

  steps.push({ name: 'End', entity: null, delta: endTotal, start: 0, end: endTotal, kind: 'end' });

  return { steps, startTotal, endTotal, netDelta: endTotal - startTotal, otherCount: rest.length };
}

export interface WaterfallScale {
  /** Bottom of the value axis: 0, or above it when zoomed onto the movement. */
  readonly floor: number;
  readonly ceiling: number;
  /** True when the floor is above zero, so the Start/End bars are cut short. */
  readonly truncated: boolean;
}

/** Zoom when the movement spans less than this share of the tallest level. */
const ZOOM_BELOW = 0.5;
/** Room left under the lowest level, as a share of the movement, so the cut
 *  Start/End bars still read as bars. */
const ZOOM_HEADROOM = 0.5;

/** Round down to two significant digits, so the axis floor reads cleanly. */
function niceFloor(v: number): number {
  if (v <= 0) return 0;
  const step = 10 ** (Math.floor(Math.log10(v)) - 1);
  return Math.floor(v / step) * step;
}

/** Value-axis extent for a bridge. An axis from $0 squashes the movers into
 *  slivers whenever the change is small next to the totals (+$1.9k on $9.3k
 *  leaves most of them under 2px), so when every level stays positive and the
 *  movement is small, the axis starts just under the lowest level instead and
 *  the Start/End bars are drawn cut. Levels are the anchors' totals and every
 *  mover's running start and end. */
export function waterfallScale(steps: readonly WaterfallStep[]): WaterfallScale {
  const levels = steps.flatMap(s => (s.kind === 'start' || s.kind === 'end' ? [s.end] : [s.start, s.end]));
  if (levels.length === 0) return { floor: 0, ceiling: 1, truncated: false };
  const lo = Math.min(...levels);
  const hi = Math.max(...levels);
  if (lo <= 0) return { floor: Math.min(lo, 0), ceiling: Math.max(hi, 0), truncated: false };
  const movement = hi - lo;
  if (movement === 0 || movement >= hi * ZOOM_BELOW) return { floor: 0, ceiling: hi, truncated: false };
  const floor = niceFloor(lo - movement * ZOOM_HEADROOM);
  return { floor, ceiling: hi, truncated: floor > 0 };
}
