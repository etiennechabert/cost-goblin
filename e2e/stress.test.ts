import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  FIXTURE_CONFIG_DIR,
  LOAD_TIMEOUT,
  clickNavButton,
  launchAppWithCoverage,
  finishCoverage,
  waitForQuerySettle,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Widget growth regression — every widget × every size stays bounded
// ---------------------------------------------------------------------------
//
// Hunts runaway layout growth (a ResizeObserver feeding its own measurement
// back into the size it observes, a flex item chasing its content, …) across
// every widget type at every lane width, all on ONE dashboard so the whole
// matrix shares a single navigation, settle and observation window.

const WIDGET_TYPES = ['summary', 'pie', 'stackedBar', 'line', 'topNBar', 'treemap', 'heatmap', 'bubble', 'table'] as const;
const SIZES = ['small', 'medium', 'large', 'full'] as const;
type WidgetType = (typeof WIDGET_TYPES)[number];
type Size = (typeof SIZES)[number];

const VIEW_NAME = 'widget-matrix';

interface MatrixWidget {
  readonly id: string;
  readonly type: WidgetType;
  readonly size: Size;
}
const matrixWidget = (type: WidgetType, size: Size): MatrixWidget => ({ id: `w-${type}-${size}`, type, size });
/** Tops up the one medium lane left over when the matrix is packed (see
 *  {@link matrixRows}). Measured like every other widget. */
const PAD: MatrixWidget = { id: 'pad-summary-medium', type: 'summary', size: 'medium' };
const MATRIX_IDS: readonly string[] = WIDGET_TYPES.flatMap(t => SIZES.map(s => matrixWidget(t, s).id));

// Settle: after every widget has data, wait for QUIET_MS of unchanged layout
// before sampling. Short CSS transitions on data arrival (bar widths animate
// for 0.2s) finish well inside it. A runaway grower is never quiet, so the
// wait is capped — the cap is spent only on a failing run, and sampling
// then names the offender rather than the settle timing out anonymously.
const SETTLE_POLL_MS = 100;
const QUIET_MS = 500;
const SETTLE_CAP_MS = 5_000;

// Observation window: 10 samples 250ms apart (2.25s). Each inter-sample
// delta is checked against a growth budget proportional to the time that
// actually elapsed between the two samples (timers stretch under CI load, and
// a feedback loop grows per rendered frame, i.e. per unit of time).
//
// 32 px/s keeps the old suite's sensitivity (20px per 600ms ≈ 33 px/s) and
// works out to 8px per nominal 250ms interval. Both sides have wide margin:
//  - a settled layout is deterministic — repeated measurements are identical,
//    so an honest widget's delta is 0 (sub-pixel rounding is < 1px);
//  - a ResizeObserver loop re-fires every frame it changes the size it
//    watches, so even a 1px-per-frame creep at 60fps is 60 px/s (15px per
//    interval, ~2× the budget); real loops step by a padding or border width
//    per frame and blow through it by orders of magnitude.
const SAMPLE_COUNT = 10;
const SAMPLE_INTERVAL_MS = 250;
const MAX_GROWTH_PX_PER_SEC = 32;

/** What one sample records per widget slot (plus a `page` entry for the
 *  document, the old suite's only signal). */
interface Extent {
  readonly id: string;
  /** The slot's border box: its lane's width, and its natural (un-stretched)
   *  height. */
  readonly width: number;
  readonly height: number;
  /** The slot's scrollable overflow: content spilling out of the lane. */
  readonly scrollWidth: number;
  readonly scrollHeight: number;
  /** Overflow clipped inside descendant scroll/clip containers (a table's
   *  scroll body, a truncated label). Growth there never moves the slot's
   *  box or the document, so it is summed separately. */
  readonly clippedWidth: number;
  readonly clippedHeight: number;
}

const METRICS = ['width', 'height', 'scrollWidth', 'scrollHeight', 'clippedWidth', 'clippedHeight'] as const;

interface Sample {
  readonly at: number;
  readonly extents: readonly Extent[];
}

interface Observation {
  readonly quietAfterMs: number | null;
  readonly samples: readonly Sample[];
}

test.describe('Widget growth', () => {
  const TEMP_CONFIG_DIR = join(tmpdir(), `costgoblin-widget-growth-${String(Date.now())}`);

  let widgetApp: ElectronApplication;
  let widgetPage: Page;

  test.beforeAll(async () => {
    mkdirSync(TEMP_CONFIG_DIR, { recursive: true });
    for (const f of ['costgoblin.yaml', 'dimensions.yaml', 'org-tree.yaml']) {
      const src = join(FIXTURE_CONFIG_DIR, f);
      if (existsSync(src)) writeFileSync(join(TEMP_CONFIG_DIR, f), readFileSync(src));
    }
    writeFileSync(join(TEMP_CONFIG_DIR, 'views.yaml'), buildWidgetMatrixYaml());

    ({ app: widgetApp, page: widgetPage } = await launchAppWithCoverage({ configDir: TEMP_CONFIG_DIR }));
    await widgetPage.setViewportSize({ width: 1400, height: 900 });
  });

  test.afterAll(async () => {
    await finishCoverage(widgetApp, widgetPage, 'stress');
  });

  test('every widget type stays bounded at every size', async () => {
    const page = widgetPage;
    await clickNavButton(page, VIEW_NAME);
    await waitForQuerySettle(page);

    await expect.poll(async () => {
      const ids = new Set(await page.locator('[data-widget-id]').evaluateAll(els => els.map(el => el.getAttribute('data-widget-id'))));
      return MATRIX_IDS.filter(id => !ids.has(id));
    }, { message: 'every matrix widget is on the dashboard' }).toEqual([]);

    // Slots mount lazily — only once scrolled near the viewport — so walk
    // each one into view; the scheduler then mounts them in order. Re-walk
    // whatever is still deferred, in case an observer entry was missed.
    const deferred = page.locator('[data-widget-id][data-widget-state="deferred"]');
    await expect(async () => {
      await requestMounts(page);
      await expect(deferred, 'every widget slot mounts').toHaveCount(0, { timeout: 3_000 });
    }).toPass({ timeout: 20_000 });
    // CoinRainLoader is an <output> announcing "Loading"; its coins move
    // inside a clip box, so no sampling until every widget has its data.
    await expect(page.locator('[data-widget-id] output', { hasText: 'Loading' }), 'every widget finishes loading')
      .toHaveCount(0, { timeout: LOAD_TIMEOUT * 2 });

    const observation = await observe(page);
    test.info().annotations.push({
      type: 'settle',
      description: observation.quietAfterMs === null
        ? `layout never went quiet within ${String(SETTLE_CAP_MS)}ms`
        : `layout quiet after ${String(Math.round(observation.quietAfterMs))}ms`,
    });

    const sampled = new Set(observation.samples[0]?.extents.map(e => e.id));
    expect(MATRIX_IDS.filter(id => !sampled.has(id)), 'every widget was measured').toEqual([]);
    expect(findGrowth(observation.samples), 'widgets that grew during the observation window').toEqual([]);
  });
});

/** Scroll every still-deferred slot through the IntersectionObserver window
 *  so it asks the scheduler for a mount (the request is sticky; the mount then
 *  waits for its turn). Two frames per stop let the observer deliver. */
async function requestMounts(page: Page): Promise<void> {
  await page.evaluate(async () => {
    // Matches DEFAULT_ROOT_MARGIN in widget-load-scheduler.tsx; anything
    // already inside it at the current stop has been observed and is skipped.
    const ROOT_MARGIN = 400;
    const frame = (): Promise<void> => new Promise(resolve => { requestAnimationFrame(() => { resolve(); }); });
    for (const el of document.querySelectorAll('[data-widget-id][data-widget-state="deferred"]')) {
      const r = el.getBoundingClientRect();
      if (r.bottom >= -ROOT_MARGIN && r.top <= window.innerHeight + ROOT_MARGIN) continue;
      el.scrollIntoView({ block: 'start' });
      await frame();
      await frame();
    }
    window.scrollTo(0, 0);
  });
}

/** Settle, then sample — both in-page so the timings are the renderer's own
 *  clock, not CDP round-trips. */
async function observe(page: Page): Promise<Observation> {
  return page.evaluate(async (cfg) => {
    const sleep = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms); });

    function measure(): Extent[] {
      // The old suite's only signal, kept as a backstop for growth outside
      // any slot. Read before the slots are un-stretched below.
      const page: Extent = {
        id: 'page',
        width: document.body.scrollWidth,
        height: document.body.scrollHeight,
        scrollWidth: 0,
        scrollHeight: 0,
        clippedWidth: 0,
        clippedHeight: 0,
      };

      // Rows stretch every slot to the tallest one, so a widget that grows
      // drags its row-mates' boxes with it and the report would blame them
      // too. Measure each slot at its natural height instead: un-stretch,
      // read, restore — all in this one task, so no frame renders the
      // change and no ResizeObserver or IntersectionObserver can see it.
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
      return extents;
    }

    function sameLayout(a: readonly Extent[], b: readonly Extent[]): boolean {
      if (a.length !== b.length) return false;
      return a.every((x, i) => {
        const y = b[i];
        return y !== undefined && x.id === y.id && cfg.metrics.every(m => Math.abs(x[m] - y[m]) < 0.5);
      });
    }

    const start = performance.now();
    let quietSince = start;
    let quietAfterMs: number | null = null;
    let last = measure();
    while (performance.now() - start < cfg.settleCapMs) {
      await sleep(cfg.settlePollMs);
      const now = measure();
      const t = performance.now();
      if (!sameLayout(last, now)) quietSince = t;
      last = now;
      if (t - quietSince >= cfg.quietMs) {
        quietAfterMs = t - start;
        break;
      }
    }

    const samples: Sample[] = [];
    for (let i = 0; i < cfg.sampleCount; i++) {
      if (i > 0) await sleep(cfg.sampleIntervalMs);
      samples.push({ at: performance.now(), extents: measure() });
    }
    return { quietAfterMs, samples };
  }, {
    settlePollMs: SETTLE_POLL_MS,
    quietMs: QUIET_MS,
    settleCapMs: SETTLE_CAP_MS,
    sampleCount: SAMPLE_COUNT,
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    metrics: METRICS,
  });
}

/** One line per widget that grew faster than the budget in any interval,
 *  listing each offending metric at its worst interval. */
function findGrowth(samples: readonly Sample[]): string[] {
  interface Growth { readonly growth: number; readonly budget: number; readonly dt: number; readonly interval: number }
  const worst = new Map<string, Map<string, Growth>>();
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const cur = samples[i];
    if (prev === undefined || cur === undefined) continue;
    const dt = cur.at - prev.at;
    const budget = (MAX_GROWTH_PX_PER_SEC * dt) / 1000;
    const before = new Map(prev.extents.map(e => [e.id, e]));
    for (const e of cur.extents) {
      const p = before.get(e.id);
      if (p === undefined) continue;
      for (const m of METRICS) {
        const growth = e[m] - p[m];
        if (growth <= budget) continue;
        const byMetric = worst.get(e.id) ?? new Map<string, Growth>();
        worst.set(e.id, byMetric);
        const seen = byMetric.get(m);
        if (seen === undefined || growth / budget > seen.growth / seen.budget) {
          byMetric.set(m, { growth, budget, dt, interval: i });
        }
      }
    }
  }
  return [...worst].map(([id, byMetric]) => {
    const details = [...byMetric].map(([m, w]) =>
      `${m} +${w.growth.toFixed(1)}px in ${w.dt.toFixed(0)}ms (samples ${String(w.interval - 1)}→${String(w.interval)}, budget ${w.budget.toFixed(1)}px)`);
    return `${id}: ${details.join('; ')}`;
  });
}

/** The dashboard's rows. A slot flex-grows to fill its row, so a lane only
 *  renders at its nominal width (25/50/75/100%) when its row sums to 100% —
 *  a lone `small` would silently render full-width. Hence: each `full` alone,
 *  each `large` beside its type's `small`, and the mediums in pairs. Nine
 *  mediums leave one over, topped up by {@link PAD}. */
function matrixRows(): MatrixWidget[][] {
  const rows: MatrixWidget[][] = [];
  for (const t of WIDGET_TYPES) {
    rows.push([matrixWidget(t, 'full')], [matrixWidget(t, 'large'), matrixWidget(t, 'small')]);
  }
  const mediums = WIDGET_TYPES.map(t => matrixWidget(t, 'medium'));
  for (let i = 0; i < mediums.length; i += 2) {
    rows.push(mediums.slice(i, i + 2));
  }
  const lastRow = rows.at(-1);
  if (lastRow !== undefined && lastRow.length === 1) lastRow.push(PAD);
  return rows;
}

function widgetYaml({ id, type, size }: MatrixWidget): string {
  const head = `          - id: ${id}\n            type: ${type}\n            size: ${size}`;
  if (type === 'summary') return `${head}\n            metric: total`;
  const topN = type === 'topNBar' || type === 'line' || type === 'heatmap' || type === 'table' ? '\n            topN: 10' : '';
  const columns = type === 'table' ? '\n            columns: [entity, service, cost, percentage]' : '';
  return `${head}\n            groupBy: service${topN}${columns}`;
}

function buildWidgetMatrixYaml(): string {
  const rows = matrixRows().map(row => `      - widgets:\n${row.map(widgetYaml).join('\n')}`);
  // Keep the seed Cost Overview so the app boots into a working state. It's
  // also built-in so it can't be deleted by the test.
  return `views:
  - id: overview
    name: Cost Overview
    builtIn: true
    rows:
      - widgets:
          - id: ov-sum
            type: summary
            size: small
            metric: total
  - id: ${VIEW_NAME}
    name: ${VIEW_NAME}
    rows:
${rows.join('\n')}
`;
}
