import { test, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { join } from 'node:path';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  FIXTURE_CONFIG_DIR,
  FIXTURE_DATA_DIR,
  FIXTURE_NOW,
  HEADLESS,
  SETTINGS_NAV_LABEL,
  attachCoverage,
  clickNavButton,
  closeApp,
  collectCoverage,
  ensureViewMode,
  expectCloudSandboxed,
  finishCoverage,
  launchElectron,
  openDashboardsDropdown,
  openSettings,
} from './helpers.js';

// Can every button actually be clicked? Locks the fixes for the reported bug —
// in the "Switch workspace" confirm, clicks opened GitHub links instead: the
// release-notes dialog had auto-opened underneath and taken the pointer — and
// for the window drag regions that ate clicks on the header nav, on modals
// reaching into the header band and on the hosted setup wizard. Also the
// update modal's wiring in App.tsx, which has no renderer unit harness: it
// waits for other modals (including after Retry), and the gear routes to it.
//
// Two kinds of check:
// - Hit-testing: `document.elementFromPoint` at sample points inside a control
//   must land on it. It honours pointer-events (a modal's body lock) and
//   anything painted above, and Playwright's own clicks re-check it.
// - The drag-region model. Clicks driven over CDP never reach the OS, so a
//   window drag region can't fail a real click here: the suite asserts the
//   region model instead. Blink collects every box's computed
//   `-webkit-app-region` (an inherited property in Electron 44) in document
//   order and Electron folds them in that order, so the LAST region containing
//   a point decides whether a click there drags the window. e2e/diag/
//   clickability.diag.ts is the full sweep this suite was cut from.
//
// Workspace mode (two workspaces, so the header's workspace chip and the
// switch confirm exist), launched like workspaces.test.ts. The first describe
// ends in a workspace switch, which quits the app under e2e; the second runs
// on its own launch. shell.openExternal is stubbed in main before anything is
// clicked, so nothing can reach the system browser.

// ---------------------------------------------------------------------------
// In-page probe
// ---------------------------------------------------------------------------

interface Point {
  readonly x: number;
  readonly y: number;
}

interface PointReport {
  readonly target: string;
  readonly x: number;
  readonly y: number;
  /** elementFromPoint landed on the target or inside it. */
  readonly onTarget: boolean;
  readonly hit: string;
  /** The drag-region mode deciding the point: 'drag', 'no-drag' or 'none'. */
  readonly region: string;
  readonly regionBy: string;
}

interface ProbeRequest {
  /** Probe the root's visible descendants matching this, or the root itself when null. */
  readonly selector: string | null;
  /** Probe these points, or five inside each target (centre and edge midpoints) when null. */
  readonly points: readonly Point[] | null;
}

/** Runs in the renderer (serialized by evaluate — no outer references). */
function probePoints(root: Element, request: ProbeRequest): PointReport[] {
  const describe = (e: Element | null): string => {
    if (e === null) return 'nothing';
    const label = e.getAttribute('aria-label') ?? e.getAttribute('title') ?? e.getAttribute('data-testid')
      ?? e.textContent.replace(/\s+/g, ' ').trim();
    return `${e.tagName.toLowerCase()} "${label.slice(0, 40)}"`;
  };
  const modeOf = (cs: CSSStyleDeclaration): string => {
    const mode = cs.getPropertyValue('app-region');
    return mode === '' ? cs.getPropertyValue('-webkit-app-region') : mode;
  };

  // The boxes that contribute a region (Blink's LayoutObject::AddDraggableRegions):
  // visible layout boxes — not inline boxes, not SVG shapes, not
  // display:contents — each with its border box, in document order.
  const replaced = new Set(['img', 'svg', 'input', 'select', 'textarea', 'button', 'video', 'canvas', 'iframe']);
  const regions: { mode: string; l: number; t: number; r: number; b: number; by: string }[] = [];
  for (const e of [document.documentElement, ...document.documentElement.querySelectorAll('*')]) {
    const cs = getComputedStyle(e);
    const mode = modeOf(cs);
    if (mode !== 'drag' && mode !== 'no-drag') continue;
    if (cs.visibility !== 'visible' || cs.display === 'none' || cs.display === 'contents') continue;
    if (cs.display === 'inline' && !replaced.has(e.tagName.toLowerCase())) continue;
    if (e instanceof SVGElement && !(e instanceof SVGSVGElement)) continue;
    const box = e.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) continue;
    regions.push({ mode, l: box.left, t: box.top, r: box.right, b: box.bottom, by: describe(e) });
  }
  const regionAt = (x: number, y: number): { mode: string; by: string } => {
    let found = { mode: 'none', by: '' };
    for (const g of regions) {
      if (x >= g.l && x < g.r && y >= g.t && y < g.b) found = { mode: g.mode, by: g.by };
    }
    return found;
  };

  const targets = request.selector === null
    ? [root]
    : [...root.querySelectorAll(request.selector)].filter((e) => {
      const box = e.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && getComputedStyle(e).visibility === 'visible';
    });
  const pointsOf = (e: Element): readonly Point[] => {
    if (request.points !== null) return request.points;
    const box = e.getBoundingClientRect();
    const inset = Math.min(3, box.width / 4, box.height / 4);
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    return [
      { x: cx, y: cy },
      { x: box.left + inset, y: cy },
      { x: box.right - inset, y: cy },
      { x: cx, y: box.top + inset },
      { x: cx, y: box.bottom - inset },
    ];
  };

  const reports: PointReport[] = [];
  for (const target of targets) {
    for (const { x, y } of pointsOf(target)) {
      const hit = document.elementFromPoint(x, y);
      const region = regionAt(x, y);
      reports.push({
        target: describe(target),
        x: Math.round(x),
        y: Math.round(y),
        onTarget: hit !== null && (hit === target || target.contains(hit)),
        hit: describe(hit),
        region: region.mode,
        regionBy: region.by,
      });
    }
  }
  return reports;
}

/** A point a click would miss, or that would drag the window. */
function problemsOf(reports: readonly PointReport[]): string[] {
  return reports
    .filter(p => !p.onTarget || p.region === 'drag')
    .map(p => `${p.target} at (${String(p.x)},${String(p.y)}):${p.onTarget ? '' : ` hits ${p.hit}`}${p.region === 'drag' ? ` drags the window (${p.regionBy})` : ''}`);
}

/** Wait out finite animations (a dialog's zoom-in moves its controls). */
async function settleAnimations(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const finite = document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(finite.map(a => a.finished.catch(() => undefined)));
  });
}

/** Every sample point inside `target` is on it and outside any drag region. */
async function expectClickable(page: Page, target: Locator): Promise<void> {
  await expect(target).toBeVisible();
  await settleAnimations(page);
  const reports = await target.evaluate(probePoints, { selector: null, points: null });
  expect(problemsOf(reports)).toEqual([]);
}

/** Descriptions of the elements inside `root` that make a drag region. */
function dragRegionsWithin(root: Element): string[] {
  const modeOf = (e: Element): string => {
    const cs = getComputedStyle(e);
    const mode = cs.getPropertyValue('app-region');
    return mode === '' ? cs.getPropertyValue('-webkit-app-region') : mode;
  };
  return [root, ...root.querySelectorAll('*')]
    .filter(e => modeOf(e) === 'drag')
    .map(e => `${e.tagName.toLowerCase()}.${(e.getAttribute('class') ?? '').split(/\s+/).slice(0, 4).join('.')}`);
}

// ---------------------------------------------------------------------------
// App helpers
// ---------------------------------------------------------------------------

/** The header's grid: both labelled navs and the centre column between them. */
function headerGrid(page: Page): Locator {
  return page.locator('nav:has(> nav[aria-label="Sync and settings"])');
}

/** The gear while it carries the update dot (`data-update-available`) — CSS,
 *  so it still resolves while a modal has hidden the page from the
 *  accessibility tree. */
function gearWithUpdate(page: Page): Locator {
  return page.locator('nav[aria-label="Sync and settings"] button[aria-label="Settings"][data-update-available="true"]');
}

/** A release that is long enough, and full enough of links, that an update
 *  dialog shown under (or over) the confirm would put GitHub links where its
 *  buttons are — the reported bug. */
const RELEASE_NOTES = [
  '<h2>What\'s Changed</h2><ul>',
  ...Array.from({ length: 14 }, (_, i) => `<li>fix(ui): change ${String(i)} by <a href="https://github.com/etiennechabert">@etiennechabert</a> in <a href="https://github.com/etiennechabert/cost-goblin/pull/${String(600 + i)}">https://github.com/etiennechabert/cost-goblin/pull/${String(600 + i)}</a></li>`),
  '</ul><p><strong>Full Changelog</strong>: <a href="https://github.com/etiennechabert/cost-goblin/compare/v0.8.4...v9.9.9">v0.8.4...v9.9.9</a></p>',
].join('');
const UPDATE_AVAILABLE = {
  state: 'available',
  info: { version: '9.9.9', releaseDate: '2026-10-12', releaseNotes: RELEASE_NOTES },
};
const UPDATE_CHECK_FAILED = {
  state: 'error',
  stage: 'check',
  error: 'net::ERR_INTERNET_DISCONNECTED',
  logs: [{ timestamp: Date.parse(FIXTURE_NOW), level: 'error', message: 'Error: net::ERR_INTERNET_DISCONNECTED' }],
};

/** Push an updater status from main, exactly as the updater does. */
async function pushUpdateStatus(app: ElectronApplication, status: unknown): Promise<void> {
  await app.evaluate(({ BrowserWindow }, s) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('update:status-changed', s);
  }, status);
}

const OPEN_EXTERNAL_MARK = '[e2e] shell.openExternal ';

/** Replace shell.openExternal in main with a recorder, and prove it records:
 *  a window.open from the renderer has to arrive. Logged rather than kept in
 *  main, so the record survives a click that quits the app. */
async function stubOpenExternal(app: ElectronApplication, page: Page): Promise<string[]> {
  const opened: string[] = [];
  app.on('console', (message) => {
    const text = message.text();
    if (text.startsWith(OPEN_EXTERNAL_MARK)) opened.push(text.slice(OPEN_EXTERNAL_MARK.length));
  });
  await app.evaluate(({ shell }, mark) => {
    shell.openExternal = (url: string): Promise<void> => {
      console.log(`${mark}${url}`);
      return Promise.resolve();
    };
  }, OPEN_EXTERNAL_MARK);
  await page.evaluate(() => { globalThis.open('https://stub-check.invalid/', '_blank'); });
  await expect.poll(() => [...opened]).toEqual(['https://stub-check.invalid/']);
  opened.length = 0;
  return opened;
}

/** Lay the page out at a window size (main.ts's minimum is 900x600). By
 *  viewport emulation, as stress.test.ts does, not BrowserWindow.setSize:
 *  resizing the hidden window on macOS now and then stalls the renderer's
 *  frames for minutes, and the checks here only need the layout. */
async function setViewport(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await expect.poll(() => page.evaluate(() => [globalThis.innerWidth, globalThis.innerHeight])).toEqual([width, height]);
}

/** Workspace mode: `active` is configured on the fixtures, `other` exists
 *  but is not set up. The tree lives in a fresh run root that closeApp
 *  deletes. */
function seedWorkspaces(active: string, other: string): { runRoot: string; userDataDir: string } {
  const runRoot = mkdtempSync(join(tmpdir(), 'costgoblin-e2e-run-'));
  const userDataDir = join(runRoot, 'user-data');
  const activeRoot = join(userDataDir, 'workspaces', active);
  mkdirSync(join(activeRoot, 'state'), { recursive: true });
  mkdirSync(join(activeRoot, 'temp'), { recursive: true });
  cpSync(FIXTURE_CONFIG_DIR, join(activeRoot, 'config'), { recursive: true });
  cpSync(FIXTURE_DATA_DIR, join(activeRoot, 'data'), { recursive: true });
  for (const sub of ['config', 'data', 'state', 'temp']) {
    mkdirSync(join(userDataDir, 'workspaces', other, sub), { recursive: true });
  }
  writeFileSync(
    join(userDataDir, 'app-state.json'),
    JSON.stringify({ schemaVersion: 1, lastWorkspace: active, lastUsed: { [active]: new Date().toISOString() } }),
  );
  return { runRoot, userDataDir };
}

/** Launch into the seeded workspace tree and attach coverage. Not
 *  launchAppWithCoverage: that pins COSTGOBLIN_DATA_DIR/CONFIG_DIR, the mode
 *  in which the workspace chip and switch don't exist. */
async function launchWorkspaceApp(runRoot: string, userDataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  // Strip the pinned-mode vars the runner may carry (see workspaces.test.ts).
  const inherited: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'COSTGOBLIN_DATA_DIR' || key === 'COSTGOBLIN_CONFIG_DIR') continue;
    inherited[key] = value;
  }
  const app = await launchElectron({
    runRoot,
    inherited,
    env: {
      NODE_ENV: 'production',
      COSTGOBLIN_E2E: '1',
      COSTGOBLIN_HEADLESS: HEADLESS,
      COSTGOBLIN_NOW: FIXTURE_NOW,
      COSTGOBLIN_USER_DATA_DIR: userDataDir,
    },
  });
  try {
    // Nothing may be awaited between firstWindow() and the attach — see
    // attachCoverage's doc comment.
    const page = await attachCoverage(await app.firstWindow());
    await expect(page).toHaveTitle('CostGoblin');
    await expect(page.getByRole('heading', { name: 'Cost Overview' })).toBeVisible({ timeout: 15_000 });
    return { app, page };
  } catch (err) {
    await closeApp(app);
    throw err;
  }
}

/** Header chip → the other workspace → the "Switch workspace" confirm. */
async function openSwitchConfirm(page: Page, target: string): Promise<Locator> {
  await page.getByTestId('workspace-chip').click();
  await page.getByRole('group', { name: 'Workspaces' }).getByRole('button', { name: target }).click();
  const confirm = page.getByRole('dialog', { name: 'Switch workspace' });
  await expect(confirm).toBeVisible();
  return confirm;
}

/** The update arrived (the gear shows its dot) while a modal is open, and
 *  the update dialog stayed closed. The dot renders in the same commit as the
 *  auto-open decision; the wait gives a wrong "open" time to paint. */
async function expectUpdateDeferred(page: Page): Promise<void> {
  await expect(gearWithUpdate(page)).toHaveCount(1);
  await page.waitForTimeout(300);
  await expect(page.locator('[role=dialog]', { hasText: 'Update Available' })).toHaveCount(0);
}

const PALETTE_INPUT = 'Type to search...';

// ---------------------------------------------------------------------------
// The reported bug, as reported: Switch & Restart under an incoming update
// ---------------------------------------------------------------------------

test.describe('Switch workspace confirm with an update arriving', () => {
  let app: ElectronApplication | undefined;
  let page: Page | undefined;
  let userDataDir: string;
  let opened: string[];

  test.beforeAll(async () => {
    const seeded = seedWorkspaces('default', 'client-b');
    userDataDir = seeded.userDataDir;
    ({ app, page } = await launchWorkspaceApp(seeded.runRoot, userDataDir));
    opened = await stubOpenExternal(app, page);
  });

  test.afterAll(async () => {
    // The test below quits the app and harvested coverage before it did.
    await finishCoverage(app, page, 'clickability-switch');
  });

  test('Switch & Restart switches, and no click reaches the release notes', async () => {
    if (app === undefined || page === undefined) throw new Error('app not launched');
    const confirm = await openSwitchConfirm(page, 'client-b');
    await pushUpdateStatus(app, UPDATE_AVAILABLE);
    await expectUpdateDeferred(page);

    const switchButton = confirm.getByRole('button', { name: 'Switch & Restart' });
    await expectClickable(page, switchButton);
    await expectClickable(page, confirm.getByRole('button', { name: 'Cancel' }));

    // The click quits the app (e2e mode quits instead of relaunching), so
    // harvest renderer coverage first. The quit can land before Playwright
    // has finished the click, which then rejects with "has been closed".
    await collectCoverage(page);
    const closed = app.waitForEvent('close');
    const clicked = switchButton.click().then(() => null, (err: unknown) => err);
    await closed;
    const clickError = await clicked;
    if (clickError instanceof Error && !clickError.message.includes('has been closed')) throw clickError;

    const state: unknown = JSON.parse(readFileSync(join(userDataDir, 'app-state.json'), 'utf-8'));
    expect(state).toMatchObject({ lastWorkspace: 'client-b' });
    expect(opened).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Modal stacking, drag regions and the header, on one launch
// ---------------------------------------------------------------------------

/** The longest name the chip will show in full is far shorter (max-w-40). */
const LONG_WORKSPACE = 'acme-corporation-production-billing-eu-west';
/** What a dev build's header shows for a branch with an open PR. */
const LONG_PR = {
  url: 'https://github.com/etiennechabert/cost-goblin/pull/4242',
  title: 'fix(ui): keep every modal, popover and header button clickable whatever opens underneath',
  number: 4242,
};

test.describe('Clickability (workspace mode)', () => {
  let app: ElectronApplication | undefined;
  let page: Page | undefined;
  let opened: string[];

  function launched(): { app: ElectronApplication; page: Page } {
    if (app === undefined || page === undefined) throw new Error('app not launched');
    return { app, page };
  }

  test.beforeAll(async () => {
    const seeded = seedWorkspaces(LONG_WORKSPACE, 'client-b');
    ({ app, page } = await launchWorkspaceApp(seeded.runRoot, seeded.userDataDir));
    opened = await stubOpenExternal(app, page);
    // The header's build indicator: packaged builds show the version, a dev
    // checkout its branch, upgraded to the PR when `gh` finds one. Serve a
    // long PR from main and reload, so the renderer asks again on mount.
    await app.evaluate(({ ipcMain }, pr) => {
      ipcMain.removeHandler('debug:get-branch-pr');
      ipcMain.handle('debug:get-branch-pr', () => pr);
    }, LONG_PR);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Cost Overview' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('link', { name: /#4242/ })).toBeVisible();
  });

  test.afterEach(async () => {
    // Leave no modal or popover open and the viewport at the window's size,
    // so one failure doesn't cascade into the tests after it.
    if (app === undefined || page === undefined || page.isClosed()) return;
    for (let i = 0; i < 4 && await page.locator('[role=dialog], [role=menu], [data-radix-popper-content-wrapper]').count() > 0; i++) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(150);
    }
    await setViewport(page, 1280, 800);
  });

  test.afterAll(async () => {
    await finishCoverage(app, page, 'clickability');
  });

  test('runs with cloud credential discovery sandboxed', async () => {
    await expectCloudSandboxed(launched().app);
  });

  test('the header controls stay clickable down to the minimum width', async () => {
    const { page: p } = launched();
    // The region model is live: an empty spot of the header drags the window.
    const width = await p.evaluate(() => globalThis.innerWidth);
    const blank = await headerGrid(p).evaluate(probePoints, { selector: null, points: [{ x: width / 2, y: 6 }] });
    expect(blank.map(r => `${String(r.onTarget)} ${r.region}`)).toEqual(['true drag']);

    const leftNav = p.getByRole('navigation', { name: 'Dashboards and analysis' });
    const states: readonly { readonly name: string; readonly enter: () => Promise<void> }[] = [
      {
        name: 'default dashboard',
        enter: async () => {
          await ensureViewMode(p);
          await leftNav.getByRole('button', { name: 'Home' }).click({ timeout: 5_000 });
          await expect(leftNav.getByRole('button', { name: 'Dashboards' })).toHaveText(/Dashboards/);
        },
      },
      ...['Baselines', 'Explorer'].map(label => ({
        name: `${label} active`,
        enter: async () => {
          await ensureViewMode(p);
          await leftNav.getByRole('button', { name: label }).click({ timeout: 5_000 });
          await expect(leftNav.locator('button[aria-current="page"]')).toHaveText(label);
        },
      })),
      {
        name: 'settings',
        enter: async () => {
          await openSettings(p);
          await expect(p.getByRole('button', { name: 'Done, return to dashboards' })).toBeVisible();
        },
      },
    ];
    for (const w of [900, 1024, 1100]) {
      await setViewport(p, w, 700);
      for (const state of states) {
        await state.enter();
        await expect(p.getByRole('link', { name: /#4242/ })).toBeVisible();
        await expect(p.getByTestId('workspace-chip')).toBeVisible();
        const reports = await headerGrid(p).evaluate(probePoints, { selector: 'button, a[href]', points: null });
        // Five points per control: at least Done (or Home, Dashboards and the
        // analysis pages), the PR link, the chip, and debug / reload / sync /
        // rollup / settings.
        expect(reports.length, `${String(w)}px, ${state.name}: header points probed`).toBeGreaterThanOrEqual(8 * 5);
        expect(problemsOf(reports), `${String(w)}px, ${state.name}`).toEqual([]);
      }
    }
    await ensureViewMode(p);
  });

  test('the Dashboards popover\'s first row is clear of the header drag region', async () => {
    const { page: p } = launched();
    await ensureViewMode(p);
    await p.getByRole('navigation', { name: 'Dashboards and analysis' }).getByRole('button', { name: 'Home' }).click();
    await openDashboardsDropdown(p);
    const firstRow = p.getByRole('menu').locator('li').first();
    await expectClickable(p, firstRow.getByRole('menuitem'));
    await expectClickable(p, firstRow.getByRole('button').first());
    await p.keyboard.press('Escape');
  });

  // It used to double as Home: from anywhere but the default dashboard (another
  // dashboard, or a page like Trends) the first click went back to the default
  // one instead of opening the list. The goblin is Home. The fixtures hold a
  // single dashboard, so this starts from Trends — the same branch.
  test('the Dashboards button opens its list from any page', async () => {
    const { page: p } = launched();
    await ensureViewMode(p);
    const nav = p.getByRole('navigation', { name: 'Dashboards and analysis' });
    await nav.getByRole('button', { name: 'Trends' }).click();
    const trends = nav.getByRole('button', { name: 'Trends' });
    await expect(trends).toHaveAttribute('aria-current', 'page');

    const trigger = nav.getByRole('button', { name: 'Dashboards' });
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(trends).toHaveAttribute('aria-current', 'page');

    await p.getByRole('menu').getByRole('menuitem', { name: 'Cost Overview' }).click();
    await expect(p.getByRole('menu')).toHaveCount(0);
    await expect(p.getByRole('heading', { name: 'Cost Overview' })).toBeVisible();
  });

  test('an update arriving under the switch confirm waits for it to close', async () => {
    const { app: electron, page: p } = launched();
    await ensureViewMode(p);
    // Short window: the confirm's backdrop covers the header's drag band.
    await setViewport(p, 900, 600);
    const confirm = await openSwitchConfirm(p, 'client-b');
    await pushUpdateStatus(electron, UPDATE_AVAILABLE);
    await expectUpdateDeferred(p);

    await expectClickable(p, confirm.getByRole('button', { name: 'Switch & Restart' }));
    await expectClickable(p, confirm.getByRole('button', { name: 'Cancel' }));
    // A backdrop click over the header dismisses; it must not drag the window.
    const headerBottom = await headerGrid(p).evaluate(e => e.getBoundingClientRect().bottom);
    const band = [
      { x: 8, y: 8 },
      { x: 450, y: headerBottom / 2 },
      { x: 892, y: headerBottom - 4 },
    ];
    const backdrop = await p.getByTestId('modal-backdrop').evaluate(probePoints, { selector: null, points: band });
    expect(problemsOf(backdrop)).toEqual([]);

    // Cancel closes the confirm, and only then does the update dialog open.
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toHaveCount(0);
    const notes = p.getByRole('dialog', { name: /Update Available — v9\.9\.9/ });
    await expect(notes).toBeVisible();
    await expect(notes.getByRole('link', { name: /pull\/600/ })).toBeVisible();
    await expectClickable(p, notes.getByRole('button', { name: 'Dismiss' }));

    // With the update dialog up, Cmd+K opens nothing beneath it — the palette's
    // navigations (switch workspace, leave a dirty view) open modals.
    await p.keyboard.press('Meta+k');
    await p.waitForTimeout(300);
    await expect(p.getByPlaceholder(PALETTE_INPUT)).toHaveCount(0);
    await notes.getByRole('button', { name: 'Dismiss' }).click();
    await expect(notes).toHaveCount(0);
    // ...and still opens it once nothing else is open.
    await p.keyboard.press('Meta+k');
    await expect(p.getByPlaceholder(PALETTE_INPUT)).toBeVisible();
    await p.keyboard.press('Escape');
    await expect(p.getByPlaceholder(PALETTE_INPUT)).toHaveCount(0);

    expect(opened).toEqual([]);
  });

  test('the gear opens General while it shows the update dot, Data & Sync otherwise', async () => {
    const { app: electron, page: p } = launched();
    await ensureViewMode(p);
    const activeTab = p.getByRole('navigation', { name: SETTINGS_NAV_LABEL }).locator('button[aria-current="page"]');
    // Self-contained: re-pushing the update the test above leaves is a no-op,
    // but run alone (-g) it is the session's first, which auto-opens the
    // release notes once — dismiss them so they do not cover the gear.
    await pushUpdateStatus(electron, UPDATE_AVAILABLE);
    const gear = gearWithUpdate(p);
    await expect(gear).toHaveCount(1);
    await p.waitForTimeout(300);
    const notes = p.getByRole('dialog', { name: /Update Available — v9\.9\.9/ });
    if (await notes.count() > 0) {
      await notes.getByRole('button', { name: 'Dismiss' }).click();
      await expect(notes).toHaveCount(0);
    }
    await gear.click();
    await expect(activeTab).toHaveText('General');
    await expect(p.getByRole('button', { name: 'v9.9.9 available' })).toBeVisible();

    await ensureViewMode(p);
    await pushUpdateStatus(electron, { state: 'idle' });
    await expect(gearWithUpdate(p)).toHaveCount(0);
    await openSettings(p);
    await expect(activeTab).toHaveText('Data & Sync');
    await ensureViewMode(p);
  });

  // The update modal renders nothing while a check runs. Its open flag must
  // not survive that, or the next failure re-mounts it open without asking
  // whether another modal is up.
  test('after Retry, a new update failure still waits for the open confirm', async () => {
    const { app: electron, page: p } = launched();
    // Retry asks main for a check: answer with the status a real one starts with.
    await electron.evaluate(({ BrowserWindow, ipcMain }) => {
      ipcMain.removeHandler('update:check');
      ipcMain.handle('update:check', () => {
        for (const win of BrowserWindow.getAllWindows()) win.webContents.send('update:status-changed', { state: 'checking' });
      });
    });
    // General shows the updater's state even under a modal, so each push can
    // be seen to have landed.
    await clickNavButton(p, 'General');
    await expect(p.getByRole('button', { name: 'Check for updates' })).toBeVisible();

    await pushUpdateStatus(electron, UPDATE_CHECK_FAILED);
    const failed = p.getByRole('dialog', { name: 'Update failed' });
    await expect(failed).toBeVisible();
    const retry = failed.getByRole('button', { name: 'Retry' });
    await expectClickable(p, retry);
    await retry.click();
    await expect(failed).toHaveCount(0);
    await expect(p.getByText('Checking…', { exact: true })).toBeVisible();

    const confirm = await openSwitchConfirm(p, 'client-b');
    await pushUpdateStatus(electron, UPDATE_CHECK_FAILED);
    // Hidden from the accessibility tree by the confirm, so found by text.
    await expect(p.getByText('Retry update check')).toBeVisible();
    await p.waitForTimeout(300);
    await expect(p.locator('[role=dialog]', { hasText: 'Update failed' })).toHaveCount(0);
    await expectClickable(p, confirm.getByRole('button', { name: 'Cancel' }));

    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(failed).toBeVisible();
    const close = failed.getByRole('button', { name: 'Close', exact: true });
    await expectClickable(p, close);
    await close.click();
    await expect(failed).toHaveCount(0);
    await ensureViewMode(p);
    expect(opened).toEqual([]);
  });

  test('the Add Provider wizard is reachable at the minimum window size', async () => {
    const { page: p } = launched();
    await setViewport(p, 900, 600);
    await clickNavButton(p, 'Sync');
    await p.getByRole('button', { name: 'Add Provider', exact: true }).click();
    const wizard = p.getByRole('dialog', { name: 'Add provider' });
    const close = wizard.getByRole('button', { name: 'Close', exact: true });
    await expect(wizard).toBeVisible();
    // Hosted in the modal, the wizard is just its card: no drag region
    // anywhere inside, so the ✕ can't lose to one. And the modal opens at the
    // top, with the ✕ — which pokes out above the card — fully in view.
    const backdrop = p.getByTestId('modal-backdrop');
    expect(await backdrop.evaluate(dragRegionsWithin)).toEqual([]);
    await expectClickable(p, close);

    // The tallest first step: the Google Cloud intro.
    await wizard.getByLabel('Set up from Google Cloud').click();
    await expect(wizard.getByLabel('Google Cloud project')).toBeVisible();
    expect(await backdrop.evaluate(dragRegionsWithin)).toEqual([]);
    await expectClickable(p, close);
    await expectClickable(p, wizard.getByRole('button', { name: 'Back to start' }));

    // Continue is pointer-events-none until there is a project to check.
    await wizard.getByLabel('Google Cloud project').fill('my-billing-project');
    const next = wizard.getByRole('button', { name: 'Continue', exact: true });
    await expect(next).toBeEnabled();

    // A card taller than the window scrolls in the overlay, by wheel.
    const back = wizard.getByRole('button', { name: '← Back' });
    await p.mouse.move(450, 300);
    await p.mouse.wheel(0, 2_000);
    const overflows = await backdrop.evaluate(e => e.scrollHeight > e.clientHeight);
    if (overflows) await expect.poll(() => backdrop.evaluate(e => e.scrollTop)).toBeGreaterThan(0);
    await expect.poll(() => back.evaluate(e => {
      const box = e.getBoundingClientRect();
      return box.top >= 0 && box.bottom <= globalThis.innerHeight;
    })).toBe(true);
    await expectClickable(p, back);
    await expectClickable(p, next);

    await back.click();
    await expect(wizard.getByText('Which cloud are you billing on?')).toBeVisible();
    await close.click();
    await expect(wizard).toHaveCount(0);
  });

  test('the baseline detail\'s ← / → sit clear of the header drag region', async () => {
    const { page: p } = launched();
    await ensureViewMode(p);
    await p.getByRole('navigation', { name: 'Dashboards and analysis' }).getByRole('button', { name: 'Baselines' }).click();
    await p.getByRole('button', { name: 'New baseline' }).click();
    const create = p.getByRole('dialog', { name: 'New baseline' });
    await create.getByPlaceholder('e.g. Amazon Relational Database Service').fill('Amazon Elastic Compute Cloud');
    await create.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(create).toHaveCount(0);

    await p.getByRole('button', { name: 'Amazon Elastic Compute Cloud' }).first().click();
    // The dialog is as tall as the window allows (90vh), so its top row sits
    // in the header's band.
    const prev = p.getByRole('button', { name: 'Previous baseline (←)' });
    await expect(prev).toBeVisible({ timeout: 10_000 });
    await expectClickable(p, prev);
    await expectClickable(p, p.getByRole('button', { name: 'Next baseline (→)' }));
    await p.keyboard.press('Escape');
  });

  test('every button shows the pointer, and a state layer on hover and press', async () => {
    const { page: p } = launched();
    await ensureViewMode(p);
    await p.getByRole('navigation', { name: 'Dashboards and analysis' }).getByRole('button', { name: 'Home' }).click();
    await expect(p.getByRole('heading', { name: 'Cost Overview' })).toBeVisible();
    // Tailwind v4 leaves controls on the arrow cursor (app.css restores the
    // pointer); only a component's own cursor, such as a drag grip's, replaces it.
    const onArrow = (): Promise<string[]> => p.evaluate(() => [...document.querySelectorAll('button')]
      .filter(b => !b.disabled && b.getClientRects().length > 0)
      .filter(b => {
        const cursor = getComputedStyle(b).cursor;
        return cursor === 'auto' || (cursor === 'default' && !b.classList.contains('cursor-default'));
      })
      .map(b => b.getAttribute('aria-label') ?? b.textContent.trim()));
    expect(await onArrow()).toEqual([]);
    // Disabled items lose it: Radix marks them with an empty data-disabled,
    // cmdk with "true", and cmdk writes "false" on every enabled item.
    const optionCursor = await p.evaluate(() => {
      const probe = (disabled: string): string => {
        const el = document.createElement('div');
        el.setAttribute('role', 'option');
        el.setAttribute('data-disabled', disabled);
        document.body.append(el);
        const cursor = getComputedStyle(el).cursor;
        el.remove();
        return cursor;
      };
      return { enabled: probe('false'), cmdkDisabled: probe('true'), radixDisabled: probe('') };
    });
    expect(optionCursor).toEqual({ enabled: 'pointer', cmdkDisabled: 'auto', radixDisabled: 'auto' });

    // A hover tints the button, a press tints it more: the click shows it landed.
    const button = p.getByRole('navigation', { name: 'Dashboards and analysis' }).getByRole('button', { name: 'Baselines' });
    const layer = (): Promise<string> => button.evaluate(el => getComputedStyle(el).backgroundImage);
    await p.mouse.move(640, 700);
    await expect.poll(layer).toBe('none');
    await button.hover();
    await expect.poll(layer).toMatch(/^linear-gradient/);
    const hovered = await layer();
    await p.mouse.down();
    await expect.poll(layer).not.toBe(hovered);
    expect(await layer()).toMatch(/^linear-gradient/);
    // Released elsewhere, so nothing is clicked.
    await p.mouse.move(640, 700);
    await p.mouse.up();

    // A chart plot that takes a drag selection is a role=button too, and
    // draws its own selection: no state layer over the whole plot.
    const plot = p.locator('[role="button"].cursor-crosshair').first();
    await plot.hover();
    expect(await plot.evaluate(el => getComputedStyle(el).backgroundImage)).toBe('none');

    // The settings rail and a settings page with many kinds of control.
    await openSettings(p);
    await p.getByRole('navigation', { name: SETTINGS_NAV_LABEL }).getByRole('button', { name: 'Dimensions' }).click();
    await expect(p.getByRole('heading', { name: 'Dimensions', exact: true })).toBeVisible();
    expect(await onArrow()).toEqual([]);
  });
});
