/**
 * DIAGNOSTIC, not a test suite — sweeps the real renderer for interactive
 * elements that are not fully clickable, and writes a JSON report.
 *
 * For every visible, enabled button / link / menuitem / option / tab /
 * checkbox / radio / select / summary in each UI state it visits, it samples a
 * 3x3 grid of points inside the element's visible box and records, per point:
 *  - hit-testing: document.elementFromPoint must land on the element (or a
 *    descendant, or the <label> of an input) — this honours pointer-events
 *    (Radix's body lock) and occlusion by anything painted above it;
 *  - the window drag region: Blink collects -webkit-app-region rects in
 *    document (pre-)order and Electron folds them in that order (drag = union,
 *    no-drag = difference), so the LAST rect containing the point decides. A
 *    point inside a drag region is eaten by the OS as a window drag.
 *
 * Launches in workspace mode (two configured workspaces, so the header chip
 * and the switch-workspace confirm exist) on the synthetic fixtures, hidden.
 * The last states replay the reported bug's setup: an update arriving while
 * the "Switch workspace" confirm (and other modals) are open — the update
 * dialog used to auto-open underneath and take their clicks; it now waits.
 * shell.openExternal is stubbed in main before any real click, so nothing
 * reaches the system browser. e2e/clickability.test.ts is the committed,
 * targeted suite cut from this sweep.
 *
 * Run:
 *   npm run build --workspace=packages/desktop
 *   npx playwright test --config playwright.diag.config.ts e2e/diag/clickability.diag.ts
 * Report: $CLICKABILITY_OUT (default $TMPDIR/costgoblin-clickability.json).
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { join } from 'node:path';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setup } from '../../packages/core/src/__fixtures__/setup.js';
import {
  FIXTURE_CONFIG_DIR,
  FIXTURE_MULTI_CONFIG_DIR,
  FIXTURE_DATA_DIR,
  FIXTURE_NOW,
  HEADLESS,
  clickNavButton,
  closeApp,
  ensureViewMode,
  launchElectron,
  openDashboardsSidebar,
  openSettings,
  waitForQuerySettle,
} from '../helpers.js';

const OUT = process.env['CLICKABILITY_OUT'] ?? join(tmpdir(), 'costgoblin-clickability.json');

interface ProbePoint {
  readonly x: number;
  readonly y: number;
  /** null = neutral (an SVG shape's bbox point that lands on a sibling shape). */
  readonly ok: boolean | null;
  readonly reason: string | null;
}

interface ProbeElement {
  readonly desc: string;
  readonly layer: string;
  readonly rect: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  /** Share of the element's box outside the viewport (0..1). */
  readonly offscreen: number;
  readonly total: number;
  readonly clickable: number;
  readonly points: readonly ProbePoint[];
}

interface ProbeResult {
  readonly appRegionProperty: string;
  readonly regions: readonly string[];
  readonly overlays: readonly string[];
  readonly bodyPointerEvents: string;
  readonly viewport: { readonly w: number; readonly h: number };
  readonly scanned: number;
  readonly skippedDisabled: number;
  readonly skippedInvisible: number;
  readonly nestedInteractive: readonly string[];
  readonly elements: readonly ProbeElement[];
}

interface StateRecord {
  readonly state: string;
  readonly result: ProbeResult | null;
  readonly error: string | null;
}

/** Runs in the renderer (serialized by page.evaluate — no outer references).
 *  `scope`: optional CSS selector; when set, only elements inside it are probed. */
function probeInPage(scope: string | null): ProbeResult {
  const SEL = [
    'button', 'a[href]', '[role=button]', '[role=menuitem]', '[role=menuitemcheckbox]', '[role=menuitemradio]',
    '[role=option]', '[role=tab]', '[role=switch]', '[role=checkbox]', '[role=radio]',
    'input[type=checkbox]', 'input[type=radio]', 'select', 'summary',
  ].join(',');
  const OVERLAY_SEL = [
    'dialog[open]', '[role=dialog]', '[role=alertdialog]', '[role=menu]', '[role=listbox]',
    '[data-radix-popper-content-wrapper]', '[cmdk-dialog]',
  ].join(',');

  const text = (e: Element): string => e.textContent.replace(/\s+/g, ' ').trim();
  const describe = (e: Element | null): string => {
    if (e === null) return 'null';
    const tag = e.tagName.toLowerCase();
    const role = e.getAttribute('role');
    const tid = e.getAttribute('data-testid');
    const label = e.getAttribute('aria-label') ?? e.getAttribute('title') ?? text(e);
    const rawCls = e.getAttribute('class') ?? '';
    const cls = rawCls.split(/\s+/).filter(c => c.length > 0).slice(0, 5).join('.');
    return `${tag}${role === null ? '' : `[role=${role}]`}${tid === null ? '' : `[testid=${tid}]`} "${label.slice(0, 48)}"${cls === '' ? '' : ` .${cls}`}`;
  };

  const probeStyle = getComputedStyle(document.body);
  let regionProp = 'app-region';
  if (probeStyle.getPropertyValue('app-region') === '' && probeStyle.getPropertyValue('-webkit-app-region') !== '') {
    regionProp = '-webkit-app-region';
  }
  const regionValue = (cs: CSSStyleDeclaration): string => {
    const a = cs.getPropertyValue('app-region');
    return a === '' ? cs.getPropertyValue('-webkit-app-region') : a;
  };
  const isSvgChild = (e: Element): boolean => e instanceof SVGElement && e.tagName.toLowerCase() !== 'svg';

  // Blink LayoutObject::AddDraggableRegions: only visible LayoutBoxes (not
  // inline boxes, not SVG children, not display:contents) contribute, each
  // with its border box, walked in layout-tree pre-order.
  interface Region { mode: string; l: number; t: number; r: number; b: number; desc: string }
  const regions: Region[] = [];
  const all: Element[] = [document.documentElement, ...document.documentElement.querySelectorAll('*')];
  for (const e of all) {
    const cs = getComputedStyle(e);
    const mode = regionValue(cs);
    if (mode !== 'drag' && mode !== 'no-drag') continue;
    if (cs.visibility !== 'visible' || cs.display === 'none' || cs.display === 'contents') continue;
    if (cs.display === 'inline' && !['img', 'svg', 'input', 'select', 'textarea', 'button', 'video', 'canvas', 'iframe'].includes(e.tagName.toLowerCase())) continue;
    if (isSvgChild(e)) continue;
    const b = e.getBoundingClientRect();
    if (b.width <= 0 || b.height <= 0) continue;
    regions.push({ mode, l: b.left, t: b.top, r: b.right, b: b.bottom, desc: describe(e) });
  }
  const regionAt = (x: number, y: number): { mode: string; by: string } => {
    let mode = 'none';
    let by = '';
    for (const g of regions) {
      if (x >= g.l && x < g.r && y >= g.t && y < g.b) {
        mode = g.mode;
        by = g.desc;
      }
    }
    return { mode, by };
  };

  const overlayRoots = [...document.querySelectorAll(OVERLAY_SEL)].filter((o) => {
    const b = o.getBoundingClientRect();
    const cs = getComputedStyle(o);
    return b.width > 0 && b.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
  });
  // Outermost overlays only: a role=dialog inside a <dialog> is the same layer.
  const overlays = overlayRoots.filter(o => !overlayRoots.some(p => p !== o && p.contains(o)));
  const layerOf = (e: Element): string => {
    const o = overlays.find(ov => ov.contains(e));
    return o === undefined ? 'page' : describe(o);
  };
  const scopeRoots = scope === null ? [] : [...document.querySelectorAll(scope)];

  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // The box to sample: for a wrapped inline element its largest line box,
  // else its border box; clipped by the viewport and every clipping ancestor.
  const visibleBox = (e: Element): { l: number; t: number; r: number; b: number } | null => {
    let b = e.getBoundingClientRect();
    if (getComputedStyle(e).display === 'inline') {
      let best: DOMRect | null = null;
      for (const cr of e.getClientRects()) {
        if (best === null || cr.width * cr.height > best.width * best.height) best = cr;
      }
      if (best !== null) b = best;
    }
    let l = Math.max(b.left, 0);
    let t = Math.max(b.top, 0);
    let r = Math.min(b.right, vw);
    let bt = Math.min(b.bottom, vh);
    for (let p = e.parentElement; p !== null && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
        const pb = p.getBoundingClientRect();
        l = Math.max(l, pb.left);
        t = Math.max(t, pb.top);
        r = Math.min(r, pb.right);
        bt = Math.min(bt, pb.bottom);
      }
      if (cs.position === 'fixed') break;
    }
    if (r - l < 4 || bt - t < 4) return null;
    return { l, t, r, b: bt };
  };

  // Nearest fixed/sticky ancestor of a hit (what "covers" a point).
  const positionedLayer = (e: Element): Element | null => {
    for (let p: Element | null = e; p !== null; p = p.parentElement) {
      const pos = getComputedStyle(p).position;
      if (pos === 'fixed' || pos === 'sticky') return p;
    }
    return null;
  };

  const hitsElement = (el: Element, hit: Element | null): boolean => {
    if (hit === null) return false;
    if (el === hit || el.contains(hit)) return true;
    const label = hit.closest('label');
    if (label !== null && (label.contains(el) || (el.id !== '' && label.htmlFor === el.id))) return true;
    return false;
  };

  const onScrollbar = (hit: Element, x: number, y: number): boolean => {
    const b = hit.getBoundingClientRect();
    const ov = getComputedStyle(hit);
    const scroller = ['auto', 'scroll'].includes(ov.overflowY) || ['auto', 'scroll'].includes(ov.overflowX);
    // Overlay scrollbars take no layout space but still own hits at the edge.
    if (scroller && (x >= b.right - 16 || y >= b.bottom - 16)) return true;
    if (hit.scrollHeight > hit.clientHeight && x >= b.left + hit.clientLeft + hit.clientWidth && x < b.right) return true;
    if (hit.scrollWidth > hit.clientWidth && y >= b.top + hit.clientTop + hit.clientHeight && y < b.bottom) return true;
    return false;
  };

  const nestedInteractive: string[] = [];
  const candidates = [...document.querySelectorAll(SEL)]
    .filter(e => overlays.length === 0 || overlays.some(o => o.contains(e)))
    .filter(e => scope === null || scopeRoots.some(r => r.contains(e)));
  let skippedDisabled = 0;
  let skippedInvisible = 0;
  const elements: ProbeElement[] = [];
  for (const el of candidates) {
    const outer = el.parentElement?.closest('button, a[href], [role=button], summary') ?? null;
    if (outer !== null) nestedInteractive.push(`${describe(el)}  INSIDE  ${describe(outer)}`);
    const disabledProp = 'disabled' in el ? el.disabled : false;
    if (disabledProp === true || el.getAttribute('aria-disabled') === 'true') { skippedDisabled++; continue; }
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') { skippedInvisible++; continue; }
    const box = visibleBox(el);
    if (box === null) { skippedInvisible++; continue; }
    const radius = Number.parseFloat(cs.borderTopLeftRadius) || 0;
    const inset = Math.max(2, Math.ceil(Math.min(radius, (box.b - box.t) / 2, (box.r - box.l) / 2) * 0.3) + 1);
    const xs = [box.l + inset, (box.l + box.r) / 2, box.r - inset];
    const ys = [box.t + inset, (box.t + box.b) / 2, box.b - inset];
    const svgRoot = isSvgChild(el) && el instanceof SVGElement ? el.ownerSVGElement : null;
    const isCorner = (x: number, y: number): boolean => (x === xs[0] || x === xs[2]) && (y === ys[0] || y === ys[2]);
    const points: ProbePoint[] = [];
    for (const y of ys) {
      for (const x of xs) {
        const hit = document.elementFromPoint(x, y);
        let reason: string | null = null;
        if (!hitsElement(el, hit)) {
          if (hit === null) {
            reason = 'occluded:nothing';
          } else if (svgRoot !== null && svgRoot.contains(hit)) {
            points.push({ x: Math.round(x), y: Math.round(y), ok: null, reason: 'neutral:svg-sibling-shape' });
            continue;
          } else if (hit.contains(el) && onScrollbar(hit, x, y)) {
            reason = `scrollbar:${describe(hit)}`;
          } else if (hit.contains(el) && isCorner(x, y)) {
            points.push({ x: Math.round(x), y: Math.round(y), ok: null, reason: `neutral:rounded-corner-clip ${describe(hit)}` });
            continue;
          } else {
            const layer = positionedLayer(hit);
            if (layer !== null && !layer.contains(el)) {
              const kind = getComputedStyle(layer).position === 'sticky' ? 'covered-by-sticky' : 'covered-by-fixed';
              reason = `${kind}:${describe(layer)} (hit ${describe(hit)})`;
            } else {
              reason = `occluded:${describe(hit)}`;
            }
            const target = hit.closest('button, a[href], [role=button], [role=menuitem], [role=option], [role=tab], summary, label, input, select');
            if (target !== null && target !== el && !target.contains(el)) {
              const off = 'disabled' in target && target.disabled === true ? ' (disabled)' : '';
              reason += ` ⇒ activates ${describe(target)}${off}`;
            }
          }
        }
        if (reason === null && cs.pointerEvents === 'none') reason = 'pointer-events:none';
        if (reason === null) {
          const region = regionAt(x, y);
          if (region.mode === 'drag') reason = `drag-region:${region.by}`;
        }
        points.push({ x: Math.round(x), y: Math.round(y), ok: reason === null, reason });
      }
    }
    const b = el.getBoundingClientRect();
    const area = Math.max(1, b.width * b.height);
    const visW = Math.max(0, Math.min(b.right, vw) - Math.max(b.left, 0));
    const visH = Math.max(0, Math.min(b.bottom, vh) - Math.max(b.top, 0));
    const counted = points.filter(p => p.ok !== null);
    elements.push({
      desc: describe(el),
      layer: layerOf(el),
      rect: { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) },
      offscreen: Math.round((1 - (visW * visH) / area) * 100) / 100,
      total: counted.length,
      clickable: counted.filter(p => p.ok === true).length,
      points,
    });
  }
  return {
    appRegionProperty: regionProp,
    regions: regions.map(g => `${g.mode} [${String(Math.round(g.l))},${String(Math.round(g.t))} ${String(Math.round(g.r - g.l))}x${String(Math.round(g.b - g.t))}] ${g.desc}`),
    overlays: overlays.map(describe),
    bodyPointerEvents: getComputedStyle(document.body).pointerEvents,
    viewport: { w: vw, h: vh },
    scanned: candidates.length,
    skippedDisabled,
    skippedInvisible,
    nestedInteractive,
    elements,
  };
}

const records: StateRecord[] = [];
let app: ElectronApplication | undefined;
let page: Page;
let userDataDir: string;

async function probe(rawState: string, scope: string | null = null): Promise<ProbeResult | null> {
  const state = triggerNote === '' ? rawState : `${rawState} [${triggerNote}]`;
  triggerNote = '';
  try {
    const result = await page.evaluate(probeInPage, scope);
    records.push({ state, result, error: null });
    const bad = result.elements.filter(e => e.clickable < e.total);
    process.stdout.write(`[probe] ${state}: ${String(result.elements.length)} elements, ${String(bad.length)} not fully clickable, overlays=${String(result.overlays.length)} body.pe=${result.bodyPointerEvents}\n`);
    return result;
  } catch (err) {
    records.push({ state, result: null, error: String(err) });
    process.stdout.write(`[probe] ${state}: FAILED ${String(err)}\n`);
    return null;
  }
}

/** Run a state; a failure to reach it is recorded, never fatal. */
async function visit(state: string, enter: () => Promise<void>, leave?: () => Promise<void>, scope: string | null = null): Promise<void> {
  try {
    await enter();
    await page.waitForTimeout(400);
    await probe(state, scope);
  } catch (err) {
    records.push({ state, result: null, error: `could not enter: ${String(err).split('\n')[0] ?? ''}` });
    process.stdout.write(`[probe] ${state}: could not enter: ${String(err).split('\n')[0] ?? ''}\n`);
  }
  if (leave !== undefined) {
    try { await leave(); } catch { /* best effort */ }
  }
  await page.waitForTimeout(250);
}

async function escape(): Promise<void> {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}

/** Scroll the page (window and the tallest scrolled container) by one screen. */
async function scrollDown(): Promise<void> {
  await page.evaluate(() => {
    window.scrollBy(0, Math.round(window.innerHeight * 0.6));
    const scrollers = [...document.querySelectorAll('*')].filter(e => e.scrollHeight > e.clientHeight + 40 && ['auto', 'scroll'].includes(getComputedStyle(e).overflowY));
    for (const s of scrollers) s.scrollTop += Math.round(s.clientHeight * 0.6);
  });
}

async function scrollTop(): Promise<void> {
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    for (const s of document.querySelectorAll('*')) { if (s.scrollTop > 0) s.scrollTop = 0; }
  });
}

/** Popover/menu triggers (aria-haspopup) in the page body, outside the header. */
async function probePopoverTriggers(prefix: string, max = 8): Promise<void> {
  const triggers = page.locator('[aria-haspopup]:visible:not([disabled])');
  const count = Math.min(await triggers.count(), 30);
  let opened = 0;
  for (let i = 0; i < count && opened < max; i++) {
    const t = triggers.nth(i);
    const inHeader = await t.evaluate(e => e.closest('nav[aria-label="Dashboards and analysis"], nav[aria-label="Sync and settings"]') !== null || e.getAttribute('data-testid') === 'workspace-chip').catch(() => true);
    if (inHeader) continue;
    const label = await t.evaluate(e => (e.getAttribute('aria-label') ?? e.textContent).replace(/\s+/g, ' ').trim().slice(0, 40)).catch(() => '?');
    opened++;
    await visit(`${prefix} › popover "${label}"`, async () => {
      await t.click({ timeout: 2_000 });
      await page.waitForTimeout(300);
      triggerNote = await popoverGeometry(t);
    }, escape);
  }
}

/** Same triggers, but each first scrolled to the bottom of the viewport so a
 *  tall popover has to flip upward — towards the header drag region. */
async function probePopoverTriggersAtBottom(prefix: string, max = 6): Promise<void> {
  const triggers = page.locator('[aria-haspopup]:visible:not([disabled])');
  const count = Math.min(await triggers.count(), 30);
  let opened = 0;
  for (let i = 0; i < count && opened < max; i++) {
    const t = triggers.nth(i);
    const inHeader = await t.evaluate(e => e.closest('nav[aria-label="Dashboards and analysis"], nav[aria-label="Sync and settings"]') !== null || e.getAttribute('data-testid') === 'workspace-chip').catch(() => true);
    if (inHeader) continue;
    const label = await t.evaluate(e => (e.getAttribute('aria-label') ?? e.textContent).replace(/\s+/g, ' ').trim().slice(0, 40)).catch(() => '?');
    opened++;
    await visit(`${prefix} › popover "${label}" (trigger scrolled to viewport bottom)`, async () => {
      await t.evaluate(e => { e.scrollIntoView({ block: 'end' }); });
      await page.waitForTimeout(150);
      await t.click({ timeout: 2_000 });
      await page.waitForTimeout(300);
      triggerNote = await popoverGeometry(t);
    }, escape);
    await scrollTop();
  }
}

let triggerNote = '';

/** Trigger box and the open popper's box, after the click (post auto-scroll). */
async function popoverGeometry(t: ReturnType<Page['locator']>): Promise<string> {
  const r = await t.boundingBox();
  const pop = await page.evaluate(() => {
    const w = document.querySelector('[data-radix-popper-content-wrapper]');
    if (w === null) return 'no popper';
    const b = w.getBoundingClientRect();
    const c = w.firstElementChild;
    const side = c?.getAttribute('data-side') ?? '?';
    return `popper y=${String(Math.round(b.top))}..${String(Math.round(b.bottom))} side=${side}`;
  });
  return r === null ? pop : `trigger y=${String(Math.round(r.y))}..${String(Math.round(r.y + r.height))}; ${pop}`;
}

async function clickButton(name: string | RegExp): Promise<void> {
  await page.locator('button:not(nav button)').filter({ visible: true }).filter({ hasText: name }).first().click({ timeout: 3_000 });
}

async function clickContentButton(exactText: string): Promise<void> {
  await clickButton(new RegExp(`^\\s*${exactText}\\s*$`));
}

test.describe('clickability sweep', () => {
  test.setTimeout(600_000);

  test.beforeAll(async () => {
    await setup();
    userDataDir = mkdtempSync(join(tmpdir(), 'cg-diag-click-'));
    for (const ws of ['default', 'client-b']) {
      const root = join(userDataDir, 'workspaces', ws);
      mkdirSync(join(root, 'state'), { recursive: true });
      mkdirSync(join(root, 'temp'), { recursive: true });
      cpSync(ws === 'default' ? FIXTURE_MULTI_CONFIG_DIR : FIXTURE_CONFIG_DIR, join(root, 'config'), { recursive: true });
      cpSync(FIXTURE_DATA_DIR, join(root, 'data'), { recursive: true });
    }
    writeFileSync(
      join(userDataDir, 'app-state.json'),
      JSON.stringify({ schemaVersion: 1, lastWorkspace: 'default', lastUsed: { default: new Date().toISOString() } }),
    );
    const inherited: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (key === 'COSTGOBLIN_DATA_DIR' || key === 'COSTGOBLIN_CONFIG_DIR') continue;
      inherited[key] = value;
    }
    app = await launchElectron({
      inherited,
      env: {
        NODE_ENV: 'production',
        COSTGOBLIN_E2E: '1',
        COSTGOBLIN_HEADLESS: HEADLESS,
        COSTGOBLIN_NOW: FIXTURE_NOW,
        COSTGOBLIN_USER_DATA_DIR: userDataDir,
      },
    });
    page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: 'Cost Overview' })).toBeVisible({ timeout: 30_000 });
    await waitForQuerySettle(page).catch(() => undefined);
    // Stub the system-browser hand-off before anything is clicked for real.
    await app.evaluate(({ shell }) => {
      const store: string[] = [];
      Reflect.set(globalThis, '__diagOpened', store);
      shell.openExternal = (url: string): Promise<void> => { store.push(url); return Promise.resolve(); };
    });
  });

  test.afterAll(async () => {
    writeFileSync(OUT, JSON.stringify(records, null, 2));
    process.stdout.write(`[probe] report written to ${OUT}\n`);
    try {
      await closeApp(app);
    } finally {
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test('sweep', async () => {
    // ---- Home dashboard + header chrome ---------------------------------
    await visit('home', () => Promise.resolve());
    await visit('home (scrolled)', scrollDown, scrollTop);
    await visit('home › Dashboards sidebar', () => openDashboardsSidebar(page).then(() => undefined));
    await visit('home › workspace chip popover', () => page.getByTestId('workspace-chip').click(), escape);
    await visit('home › Data sync popover', () => page.getByRole('button', { name: 'Data sync' }).click(), escape);
    await visit('home › Rollup status popover', () => page.getByRole('button', { name: 'Rollup status' }).click(), escape);
    await visit('home › debug panel', () => page.getByRole('button', { name: 'Debug panel' }).click(),
      () => page.getByRole('button', { name: 'Debug panel' }).click(), '[class*="w-[75vw]"]');
    await visit('home › command palette', () => page.keyboard.press('Meta+k'), escape);
    await visit('home › Reload data confirm (Radix)', () => page.getByRole('button', { name: 'Reload data' }).click(), escape);
    await probePopoverTriggers('home');
    await probePopoverTriggersAtBottom('home');

    // ---- Analytical pages ------------------------------------------------
    for (const nav of ['Trends', 'Findings', 'Baselines', 'Tags', 'Explorer']) {
      await visit(`page ${nav}`, async () => {
        await ensureViewMode(page);
        await page.getByRole('navigation', { name: 'Dashboards and analysis' }).getByRole('button', { name: nav }).first().click();
        await waitForQuerySettle(page).catch(() => undefined);
      });
      await visit(`page ${nav} (scrolled)`, scrollDown, scrollTop);
      await probePopoverTriggers(`page ${nav}`);
      await probePopoverTriggersAtBottom(`page ${nav}`);
    }

    // ---- Baselines dialogs (Radix) ----------------------------------------
    await ensureViewMode(page);
    await page.getByRole('navigation', { name: 'Dashboards and analysis' }).getByRole('button', { name: 'Baselines' }).first().click();
    await waitForQuerySettle(page).catch(() => undefined);
    await visit('page Baselines › Recompute… (Radix Dialog)', () => clickButton('Recompute…'), escape);
    await visit('page Baselines › New baseline (Radix Dialog)', () => clickButton('New baseline'));
    try {
      await page.getByPlaceholder('e.g. Amazon Relational Database Service').fill('Amazon Elastic Compute Cloud');
      await page.getByRole('button', { name: 'Create', exact: true }).click({ timeout: 3_000 });
      await page.waitForTimeout(1_500);
      await escape();
      // A second baseline, so the detail dialog's ← / → controls are enabled.
      await clickButton('New baseline');
      await page.getByPlaceholder('e.g. Amazon Relational Database Service').fill('AWS Backup');
      await page.getByRole('button', { name: 'Create', exact: true }).click({ timeout: 3_000 });
      await page.waitForTimeout(1_500);
      await escape();
      await visit('page Baselines › baseline detail (Radix DialogContent max-w-4xl)', async () => {
        await page.locator('button', { hasText: 'Amazon Elastic Compute Cloud' }).first().click({ timeout: 5_000 });
        await page.waitForTimeout(2_000);
        triggerNote = await page.evaluate(() => {
          const d = document.querySelector('[role=dialog]');
          if (d === null) return 'no dialog';
          const b = d.getBoundingClientRect();
          return `dialog y=${String(Math.round(b.top))}..${String(Math.round(b.bottom))}`;
        });
      });
      // Scroll the dialog's own content so its status row sits in the band the
      // dialog shares with the header (dialog top is 5vh, header is ~78px).
      await visit('page Baselines › baseline detail, content scrolled (status row at dialog top)', async () => {
        await page.evaluate(() => {
          const d = document.querySelector('[role=dialog]');
          const row = [...document.querySelectorAll('[role=dialog] button')].find(b => /Tracking/.test(b.textContent));
          if (d === null || row === undefined) return;
          d.scrollTop += row.getBoundingClientRect().top - d.getBoundingClientRect().top - 12;
        });
        await page.waitForTimeout(200);
      }, escape);
    } catch (err) {
      records.push({ state: 'page Baselines › baseline detail', result: null, error: `could not create/open: ${String(err).split('\n')[0] ?? ''}` });
      await escape();
    }

    // ---- Settings tabs ---------------------------------------------------
    const tabs = ['General', 'Workspaces', 'Data & Sync', 'Cost Scope', 'Dimensions', 'Dashboards', 'Share', 'Import', 'AI Assistant', 'Performance', 'Telemetry'];
    for (const tab of tabs) {
      await visit(`settings ${tab}`, async () => {
        await openSettings(page);
        await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: tab, exact: true }).click();
        await page.waitForTimeout(600);
        await waitForQuerySettle(page).catch(() => undefined);
      });
      await visit(`settings ${tab} (scrolled)`, scrollDown, scrollTop);
      await probePopoverTriggers(`settings ${tab}`, 5);
      await probePopoverTriggersAtBottom(`settings ${tab}`, 4);

      if (tab === 'Workspaces') {
        await visit('settings Workspaces › New workspace (TitledModal)', () => clickButton('New workspace'), escape);
        await visit('settings Workspaces › Rename (TitledModal)', () => page.getByTestId('workspace-row-client-b').getByRole('button', { name: 'Rename' }).click(), escape);
        await visit('settings Workspaces › Delete (ConfirmModal)', () => page.getByTestId('workspace-row-client-b').getByRole('button', { name: 'Delete' }).click(), escape);
      }
      if (tab === 'Data & Sync') {
        await visit('settings Data & Sync › Add Provider (WizardModal)', () => clickButton('Add Provider'), escape);
        await visit('settings Data & Sync › Delete All Data (ConfirmModal)', () => clickButton('Delete All Data'), escape);
        await visit('settings Data & Sync › Prune (ConfirmModal)', () => clickButton(/^Prune/), escape);
        await visit('settings Data & Sync › Configure daily (WizardModal, source mode)', () => page.locator('button[title="Configure daily"]').first().click({ timeout: 3_000 }), escape);
        await visit('settings Data & Sync › Remove provider (ConfirmModal)', () => clickButton(/^Remove/), escape);
        await visit('settings Data & Sync › Change AWS Profile (Radix Dialog)', () => clickButton('Change AWS Profile'), escape);
      }
      if (tab === 'Dashboards') {
        await visit('settings Dashboards › Import YAML (ViewYamlModal)', () => clickContentButton('Import'), escape);
        await visit('settings Dashboards › Export YAML (ViewYamlModal)', () => clickContentButton('Export'), escape);
      }
    }
    await ensureViewMode(page);

    // ---- Native modal opened from the (Radix) command palette -------------
    await visit('palette › New workspace… (TitledModal right after Radix close)', async () => {
      await page.keyboard.press('Meta+k');
      await page.getByPlaceholder('Type to search...').fill('New workspace');
      await page.keyboard.press('Enter');
    }, escape);
    await visit('palette › Switch to workspace (ConfirmModal right after Radix close)', async () => {
      await page.keyboard.press('Meta+k');
      await page.getByPlaceholder('Type to search...').fill('Switch to workspace');
      await page.keyboard.press('Enter');
    }, escape);

    // ---- Minimum window width (main.ts minWidth 900): header grid overlap ----
    // Viewport emulation rather than BrowserWindow.setSize: resizing the
    // hidden window on macOS now and then stalls its frames for minutes.
    const setSize = async (w: number, h: number): Promise<void> => {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(500);
    };
    for (const [w, h] of [[900, 600], [1024, 700]] as const) {
      await setSize(w, h);
      await ensureViewMode(page);
      await visit(`window ${String(w)}x${String(h)} › home header`, () => page.getByRole('button', { name: 'Home' }).click(), undefined, 'div.sticky.top-0');
      await visit(`window ${String(w)}x${String(h)} › Explorer active (labelled nav button) header`, () => page.getByRole('navigation', { name: 'Dashboards and analysis' }).getByRole('button', { name: 'Explorer' }).click(), undefined, 'div.sticky.top-0');
      await visit(`window ${String(w)}x${String(h)} › settings header`, () => openSettings(page), undefined, 'div.sticky.top-0');
      await ensureViewMode(page);
      await page.getByRole('button', { name: 'Home' }).click();
      await waitForQuerySettle(page).catch(() => undefined);
      await visit(`window ${String(w)}x${String(h)} › home date picker`, async () => {
        const t = page.locator('button:has(svg.lucide-calendar)').first();
        await t.click();
        await page.waitForTimeout(300);
        triggerNote = await popoverGeometry(t);
      }, escape);
      await ensureViewMode(page);
    }
    await setSize(1280, 800);

    // ---- An update arriving while a modal is open ------------------------------
    // The update dialog never opens over another modal: it waits for the last
    // one to close (decideUpdateAutoOpen). An error push opens it once per
    // error episode; an idle push in between unmounts it and starts a new one.
    const pushUpdate = async (status: unknown): Promise<void> => {
      await app?.evaluate(({ BrowserWindow }, s) => {
        for (const w of BrowserWindow.getAllWindows()) w.webContents.send('update:status-changed', s);
      }, status);
    };
    const openDialogs = (): Promise<string[]> => page.evaluate(() =>
      [...document.querySelectorAll('[role=dialog]')].map(d => d.textContent.trim().slice(0, 40)));
    const updateError = { state: 'error', error: 'net::ERR_INTERNET_DISCONNECTED', stage: 'download', logs: [] };
    const updateArrivesUnder = async (label: string, openModal: () => Promise<void>, modalName: string | RegExp): Promise<void> => {
      await visit(`${label} (alone)`, async () => {
        await openModal();
        await expect(page.getByRole('dialog', { name: modalName }).first()).toBeVisible({ timeout: 3_000 });
      });
      await visit(`${label} + "Update failed" pushed (should wait)`, async () => {
        await pushUpdate(updateError);
        await page.waitForTimeout(500);
        triggerNote = `"Update failed" open=${String(await page.getByRole('dialog', { name: 'Update failed' }).count())}`;
      });
      // A REAL click on the modal's dismiss control (Cancel / Close / ✕); the
      // update dialog should open once it has closed.
      const dismiss = page.locator('[role=dialog] button', { hasText: /^(Cancel|Close|✕)$/ }).last();
      const db = await dismiss.boundingBox().catch(() => null);
      let outcome = 'no dismiss control found';
      if (db !== null) {
        const cx = db.x + db.width / 2;
        const cy = db.y + db.height / 2;
        const hit = await page.evaluate(({ x, y }) => {
          const h = document.elementFromPoint(x, y);
          return h === null ? 'null' : `${h.tagName.toLowerCase()} "${h.textContent.trim().slice(0, 30)}" .${(h.getAttribute('class') ?? '').split(' ').slice(0, 3).join('.')}`;
        }, { x: cx, y: cy });
        await page.mouse.click(cx, cy);
        await page.waitForTimeout(600);
        outcome = `click at (${String(Math.round(cx))},${String(Math.round(cy))}) hit ${hit}; after: dialogs open=${JSON.stringify(await openDialogs())}`;
      }
      records.push({ state: `${label}: REAL click on its dismiss control`, result: null, error: outcome });
      process.stdout.write(`[probe] ${label}: ${outcome}\n`);
      await pushUpdate({ state: 'idle' });
      for (let i = 0; i < 3 && (await openDialogs()).length > 0; i++) await escape();
    };
    await ensureViewMode(page);
    await updateArrivesUnder('update under Delete workspace ConfirmModal', async () => {
      await clickNavButton(page, 'Workspaces');
      await page.getByTestId('workspace-row-client-b').getByRole('button', { name: 'Delete' }).click();
    }, 'Delete workspace');
    await updateArrivesUnder('update under New workspace TitledModal', () => clickButton('New workspace'), 'New workspace');
    await updateArrivesUnder('update under Add Provider WizardModal', async () => {
      await clickNavButton(page, 'Sync');
      await clickButton('Add Provider');
    }, 'Add provider');
    await updateArrivesUnder('update under Import YAML ViewYamlModal', async () => {
      await clickNavButton(page, 'Views Editor');
      await clickContentButton('Import');
    }, /import/i);
    await ensureViewMode(page);

    // ---- Reported bug: the Switch workspace confirm with an update arriving ----
    await visit('switch-workspace ConfirmModal', async () => {
      await page.getByTestId('workspace-chip').click();
      await page.getByRole('group', { name: 'Workspaces' }).getByRole('button', { name: 'client-b' }).click();
      await expect(page.getByRole('dialog', { name: 'Switch workspace' })).toBeVisible();
    });
    const notes = [
      '<h2>What\'s Changed</h2><ul>',
      ...Array.from({ length: 14 }, (_, i) => `<li>fix(ui): change number ${String(i)} by <a href="https://github.com/etiennechabert">@etiennechabert</a> in <a href="https://github.com/etiennechabert/cost-goblin/pull/${String(600 + i)}">https://github.com/etiennechabert/cost-goblin/pull/${String(600 + i)}</a></li>`),
      '</ul><p><strong>Full Changelog</strong>: <a href="https://github.com/etiennechabert/cost-goblin/compare/v0.8.3...v0.8.4">v0.8.3...v0.8.4</a></p>',
    ].join('');
    await visit('switch-workspace ConfirmModal + update available pushed (release notes should wait)', async () => {
      await pushUpdate({ state: 'available', info: { version: '9.9.9', releaseDate: '2026-10-12', releaseNotes: notes } });
      await page.waitForTimeout(500);
      triggerNote = `release notes open=${String(await page.getByRole('dialog', { name: /Update Available/ }).count())}`;
    });

    // What a click at each sampled point of the confirm's buttons would hit.
    const hitMap = await page.evaluate(() => {
      const out: string[] = [];
      const confirm = [...document.querySelectorAll('[role=dialog]')].find(d => d.textContent.includes('Switch workspace'));
      for (const b of confirm?.querySelectorAll('button') ?? []) {
        const r = b.getBoundingClientRect();
        for (const fy of [0.2, 0.5, 0.8]) {
          for (const fx of [0.1, 0.3, 0.5, 0.7, 0.9]) {
            const x = r.left + r.width * fx;
            const y = r.top + r.height * fy;
            const h = document.elementFromPoint(x, y);
            const a = h?.closest('a[href]') ?? null;
            out.push(`${b.textContent.trim()} (${String(Math.round(x))},${String(Math.round(y))}) -> ${h === null ? 'null' : h.tagName.toLowerCase()}${a === null ? '' : ` LINK ${a.getAttribute('href') ?? ''}`} "${(h?.textContent ?? '').trim().slice(0, 40)}"`);
          }
        }
      }
      return out;
    });
    records.push({ state: 'HIT MAP of the switch confirm buttons (update pending)', result: null, error: hitMap.join('\n') });
    process.stdout.write(`[probe] hit map:\n${hitMap.join('\n')}\n`);

    // A REAL click at the centre of Cancel: the release notes should open only
    // now. (Switch & Restart quits the app under e2e — e2e/clickability.test.ts
    // clicks it.)
    const box = await page.getByRole('dialog', { name: 'Switch workspace' }).getByRole('button', { name: 'Cancel' }).boundingBox().catch(() => null);
    const centre = box === null ? null : { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    let outcome = 'no Cancel found';
    if (centre !== null) {
      await page.mouse.click(centre.x, centre.y);
      await page.waitForTimeout(800);
      const opened = await app?.evaluate(() => {
        const v: unknown = Reflect.get(globalThis, '__diagOpened');
        return Array.isArray(v) ? v.map(String) : [];
      }) ?? [];
      const confirmOpen = await page.getByRole('dialog', { name: 'Switch workspace' }).count();
      const notesOpen = await page.getByRole('dialog', { name: /Update Available/ }).count();
      outcome = `real click at (${String(Math.round(centre.x))},${String(Math.round(centre.y))}); openExternal calls=${JSON.stringify(opened)}; confirmOpen=${String(confirmOpen)}; releaseNotesOpen=${String(notesOpen)}`;
    }
    records.push({ state: 'REAL CLICK at the switch confirm\'s Cancel (release notes should follow)', result: null, error: outcome });
    process.stdout.write(`[probe] real click outcome: ${outcome}\n`);

    // One Escape: closes the release notes.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
    const afterEsc = await openDialogs();
    records.push({ state: 'ONE Escape with the release notes open', result: null, error: `dialogs still open: ${JSON.stringify(afterEsc)}` });
    process.stdout.write(`[probe] after one Escape: ${JSON.stringify(afterEsc)}\n`);
    for (let i = 0; i < 3 && (await openDialogs()).length > 0; i++) await escape();

    // The update dialog alone (General tab → its release-notes button).
    await visit('release notes (Radix) alone, opened from Settings › General', async () => {
      await clickNavButton(page, 'General');
      await page.locator('button', { hasText: /v9\.9\.9 available/ }).first().click({ timeout: 3_000 });
      await expect(page.getByRole('dialog', { name: /Update Available/ })).toBeVisible();
    }, escape);
    await ensureViewMode(page);

    // Cmd+K over a modal: the palette stays closed (its navigations open modals).
    await visit('Cmd+K over Delete-workspace ConfirmModal (palette should stay closed)', async () => {
      await clickNavButton(page, 'Workspaces');
      await page.getByTestId('workspace-row-client-b').getByRole('button', { name: 'Delete' }).click();
      await expect(page.getByRole('dialog', { name: 'Delete workspace' })).toBeVisible();
      await page.keyboard.press('Meta+k');
      await page.waitForTimeout(400);
      triggerNote = `palette open=${String(await page.getByPlaceholder('Type to search...').count())}`;
    });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
    const afterPaletteEsc = await openDialogs();
    records.push({ state: 'ONE Escape after Cmd+K over ConfirmModal', result: null, error: `dialogs still open: ${JSON.stringify(afterPaletteEsc)}` });
    process.stdout.write(`[probe] after one Escape (Cmd+K over confirm): ${JSON.stringify(afterPaletteEsc)}\n`);
    for (let i = 0; i < 3 && (await openDialogs()).length > 0; i++) await escape();
  });
});

test.describe('clickability sweep — standalone setup wizard', () => {
  test.setTimeout(300_000);
  let wizardUserData: string;

  test.beforeAll(async () => {
    wizardUserData = mkdtempSync(join(tmpdir(), 'cg-diag-wizard-'));
    for (const sub of ['config', 'data', 'state', 'temp']) {
      mkdirSync(join(wizardUserData, 'workspaces', 'fresh', sub), { recursive: true });
    }
    writeFileSync(
      join(wizardUserData, 'app-state.json'),
      JSON.stringify({ schemaVersion: 1, lastWorkspace: 'fresh', lastUsed: { fresh: new Date().toISOString() } }),
    );
    const inherited: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (key === 'COSTGOBLIN_DATA_DIR' || key === 'COSTGOBLIN_CONFIG_DIR') continue;
      inherited[key] = value;
    }
    app = await launchElectron({
      inherited,
      env: {
        NODE_ENV: 'production',
        COSTGOBLIN_E2E: '1',
        COSTGOBLIN_HEADLESS: HEADLESS,
        COSTGOBLIN_NOW: FIXTURE_NOW,
        COSTGOBLIN_USER_DATA_DIR: wizardUserData,
      },
    });
    page = await app.firstWindow();
    await expect(page.getByText('Which cloud are you billing on?')).toBeVisible({ timeout: 30_000 });
    await app.evaluate(({ shell }) => {
      shell.openExternal = (): Promise<void> => Promise.resolve();
    });
  });

  test.afterAll(async () => {
    writeFileSync(OUT, JSON.stringify(records, null, 2));
    process.stdout.write(`[probe] report written to ${OUT}\n`);
    try {
      await closeApp(app);
    } finally {
      rmSync(wizardUserData, { recursive: true, force: true });
    }
  });

  test('wizard', async () => {
    await visit('wizard start', () => Promise.resolve());
    await probePopoverTriggers('wizard start', 4);
    await visit('wizard start › Import from a teammate (TitledModal over drag root)', () => clickButton('Import from a teammate'), escape);
    await visit('wizard › GCP intro', () => page.getByRole('button', { name: 'Set up from Google Cloud' }).click());
    await probePopoverTriggers('wizard GCP intro', 4);
    await page.getByRole('button', { name: 'Back to start' }).click().catch(() => undefined);
    await page.waitForTimeout(300);
    await visit('wizard › AWS profile step', () => page.getByRole('button', { name: 'Set up from AWS' }).click());
    await probePopoverTriggers('wizard AWS', 4);
  });
});
