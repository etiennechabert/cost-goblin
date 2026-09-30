import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { join } from 'node:path';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { stringify } from 'yaml';
import { WIDGET_TYPES } from '../packages/core/src/config/views-validator.js';
import type { WidgetSize, WidgetType } from '../packages/core/src/types/views.js';
import {
  FIXTURE_CONFIG_DIR,
  assertNoReactCrash,
  clickNavButton,
  launchAppWithCoverage,
  finishCoverage,
  waitForQuerySettle,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Widget growth regression — every widget type × every size stays bounded
// ---------------------------------------------------------------------------
//
// Hunts runaway layout growth (a ResizeObserver feeding its own measurement
// back into the size it observes, a flex item chasing its content, …) across
// every widget type the app knows (core's own list, so a new type joins the
// matrix automatically) at every lane width, all on ONE dashboard so the whole
// matrix shares a single navigation and a single observation.

const VIEW_NAME = 'widget-matrix';

interface MatrixWidget {
  readonly id: string;
  readonly type: WidgetType;
  readonly size: WidgetSize;
}
const matrixWidget = (type: WidgetType, size: WidgetSize): MatrixWidget => ({ id: `w-${type}-${size}`, type, size });
const SIZES: readonly WidgetSize[] = ['small', 'medium', 'large', 'full'];
const MATRIX_IDS: readonly string[] = WIDGET_TYPES.flatMap(t => SIZES.map(s => matrixWidget(t, s).id));
/** A lane's share of its row (custom-view.tsx: flexBasis per size, flexGrow 1). */
const LANE_FRACTION: Readonly<Record<WidgetSize, number>> = { small: 0.25, medium: 0.5, large: 0.75, full: 1 };
/** Row gap between lanes (custom-view.tsx `gap-4`): the slack a lane's width may
 *  show against its nominal fraction of a full-width lane. */
const LANE_GAP_PX = 16;

// Observation: sample every 250ms and pass on the first window of 10
// consecutive samples (2.25s) that is clean — every widget present, none
// loading, and no metric growing. There is no separate settle: late data, a
// chart sizing itself, a one-shot reflow just reject windows until they slide
// out of view. A widget that keeps growing never yields a clean window, and
// at the deadline the last window names it.
//
// "Growing" is judged two ways:
//  - rate: each inter-sample delta against 32 px/s × the time that actually
//    elapsed (timers stretch under CI load; a feedback loop grows per rendered
//    frame, i.e. per unit of time). 32 px/s keeps the old suite's sensitivity
//    (20px per 600ms ≈ 33 px/s): 8px per nominal interval. A ResizeObserver
//    loop driven every frame is ≥60 px/s even at 1px per frame at 60fps.
//  - net: any metric more than 1px bigger at the end of the window than at
//    its start. This catches creep under the rate budget — charts sized by
//    visx ParentSize re-measure through a 300ms debounce, so a loop there
//    steps only a few times a second and can stay under 8px per interval.
// A settled layout is deterministic — repeated measurements are identical,
// sub-pixel rounding aside — so an honest widget shows 0 on both.
const SAMPLE_COUNT = 10;
const SAMPLE_INTERVAL_MS = 250;
const MAX_GROWTH_PX_PER_SEC = 32;
const MAX_NET_GROWTH_PX = 1;
/** Time to find a clean window, counted from the first sample. Covers the
 *  tail of data loading on a slow runner; a passing run needs 2.25s. */
const OBSERVE_DEADLINE_MS = 15_000;

/** What each sample records per widget slot (plus a `page` entry for the
 *  document — the old suite's only signal — as a backstop for growth outside
 *  any slot):
 *  - width / height: the slot's border box — its lane's width, and its
 *    natural (un-stretched) height;
 *  - scrollWidth / scrollHeight: the slot's scrollable overflow, i.e. content
 *    spilling out of the lane;
 *  - clippedWidth / clippedHeight: overflow clipped inside descendant
 *    scroll/clip containers (a table's scroll body, a chart's fixed-height
 *    wrapper). Growth there never moves the slot's box or the document. */
const METRICS = ['width', 'height', 'scrollWidth', 'scrollHeight', 'clippedWidth', 'clippedHeight'] as const;
type Extent = { readonly id: string } & { readonly [M in (typeof METRICS)[number]]: number };

interface Sample {
  /** The renderer's clock, so intervals don't include CDP round-trips. */
  readonly at: number;
  readonly extents: readonly Extent[];
  /** Slots still showing a loading state. */
  readonly loading: readonly string[];
}

test.describe('Widget growth', () => {
  let configDir: string;
  let widgetApp: ElectronApplication;
  let widgetPage: Page;

  test.beforeAll(async () => {
    configDir = mkdtempSync(join(tmpdir(), 'costgoblin-widget-growth-'));
    for (const f of ['costgoblin.yaml', 'dimensions.yaml', 'org-tree.yaml']) {
      const src = join(FIXTURE_CONFIG_DIR, f);
      if (existsSync(src)) writeFileSync(join(configDir, f), readFileSync(src));
    }
    writeFileSync(join(configDir, 'views.yaml'), buildWidgetMatrixYaml());

    ({ app: widgetApp, page: widgetPage } = await launchAppWithCoverage({ configDir }));
    await widgetPage.setViewportSize({ width: 1400, height: 900 });
  });

  test.afterAll(async () => {
    await finishCoverage(widgetApp, widgetPage, 'stress');
    rmSync(configDir, { recursive: true, force: true });
  });

  test('every widget type stays bounded at every size', async () => {
    // Budget: navigation + waitForQuerySettle (~6s) + widgets on the dashboard
    // (10s) + every slot mounted (60s) + observation (15s + a window) — the
    // whole matrix in one test, so well past the 30s default.
    test.setTimeout(120_000);
    const page = widgetPage;
    await clickNavButton(page, VIEW_NAME);
    await waitForQuerySettle(page);

    const slotIds = (selector: string): Promise<(string | null)[]> =>
      page.locator(selector).evaluateAll(els => els.map(el => el.getAttribute('data-widget-id')));
    await expect.poll(async () => {
      const ids = new Set(await slotIds('[data-widget-id]'));
      return MATRIX_IDS.filter(id => !ids.has(id));
    }, { message: 'every matrix widget is on the dashboard', timeout: 10_000 }).toEqual([]);

    // Slots mount lazily — only once scrolled near the viewport — so walk
    // each one into view; the scheduler then mounts them a few at a time, as
    // their queries settle. That is ~1s locally but tens of seconds on a
    // loaded CI runner, hence the budget. Each poll re-walks whatever is still
    // deferred, in case an observer entry was missed, and a timeout reports
    // the ids still waiting.
    await page.mouse.move(0, 0); // over the sticky header, so the walk hovers no widget
    await expect.poll(async () => {
      await requestMounts(page);
      return slotIds('[data-widget-state="deferred"]');
    }, { message: 'every widget slot mounts', timeout: 60_000, intervals: [1_000] }).toEqual([]);

    const { recent, waitedMs } = await observe(page);

    await assertNoReactCrash(page);
    expect(windowProblems(recent), `widgets loading, missing or growing in the last window (${String(Math.round(waitedMs))}ms of sampling)`).toEqual([]);
    expect(laneWidthProblems(recent[0]), 'lanes off their nominal width').toEqual([]);
  });
});

/** Scroll every still-deferred slot into view so its IntersectionObserver
 *  asks the scheduler for a mount (the request is sticky; the mount then waits
 *  for its turn).
 *
 *  A slot is skipped only if it was inside the viewport in the layout the
 *  observer last computed — intersecting under any non-negative root margin.
 *  That layout is snapshotted from a rAF callback: nothing commits between it
 *  and the same frame's intersection pass, whereas live rects read later can
 *  already reflect a mount wave that moved slots the observer never saw. */
async function requestMounts(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const frame = (): Promise<void> => new Promise(resolve => { requestAnimationFrame(() => { resolve(); }); });
    const inViewport = (): Set<Element> => new Set([...document.querySelectorAll('[data-widget-id]')].filter(el => {
      const r = el.getBoundingClientRect();
      return r.bottom > 0 && r.top < window.innerHeight;
    }));
    // Each stop: snapshot in this frame's rAF, then one more frame so the
    // observer has computed and delivered on that layout.
    const settleAt = async (): Promise<Set<Element>> => {
      await frame();
      const seen = inViewport();
      await frame();
      return seen;
    };
    let seen = await settleAt();
    for (const el of document.querySelectorAll('[data-widget-id][data-widget-state="deferred"]')) {
      if (seen.has(el)) continue;
      el.scrollIntoView({ block: 'start' });
      seen = await settleAt();
    }
    window.scrollTo(0, 0);
  });
}

/** Sample until the last SAMPLE_COUNT samples form a clean window, or the
 *  deadline passes; returns that last window either way. */
async function observe(page: Page): Promise<{ recent: readonly Sample[]; waitedMs: number }> {
  const samples: Sample[] = [];
  for (;;) {
    samples.push(await page.evaluate(measureLayout));
    const recent = samples.slice(-SAMPLE_COUNT);
    const first = samples[0];
    const last = samples.at(-1);
    const waitedMs = first === undefined || last === undefined ? 0 : last.at - first.at;
    if (recent.length === SAMPLE_COUNT && (windowProblems(recent).length === 0 || waitedMs >= OBSERVE_DEADLINE_MS)) {
      return { recent, waitedMs };
    }
    await page.waitForTimeout(SAMPLE_INTERVAL_MS);
  }
}

/** Runs in the renderer (serialized by page.evaluate — no outer references). */
function measureLayout(): Sample {
  const at = performance.now();
  const page: Extent = {
    id: 'page',
    width: document.body.scrollWidth,
    height: document.body.scrollHeight,
    scrollWidth: 0,
    scrollHeight: 0,
    clippedWidth: 0,
    clippedHeight: 0,
  };

  // Rows stretch every slot to the tallest one, so a widget that grows drags
  // its row-mates' boxes with it and the report would blame them too. Measure
  // each slot at its natural height instead: un-stretch, read, restore — all
  // in this one task, so no frame renders the change and no ResizeObserver or
  // IntersectionObserver can see it.
  const slots = [...document.querySelectorAll('[data-widget-id]')].filter(el => el instanceof HTMLElement);
  const alignSelf = slots.map(slot => slot.style.alignSelf);
  for (const slot of slots) slot.style.alignSelf = 'flex-start';

  const extents: Extent[] = slots.map(slot => {
    let clippedWidth = 0;
    let clippedHeight = 0;
    for (const el of slot.querySelectorAll('*')) {
      if (!(el instanceof HTMLElement)) continue;
      const overX = el.scrollWidth - el.clientWidth;
      const overY = el.scrollHeight - el.clientHeight;
      if (overX <= 0 && overY <= 0) continue;
      const style = getComputedStyle(el);
      if (overX > 0 && style.overflowX !== 'visible') clippedWidth += overX;
      if (overY > 0 && style.overflowY !== 'visible') clippedHeight += overY;
    }
    const box = slot.getBoundingClientRect();
    return {
      id: slot.dataset['widgetId'] ?? '(unnamed)',
      width: box.width,
      height: box.height,
      scrollWidth: slot.scrollWidth,
      scrollHeight: slot.scrollHeight,
      clippedWidth,
      clippedHeight,
    };
  });

  slots.forEach((slot, i) => { slot.style.alignSelf = alignSelf[i] ?? ''; });
  extents.push(page);

  // Widgets show CoinRainLoader (an <output> announcing "Loading") or a
  // "Loading …" line while their data is in flight.
  const loading = slots
    .filter(slot => slot.dataset['widgetState'] !== 'mounted' || /\bLoading\b/.test(slot.textContent ?? ''))
    .map(slot => slot.dataset['widgetId'] ?? '(unnamed)');
  return { at, extents, loading };
}

/** Everything that keeps a window from being clean, one line per problem. */
function windowProblems(recent: readonly Sample[]): string[] {
  const problems = new Set<string>();
  for (const [i, sample] of recent.entries()) {
    const ids = new Set(sample.extents.map(e => e.id));
    for (const id of MATRIX_IDS) if (!ids.has(id)) problems.add(`${id}: missing (sample ${String(i)})`);
    for (const id of sample.loading) problems.add(`${id}: still loading`);
  }

  // Rate: the worst over-budget interval per widget metric.
  const worst = new Map<string, { rate: number; line: string }>();
  for (let i = 1; i < recent.length; i++) {
    const prev = recent[i - 1];
    const cur = recent[i];
    if (prev === undefined || cur === undefined) continue;
    const dt = cur.at - prev.at;
    const budget = (MAX_GROWTH_PX_PER_SEC * dt) / 1000;
    const before = new Map(prev.extents.map(e => [e.id, e]));
    for (const e of cur.extents) {
      const p = before.get(e.id);
      if (p === undefined) continue;
      for (const m of METRICS) {
        const growth = e[m] - p[m];
        const key = `${e.id} ${m}`;
        if (growth <= budget || (worst.get(key)?.rate ?? 0) >= growth / dt) continue;
        worst.set(key, {
          rate: growth / dt,
          line: `${e.id}: ${m} +${growth.toFixed(1)}px in ${dt.toFixed(0)}ms (samples ${String(i - 1)}→${String(i)}, budget ${budget.toFixed(1)}px)`,
        });
      }
    }
  }
  for (const { line } of worst.values()) problems.add(line);

  // Net: creep under the rate budget.
  const first = recent[0];
  const last = recent.at(-1);
  if (first !== undefined && last !== undefined) {
    const start = new Map(first.extents.map(e => [e.id, e]));
    for (const e of last.extents) {
      const s = start.get(e.id);
      if (s === undefined) continue;
      for (const m of METRICS) {
        const growth = e[m] - s[m];
        if (growth > MAX_NET_GROWTH_PX && !worst.has(`${e.id} ${m}`)) {
          problems.add(`${e.id}: ${m} crept +${growth.toFixed(1)}px over ${(last.at - first.at).toFixed(0)}ms`);
        }
      }
    }
  }
  return [...problems];
}

/** Each lane within one row gap of its nominal fraction of its type's
 *  full-width lane — the packing in {@link matrixRows} relies on rows summing
 *  to 100%, and a row that doesn't silently stretches its lanes. */
function laneWidthProblems(sample: Sample | undefined): string[] {
  if (sample === undefined) return ['no sample'];
  const width = new Map(sample.extents.map(e => [e.id, e.width]));
  const problems: string[] = [];
  for (const t of WIDGET_TYPES) {
    const full = width.get(matrixWidget(t, 'full').id);
    if (full === undefined) continue;
    for (const s of SIZES) {
      const { id } = matrixWidget(t, s);
      const actual = width.get(id);
      const nominal = full * LANE_FRACTION[s];
      if (actual !== undefined && Math.abs(actual - nominal) > LANE_GAP_PX) {
        problems.push(`${id}: ${actual.toFixed(0)}px wide, nominal ${nominal.toFixed(0)}px`);
      }
    }
  }
  return problems;
}

/** The dashboard's rows. A slot flex-grows to fill its row, so a lane only
 *  renders at its nominal width when its row sums to 100% — a lone `small`
 *  would silently render full-width. Hence: each `full` alone, each `large`
 *  beside its type's `small`, and the mediums in pairs. An odd number of
 *  types would leave one medium alone and stretched; laneWidthProblems
 *  reports it. */
function matrixRows(): MatrixWidget[][] {
  const rows: MatrixWidget[][] = [];
  for (const t of WIDGET_TYPES) {
    rows.push([matrixWidget(t, 'full')], [matrixWidget(t, 'large'), matrixWidget(t, 'small')]);
  }
  const mediums = WIDGET_TYPES.map(t => matrixWidget(t, 'medium'));
  for (let i = 0; i < mediums.length; i += 2) rows.push(mediums.slice(i, i + 2));
  return rows;
}

/** The smallest valid spec per type (see views-validator.ts). Tables keep the
 *  default column set — the heaviest realistic table (resource-level rows). */
function widgetSpec({ id, type, size }: MatrixWidget): Record<string, unknown> {
  const base = { id, type, size };
  switch (type) {
    case 'summary': return { ...base, metric: 'total' };
    case 'table':
    case 'baseline':
    case 'burndown': return base;
    case 'line':
    case 'topNBar':
    case 'heatmap': return { ...base, groupBy: 'service', topN: 10 };
    default: return { ...base, groupBy: 'service' };
  }
}

function buildWidgetMatrixYaml(): string {
  return stringify({
    views: [
      // Keep the seed Cost Overview so the app boots into a working state.
      // It's also built-in so it can't be deleted by the test.
      {
        id: 'overview',
        name: 'Cost Overview',
        builtIn: true,
        rows: [{ widgets: [{ id: 'ov-sum', type: 'summary', size: 'small', metric: 'total' }] }],
      },
      { id: VIEW_NAME, name: VIEW_NAME, rows: matrixRows().map(row => ({ widgets: row.map(widgetSpec) })) },
    ],
  });
}
