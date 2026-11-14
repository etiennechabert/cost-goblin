/**
 * DIAGNOSTIC, not a test suite — measures what one main-thread frame costs on
 * the default dashboard, on the synthetic fixtures.
 *
 * Chromium re-runs layerization (`PaintArtifactCompositor::Update`, shown as
 * "Layerize" in a DevTools trace) on every frame that moves or restructures
 * something, and its cost grows with the page, not with the change. So the
 * diagnostic opens the seeded Cost Overview, moves one small element with
 * `left`/`top` on every animation frame for a few seconds, records a Chromium
 * trace over CDP, and prints the renderer main thread's events by self time
 * plus the Layerize cost per frame. jsdom shows none of this.
 *
 * The fixtures bill 15 services a day in 8 accounts and 6 regions, a real
 * organisation hundreds of services and accounts, and the dashboard draws one
 * bar segment per service and day. To get a page of a real size (about 9,000
 * DOM nodes, every pie legend long enough to scroll), the diagnostic runs on
 * a throwaway copy of the fixture tree in which every row is repeated under
 * more service, account and region names, each copy cheaper than the last,
 * the way a real bill tails off.
 *
 * It then repeats the measurement with the pointer moving over the histogram
 * for as long (what a user does), and with parts of the page taken out (each widget hidden
 * in turn), which is how to find what a regression came from. The census it
 * prints first counts, per widget, the elements that are a compositing group
 * of their own (opacity, filter, transform…): layerization's cost follows
 * that count times the number of layers painted before them.
 *
 * Excluded from `npx playwright test` (playwright.config.ts testMatch); run
 * explicitly, on a built app (`npm run build --workspace=packages/desktop`):
 *   npx playwright test --config playwright.diag.config.ts e2e/diag/layerize.diag.ts
 *
 * Knobs (all optional):
 *   COSTGOBLIN_DIAG_SERVICES   names per fixture service, default 17 (255 a day)
 *   COSTGOBLIN_DIAG_TAIL       copy n costs 1/n^TAIL of the original, default 1
 *   COSTGOBLIN_DIAG_PRESET     date preset to pick, e.g. "Last 90 days"; the
 *                              default is the range the app opens on (30 days)
 *   COSTGOBLIN_DIAG_SECONDS    seconds each measurement runs, default 3
 *   COSTGOBLIN_DIAG_CSS        extra CSS variants, separated by ";;", each
 *                              measured both ways and with nothing else
 *                              moving, which is what a CSS animation costs
 *                              by itself, e.g.
 *                              '[data-widget-id] * { opacity: 1 !important }'
 *                              'button[aria-label="Data sync"] svg { animation: sync-blink 2s ease-in-out infinite }'
 *   COSTGOBLIN_DIAG_SCREENSHOT a directory: writes dashboard.png there, and
 *                              histogram-focused.png with one series focused
 *   COSTGOBLIN_DIAG_BISECT=0   skip the per-widget variants
 */
import { test, expect, type CDPSession, type ElectronApplication, type Page } from '@playwright/test';
import { DuckDBInstance } from '@duckdb/node-api';
import { join } from 'node:path';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { FIXTURE_PROVIDER_NAME } from '../../packages/core/src/__fixtures__/layout.js';
import { setup } from '../../packages/core/src/__fixtures__/setup.js';
import { sqlStringLiteral } from '../../packages/core/src/query/sql-escape.js';
import { closeApp, copyOfConfigDir, FIXTURE_DATA_DIR, launchApp, selectDatePreset, waitForQuerySettle } from '../helpers.js';

/** A numeric knob: `fallback` when unset, and an error naming the variable
 *  when set to anything but a number of at least `min`. Two of them end up in
 *  SQL text. */
function numberKnob(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) throw new Error(`${name} must be a number of at least ${String(min)}, got "${raw}"`);
  return value;
}

const SERVICES = Math.floor(numberKnob('COSTGOBLIN_DIAG_SERVICES', 17, 1));
const TAIL = numberKnob('COSTGOBLIN_DIAG_TAIL', 1, 0);
const PRESET = process.env['COSTGOBLIN_DIAG_PRESET'];
const SECONDS = numberKnob('COSTGOBLIN_DIAG_SECONDS', 3, 0.5);
const EXTRA_CSS = (process.env['COSTGOBLIN_DIAG_CSS'] ?? '').split(';;').map(css => css.trim()).filter(css => css.length > 0);
const SCREENSHOT_DIR = process.env['COSTGOBLIN_DIAG_SCREENSHOT'];
const BISECT = process.env['COSTGOBLIN_DIAG_BISECT'] !== '0';

/** Trace categories: `devtools.timeline` has the frame phases DevTools shows
 *  (Layerize, Paint, PrePaint, Layout…), `blink` and `cc` what runs under
 *  them, and the disabled-by-default one the main thread's tasks (RunTask). */
const CATEGORIES = 'devtools.timeline,disabled-by-default-devtools.timeline,blink,cc';
const HISTOGRAM = '[data-widget-id="overview-histogram"]';

// ---------------------------------------------------------------------------
// Fixture data of a real size
// ---------------------------------------------------------------------------

/** A copy of the synthetic tree whose AWS daily months bill `factor` names per
 *  service, account and region: the original rows plus `factor - 1` copies of
 *  them named "<service> <n>" in account "<account> <n>" and region
 *  "<region>-<n>", copy n costing 1/n^tail of the original. */
async function dataDirWithServices(factor: number, tail: number): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'cg-layerize-data-'));
  try {
    cpSync(FIXTURE_DATA_DIR, dir, { recursive: true });
    const providerDir = join(dir, FIXTURE_PROVIDER_NAME);
    // A rollup left in the fixture tree (by `npm run dev:fixtures`) describes
    // the data as it was.
    rmSync(join(providerDir, 'rollup'), { recursive: true, force: true });
    if (factor > 1) await repeatRows(join(providerDir, 'raw'), factor, tail);
    return dir;
  } catch (err) {
    // Nothing else knows the directory yet.
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

async function repeatRows(rawDir: string, factor: number, tail: number): Promise<void> {
  const db = await DuckDBInstance.create();
  const conn = await db.connect();
  try {
    const weight = `pow(i + 1, ${String(tail)})`;
    for (const entry of readdirSync(rawDir)) {
      if (!entry.startsWith('daily-')) continue;
      const file = join(rawDir, entry, 'data.parquet');
      const out = `${file}.tmp`;
      await conn.run(`
        COPY (
          SELECT f.* REPLACE (
            CASE WHEN i = 0 OR coalesce(ServiceName, '') = '' THEN ServiceName ELSE ServiceName || ' ' || (i + 1)::VARCHAR END AS ServiceName,
            CASE WHEN i = 0 THEN SubAccountId ELSE SubAccountId || '-' || (i + 1)::VARCHAR END AS SubAccountId,
            CASE WHEN i = 0 THEN SubAccountName ELSE SubAccountName || ' ' || (i + 1)::VARCHAR END AS SubAccountName,
            CASE WHEN i = 0 THEN RegionId ELSE RegionId || '-' || (i + 1)::VARCHAR END AS RegionId,
            CASE WHEN i = 0 THEN RegionName ELSE RegionName || ' ' || (i + 1)::VARCHAR END AS RegionName,
            BilledCost / ${weight} AS BilledCost,
            EffectiveCost / ${weight} AS EffectiveCost,
            ListCost / ${weight} AS ListCost,
            ContractedCost / ${weight} AS ContractedCost
          )
          FROM read_parquet(${sqlStringLiteral(file)}) f, range(${String(factor)}) t(i)
        ) TO ${sqlStringLiteral(out)} (FORMAT PARQUET)`);
      renameSync(out, file);
    }
  } finally {
    conn.disconnectSync();
    db.closeSync();
  }
}

// ---------------------------------------------------------------------------
// Trace
// ---------------------------------------------------------------------------

interface TraceEvent {
  readonly name: string;
  readonly ph: string;
  readonly pid: number;
  readonly tid: number;
  readonly ts: number;
  readonly dur?: number;
  readonly args?: { readonly name?: string };
}

function isTraceEvent(value: unknown): value is TraceEvent {
  if (typeof value !== 'object' || value === null) return false;
  return 'name' in value && 'ph' in value && 'pid' in value && 'tid' in value;
}

async function recordTrace(cdp: CDPSession, during: () => Promise<void>): Promise<TraceEvent[]> {
  const events: TraceEvent[] = [];
  const onData = (payload: { value: unknown[] }): void => {
    for (const event of payload.value) if (isTraceEvent(event)) events.push(event);
  };
  cdp.on('Tracing.dataCollected', onData);
  await cdp.send('Tracing.start', { categories: CATEGORIES, transferMode: 'ReportEvents' });
  try {
    await during();
  } finally {
    const complete = new Promise<void>(resolve => { cdp.once('Tracing.tracingComplete', () => { resolve(); }); });
    await cdp.send('Tracing.end');
    await complete;
    cdp.off('Tracing.dataCollected', onData);
  }
  return events;
}

interface EventStat {
  readonly name: string;
  count: number;
  totalMs: number;
  selfMs: number;
}

interface MainThreadStats {
  readonly byName: Map<string, EventStat>;
  /** Duration of each occurrence, per event name. */
  readonly durations: Map<string, number[]>;
}

/** Totals for the busiest `CrRendererMain` thread: the window's renderer.
 *  Self time is an event's duration minus its direct children's, from the
 *  nesting of complete ("X") events. */
function mainThreadStats(events: readonly TraceEvent[]): MainThreadStats {
  const mainThreads = new Set(
    events
      .filter(e => e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain')
      .map(e => `${String(e.pid)}:${String(e.tid)}`),
  );
  const perThread = new Map<string, TraceEvent[]>();
  for (const e of events) {
    if (e.ph !== 'X' || e.dur === undefined) continue;
    const key = `${String(e.pid)}:${String(e.tid)}`;
    if (!mainThreads.has(key)) continue;
    const list = perThread.get(key) ?? [];
    list.push(e);
    perThread.set(key, list);
  }
  let busiest: TraceEvent[] = [];
  let busiestTotal = -1;
  for (const list of perThread.values()) {
    const total = list.reduce((sum, e) => sum + (e.dur ?? 0), 0);
    if (total > busiestTotal) {
      busiest = list;
      busiestTotal = total;
    }
  }

  const sorted = [...busiest].sort((a, b) => a.ts - b.ts || (b.dur ?? 0) - (a.dur ?? 0));
  const byName = new Map<string, EventStat>();
  const durations = new Map<string, number[]>();
  const stack: { end: number; stat: EventStat }[] = [];
  for (const e of sorted) {
    const dur = e.dur ?? 0;
    while (stack.length > 0 && (stack[stack.length - 1]?.end ?? 0) <= e.ts) stack.pop();
    const stat = byName.get(e.name) ?? { name: e.name, count: 0, totalMs: 0, selfMs: 0 };
    byName.set(e.name, stat);
    stat.count += 1;
    stat.totalMs += dur / 1000;
    stat.selfMs += dur / 1000;
    const parent = stack[stack.length - 1];
    if (parent !== undefined) parent.stat.selfMs -= dur / 1000;
    stack.push({ end: e.ts + dur, stat });
    const list = durations.get(e.name) ?? [];
    list.push(dur / 1000);
    durations.set(e.name, list);
  }
  return { byName, durations };
}

interface PhaseSummary {
  readonly count: number;
  readonly totalMs: number;
  readonly meanMs: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly maxMs: number;
}

function summarize(stats: MainThreadStats, name: string): PhaseSummary {
  const values = [...(stats.durations.get(name) ?? [])].sort((a, b) => a - b);
  const total = values.reduce((sum, v) => sum + v, 0);
  const at = (p: number): number => values[Math.min(values.length - 1, Math.floor(values.length * p))] ?? 0;
  return {
    count: values.length,
    totalMs: total,
    meanMs: values.length === 0 ? 0 : total / values.length,
    medianMs: at(0.5),
    p95Ms: at(0.95),
    maxMs: values[values.length - 1] ?? 0,
  };
}

function fmt(ms: number): string {
  return ms.toFixed(2).padStart(7);
}

// ---------------------------------------------------------------------------
// Page side
// ---------------------------------------------------------------------------

/** Move one small element with `left`/`top` on every animation frame, the way
 *  a JS-driven animation or a pointer-following tooltip does. Resolves with
 *  the number of frames it ran. The element sits in the page's content box,
 *  outside every widget, so it changes nothing but its own position. */
function runMover(seconds: number): Promise<number> {
  return new Promise(resolve => {
    const host = document.querySelector('[data-widget-id]')?.parentElement?.parentElement ?? document.body;
    const dot = document.createElement('div');
    dot.setAttribute('data-diag-mover', '');
    dot.style.cssText = 'position:absolute;width:6px;height:6px;left:0;top:0;background:#f0f;pointer-events:none;z-index:1';
    const previousPosition = host.style.position;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.appendChild(dot);
    const started = performance.now();
    let frames = 0;
    const tick = (now: number): void => {
      frames += 1;
      const t = (now - started) / 1000;
      dot.style.left = `${String(20 + Math.round(Math.abs(Math.sin(t * 2)) * 200))}px`;
      dot.style.top = `${String(20 + Math.round(Math.abs(Math.cos(t * 3)) * 60))}px`;
      if (t < seconds) {
        requestAnimationFrame(tick);
        return;
      }
      dot.remove();
      host.style.position = previousPosition;
      resolve(frames);
    };
    requestAnimationFrame(tick);
  });
}

/** At most one pointer move every POINTER_INTERVAL_MS: the pace of a mouse. */
const POINTER_INTERVAL_MS = 16;

/** Move the pointer over an element for `seconds`: across and back, while
 *  going up and down its lower half, so it keeps entering other bars and
 *  other series. Where the pointer is depends on the clock alone, and each
 *  move waits for the page to take the one before, as a real mouse's moves
 *  are coalesced: a page that lags gets fewer moves in the same time, never a
 *  longer sweep. Resolves with the number of moves. */
async function sweepPointer(page: Page, selector: string, seconds: number): Promise<number> {
  const box = await page.locator(selector).first().boundingBox();
  if (box === null) throw new Error(`sweepPointer: ${selector} has no box`);
  const wave = (t: number, periodMs: number): number => {
    const phase = (t % periodMs) / periodMs;
    return phase < 0.5 ? phase * 2 : 2 - phase * 2;
  };
  const started = Date.now();
  let moves = 0;
  for (;;) {
    const wait = started + moves * POINTER_INTERVAL_MS - Date.now();
    if (wait > 0) await page.waitForTimeout(wait);
    const t = Date.now() - started;
    if (t >= seconds * 1000) break;
    const x = box.x + 4 + wave(t, 4_000) * (box.width - 8);
    const y = box.y + box.height * (0.5 + 0.48 * wave(t, 550));
    await page.mouse.move(x, y);
    moves += 1;
  }
  // Leave the page as it was: no hover, no tooltip.
  await page.mouse.move(2, 2);
  return moves;
}

interface Census {
  readonly nodes: number;
  /** Per widget: its node count and how many of its elements carry a property
   *  that gives them their own paint property node (and so their own paint
   *  chunk) — the input layerization scales with. */
  readonly widgets: Record<string, Record<string, number>>;
}

function census(): Census {
  const widgets: Record<string, Record<string, number>> = {};
  const bump = (widget: string, key: string): void => {
    const row = widgets[widget] ?? {};
    row[key] = (row[key] ?? 0) + 1;
    widgets[widget] = row;
  };
  const all = document.querySelectorAll('*');
  for (const el of all) {
    const widget = el.closest('[data-widget-id]')?.getAttribute('data-widget-id') ?? '(page)';
    bump(widget, 'nodes');
    const s = getComputedStyle(el);
    if (s.opacity !== '1') bump(widget, 'opacity');
    if (s.transform !== 'none' || s.translate !== 'none' || s.rotate !== 'none' || s.scale !== 'none') bump(widget, 'transform');
    if (s.filter !== 'none') bump(widget, 'filter');
    if (s.backdropFilter !== 'none') bump(widget, 'backdrop');
    if (s.overflowX !== 'visible' || s.overflowY !== 'visible') bump(widget, 'overflow');
    if (s.willChange !== 'auto') bump(widget, 'will-change');
    if (s.position === 'sticky' || s.position === 'fixed') bump(widget, 'sticky/fixed');
    if (s.clipPath !== 'none' || s.maskImage !== 'none') bump(widget, 'clip/mask');
    if (s.mixBlendMode !== 'normal' || s.isolation !== 'auto') bump(widget, 'blend');
    if (s.transitionDuration.split(',').some(d => d.trim() !== '0s')) bump(widget, 'transition');
  }
  return { nodes: all.length, widgets };
}

/** cc layers the compositor holds for the page, from the LayerTree domain.
 *  -1 when the tree doesn't arrive. */
async function layerCount(page: Page, cdp: CDPSession): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onChange: ((payload: { layers?: unknown[] }) => void) | undefined;
  const count = new Promise<number>(resolve => {
    onChange = payload => { resolve(payload.layers?.length ?? 0); };
    cdp.once('LayerTree.layerTreeDidChange', onChange);
    timer = setTimeout(() => { resolve(-1); }, 3_000);
  });
  try {
    await cdp.send('LayerTree.enable');
    // The tree is sent with a frame: ask for one.
    await page.evaluate(() => new Promise(resolve => { requestAnimationFrame(() => { requestAnimationFrame(resolve); }); }));
    return await count;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onChange !== undefined) cdp.off('LayerTree.layerTreeDidChange', onChange);
    await cdp.send('LayerTree.disable');
  }
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

interface Measurement {
  readonly label: string;
  readonly nodes: number;
  readonly layers: number;
  /** DevTools' "Layerize": the whole push of the paint artifact to cc. */
  readonly layerize: PhaseSummary;
  /** Full layerizations among them (the others only repaint layers). */
  readonly fullUpdate: PhaseSummary;
  /** The main thread's tasks: how busy it was, and its longest stall. */
  readonly tasks: PhaseSummary;
  /** Pointer moves the page took, for a stimulus that moves the pointer. */
  readonly moves: number | undefined;
  readonly stats: MainThreadStats;
}

/** What a measurement drives the page with. It may resolve with the number
 *  of pointer moves it got through. */
type Stimulus = () => Promise<number | undefined>;

async function measure(page: Page, cdp: CDPSession, label: string, stimulus: Stimulus): Promise<Measurement> {
  // Let the previous variant's style change paint before the trace starts.
  await page.waitForTimeout(300);
  let moves: number | undefined;
  const events = await recordTrace(cdp, async () => { moves = await stimulus(); });
  const stats = mainThreadStats(events);
  const nodes = await page.evaluate(() => document.querySelectorAll('*').length);
  const layers = await layerCount(page, cdp);
  return {
    label,
    nodes,
    layers,
    layerize: summarize(stats, 'Layerize'),
    fullUpdate: summarize(stats, 'PaintArtifactCompositor::Update'),
    tasks: summarize(stats, 'RunTask'),
    moves,
    stats,
  };
}

function printTopEvents(m: Measurement, top: number): void {
  const frames = Math.max(1, m.layerize.count);
  const rows = [...m.stats.byName.values()].sort((a, b) => b.selfMs - a.selfMs).slice(0, top);
  console.log(`\n[layerize] ${m.label}: renderer main thread, top ${String(top)} events by self time over ${String(frames)} frames`);
  console.log('   self ms  total ms   count  self/frame  event');
  for (const row of rows) {
    console.log(`  ${fmt(row.selfMs)}  ${fmt(row.totalMs)}  ${String(row.count).padStart(6)}  ${fmt(row.selfMs / frames)}     ${row.name}`);
  }
}

function printSummary(title: string, measurements: readonly Measurement[]): void {
  console.log(`\n[layerize] ${title}`);
  console.log('  Layerize ms per frame          full  main thread ms   pointer');
  console.log('     mean  median     p95  frames  updates     busy  longest    moves   nodes  layers  variant');
  for (const m of measurements) {
    const moves = m.moves === undefined ? '-' : String(m.moves);
    console.log(`  ${fmt(m.layerize.meanMs)} ${fmt(m.layerize.medianMs)} ${fmt(m.layerize.p95Ms)}  ${String(m.layerize.count).padStart(6)}  ${String(m.fullUpdate.count).padStart(7)}  ${fmt(m.tasks.totalMs)}  ${fmt(m.tasks.maxMs)}  ${moves.padStart(7)}  ${String(m.nodes).padStart(6)}  ${String(m.layers).padStart(6)}  ${m.label}`);
  }
}

function printCensus(c: Census): void {
  console.log(`\n[layerize] ${String(c.nodes)} DOM nodes. Elements with their own paint property node, per widget:`);
  for (const [widget, row] of Object.entries(c.widgets)) {
    const parts = Object.entries(row).map(([key, n]) => `${key}=${String(n)}`).join(' ');
    console.log(`  ${widget.padEnd(24)} ${parts}`);
  }
}

// ---------------------------------------------------------------------------
// Diagnostic
// ---------------------------------------------------------------------------

let app: ElectronApplication | undefined;
let configDir = '';
let dataDir = '';

test.beforeAll(async () => {
  // The diag config has no globalSetup: build the synthetic tree if missing.
  await setup();
  // Without views.yaml the launch seeds the built-in dashboards: the Cost
  // Overview a new workspace opens on.
  configDir = copyOfConfigDir(['views.yaml']);
  dataDir = await dataDirWithServices(SERVICES, TAIL);
  app = await launchApp({ configDir, dataDir });
});

test.afterAll(async () => {
  await closeApp(app);
  for (const dir of [configDir, dataDir]) {
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  }
});

test('Layerize cost per frame on the default dashboard', async () => {
  if (app === undefined) throw new Error('app did not launch');
  const page = await app.firstWindow({ timeout: 60_000 });
  await expect(page).toHaveTitle('CostGoblin');
  await expect(page.getByRole('heading', { name: 'Cost Overview' })).toBeVisible({ timeout: 30_000 });
  await waitForQuerySettle(page);
  if (PRESET !== undefined) {
    await selectDatePreset(page, PRESET);
    await waitForQuerySettle(page);
  }
  // The table sits under the fold: bring every slot in, then go back up.
  const widgetIds = await page.evaluate(async () => {
    const slots = [...document.querySelectorAll('[data-widget-id]')];
    for (const slot of slots) {
      slot.scrollIntoView({ block: 'center' });
      await new Promise(resolve => { setTimeout(resolve, 150); });
    }
    slots[0]?.scrollIntoView({ block: 'center' });
    return slots.map(slot => slot.getAttribute('data-widget-id') ?? '');
  });
  await waitForQuerySettle(page);
  await page.evaluate(() => { window.scrollTo(0, 0); });

  const cdp = await page.context().newCDPSession(page);
  printCensus(await page.evaluate(census));

  if (SCREENSHOT_DIR !== undefined) {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'dashboard.png'), fullPage: true });
    // One series focused: the second segment of a bar in the right half, so
    // the tooltip opens on the left. Taken once the fades have ended.
    const bars = page.locator(`${HISTOGRAM} [data-feedback="none"] > .group`);
    await bars.nth(Math.floor(await bars.count() * 0.75)).locator(':scope > div > *').nth(1).hover();
    await page.waitForTimeout(600);
    await page.locator(HISTOGRAM).screenshot({ path: join(SCREENSHOT_DIR, 'histogram-focused.png') });
    await page.mouse.move(2, 2);
    await page.waitForTimeout(400);
  }

  const mover: Stimulus = async () => {
    await page.evaluate(runMover, SECONDS);
    return undefined;
  };

  const baseline = await measure(page, cdp, 'one element moved on every frame', mover);
  printTopEvents(baseline, 20);
  const sweep: Stimulus = () => sweepPointer(page, `${HISTOGRAM} [data-feedback="none"]`, SECONDS);
  const idle: Stimulus = async () => {
    await page.waitForTimeout(SECONDS * 1000);
    return undefined;
  };
  const pointer = await measure(page, cdp, 'pointer moving over the histogram', sweep);
  printTopEvents(pointer, 12);
  const user: Measurement[] = [baseline, pointer];

  // Each variant is the page with one more stylesheet, under the same stimulus.
  const withCss = async (css: string, label: string, stimulus: Stimulus): Promise<Measurement> => {
    const style = await page.addStyleTag({ content: css });
    try {
      return await measure(page, cdp, label, stimulus);
    } finally {
      await style.evaluate(node => node.parentNode?.removeChild(node));
    }
  };
  const variants: Measurement[] = [baseline];
  if (BISECT) {
    // `visibility` rather than `display`: the page keeps its layout, and only
    // what the widget paints goes.
    for (const id of widgetIds) {
      const css = `[data-widget-id="${id}"], [data-widget-id="${id}"] * { visibility: hidden !important }`;
      variants.push(await withCss(css, `without ${id}`, mover));
    }
    variants.push(await withCss('[data-widget-id], [data-widget-id] * { visibility: hidden !important }', 'without any widget', mover));
  }
  for (const css of EXTRA_CSS) {
    variants.push(await withCss(css, css, mover));
    const underPointer = await withCss(css, `pointer, ${css}`, sweep);
    printTopEvents(underPointer, 12);
    const alone = await withCss(css, `nothing else moving, ${css}`, idle);
    printTopEvents(alone, 12);
    user.push(underPointer, alone);
  }
  printSummary('What a user does', user);
  printSummary('One element moved on every frame, with parts of the page taken out', variants);

  expect(baseline.layerize.count).toBeGreaterThan(0);
});
