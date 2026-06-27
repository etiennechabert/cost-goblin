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
