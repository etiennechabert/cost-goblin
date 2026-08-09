import { expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { join } from 'node:path';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

export const ROOT = join(import.meta.dirname, '..');
export const DESKTOP_DIR = join(ROOT, 'packages', 'desktop');
export const SCREENSHOT_DIR = join(tmpdir(), 'costgoblin-e2e');
export const V8_DIR = join(tmpdir(), 'costgoblin-e2e-v8');
mkdirSync(SCREENSHOT_DIR, { recursive: true });
mkdirSync(V8_DIR, { recursive: true });

export const LOAD_TIMEOUT = 5_000;

export const FIXTURE_DATA_DIR = join(ROOT, 'packages', 'core', 'src', '__fixtures__', 'synthetic');
export const FIXTURE_CONFIG_DIR = join(ROOT, 'packages', 'core', 'src', '__fixtures__', 'config');
/** Same synthetic data tree, but a config listing BOTH provider arms. The
 *  baseline config above names only `aws-main`, so the `gcp-main/` directory in
 *  the tree is invisible to every other suite's totals. */
export const FIXTURE_MULTI_CONFIG_DIR = join(ROOT, 'packages', 'core', 'src', '__fixtures__', 'config-multi');

/** "Today" for every app launched by `launchApp`: the day after the fixture
 *  window (generate.ts pins 2026-01-01..2026-03-01), so relative presets like
 *  "Last 30 days" resolve to dates that actually hold fixture data. The app
 *  honours it via COSTGOBLIN_NOW (see packages/desktop/src/renderer/fake-clock.ts). */
export const FIXTURE_NOW = '2026-03-02T12:00:00Z';

// Per-launch temp root, keyed by the app it was created for, so closeApp can
// delete the throwaway fixture copy on teardown.
const RUN_ROOTS = new WeakMap<ElectronApplication, string>();

export async function launchApp(overrides?: { configDir?: string; dataDir?: string }): Promise<ElectronApplication> {
  const dataDir = overrides?.dataDir ?? process.env['COSTGOBLIN_DATA_DIR'] ?? FIXTURE_DATA_DIR;
  const configDir = overrides?.configDir ?? process.env['COSTGOBLIN_CONFIG_DIR'] ?? FIXTURE_CONFIG_DIR;
  // Pinned mode writes app state NEXT TO the data dir (stateDir =
  // dirname(dataDir), see desktop's workspace-env.ts) and edits config in
  // place, so launching straight against the committed fixtures dirties the
  // repo — that's how __fixtures__/explorer-preferences.json ended up
  // committed. Copy both dirs into a throwaway root per launch: state lands
  // there, and no test click ("Delete All Data", the config editors) can
  // reach the committed files.
  const runRoot = mkdtempSync(join(tmpdir(), 'costgoblin-e2e-run-'));
  const runDataDir = join(runRoot, 'data');
  const runConfigDir = join(runRoot, 'config');
  cpSync(dataDir, runDataDir, { recursive: true });
  cpSync(configDir, runConfigDir, { recursive: true });
  const app = await _electron.launch({
    args: [join(DESKTOP_DIR, 'out', 'main', 'main.js')],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      COSTGOBLIN_E2E: '1',
      COSTGOBLIN_NOW: process.env['COSTGOBLIN_NOW'] ?? FIXTURE_NOW,
      COSTGOBLIN_DATA_DIR: runDataDir,
      COSTGOBLIN_CONFIG_DIR: runConfigDir,
    },
  });
  RUN_ROOTS.set(app, runRoot);
  return app;
}

/** Close, but never let a stalled Electron exit fail a suite. Under system
 *  load the process occasionally wedges on quit behind boot-time DuckDB work
 *  (a known flake — see the coverage-ordering comments in stress/gcp); after
 *  15s give up and SIGKILL. Per-launch state is a throwaway temp dir, so a
 *  hard kill loses nothing. Every suite must use this instead of a bare
 *  app.close() so the guard covers the DuckDB-heavy shards too, and so the
 *  per-launch fixture copy is removed rather than leaked into $TMPDIR. */
export async function closeApp(app: ElectronApplication): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closed = await Promise.race([
    app.close().then(() => true, () => true),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => { resolve(false); }, 15_000); }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (!closed) app.process().kill('SIGKILL');
  const runRoot = RUN_ROOTS.get(app);
  if (runRoot !== undefined) {
    RUN_ROOTS.delete(app);
    rmSync(runRoot, { recursive: true, force: true });
  }
}

export async function startCoverage(page: Page): Promise<void> {
  try {
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
  } catch (err) {
    // Coverage must never fail a suite, but a silent miss hides a broken
    // pipeline for the whole shard — leave a trace in the runner log.
    console.warn(`[coverage] startJSCoverage unavailable: ${String(err)}`);
  }
}

export async function stopAndCollectCoverage(page: Page, allCoverage: unknown[]): Promise<void> {
  try {
    const coverage = await page.coverage.stopJSCoverage();
    allCoverage.push(...coverage);
  } catch (err) {
    // Same trade-off as startCoverage: swallow, but never silently.
    console.warn(`[coverage] stopJSCoverage failed: ${String(err)}`);
  }
}

export async function screenshot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(SCREENSHOT_DIR, `${name}.png`) });
}

export async function assertNoReactCrash(page: Page): Promise<void> {
  const crashed = await page.getByText('Something went wrong').isVisible().catch(() => false);
  if (crashed) {
    const detail = await page.locator('text=/Rendered|Error|Cannot/').first().textContent().catch(() => 'unknown');
    throw new Error(`React error boundary fired: ${detail ?? 'unknown'}`);
  }
}

export async function waitForQuerySettle(page: Page): Promise<void> {
  // Wait for any "Loading" text to disappear, or time out gracefully.
  // Views may show errors instead of data — that's fine, we just need the query cycle to finish.
  try {
    await expect(page.getByText('Loading', { exact: false }).first()).toBeHidden({ timeout: LOAD_TIMEOUT });
  } catch {
    // Loading text might never have appeared (instant response or error)
  }
  // small settle for rendering
  await page.waitForTimeout(300);
  // catch React crashes that happened during query/render cycle
  await assertNoReactCrash(page);
}

/** Wait for the Cost Scope preview to finish its debounced first load. The
 *  preview effect debounces 300ms and then runs several IPC queries
 *  serially (per-rule + totals + daily + sample + count). Polling for the
 *  in-header "loading…" marker to disappear is the only reliable settle
 *  signal — waitForQuerySettle's generic "Loading" check doesn't fire here
 *  because the preview uses its own marker to stay scoped to this view. */
export async function waitForCostScopePreview(page: Page): Promise<void> {
  // The marker only appears once the first debounce fires (~300ms). Give
  // it a little room to show up before checking for its disappearance.
  await page.waitForTimeout(400);
  const marker = page.getByTestId('preview-loading');
  try {
    await expect(marker).toBeHidden({ timeout: LOAD_TIMEOUT });
  } catch {
    // Marker may have finished before we attached the locator; that's fine.
  }
  await page.waitForTimeout(200);
  await assertNoReactCrash(page);
}

export async function hasVisibleData(page: Page): Promise<boolean> {
  // Check if there are any table rows with dollar amounts
  const dollarCells = page.locator('.tabular-nums');
  const count = await dollarCells.count();
  if (count === 0) return false;
  const text = await dollarCells.first().textContent();
  return text !== null && text.includes('$') && !text.includes('$0.00');
}

/** Assert the current view has loaded real dollar data, retrying until the
 *  cost cells actually paint. `waitForQuerySettle` only waits out the shared
 *  "Loading" text (driven by the dimensions query) plus a fixed 300ms, which
 *  can race the per-widget cost queries on a slow runner — so poll rather than
 *  snapshotting `hasVisibleData` once. */
export async function expectVisibleData(page: Page): Promise<void> {
  await expect.poll(() => hasVisibleData(page), { timeout: LOAD_TIMEOUT }).toBe(true);
}

// The settings rework split the app into "view mode" (looking at cost data) and
// "setting mode" (a full-canvas SettingsShell behind a single gear). Tests reach
// for a page by its historical name; clickNavButton hides where it now lives:
//
// - View-mode pages (Trends/Findings/Tags/Explorer + custom dashboards) live in
//   the left nav / Dashboards popover, only visible while NOT in setting mode.
// - Configuration pages are tabs in the settings rail, reached by opening the
//   gear ("Settings") and clicking the tab by its registry label.
const DIRECT_NAV = new Set(['Trends', 'Findings', 'Tags', 'Explorer', 'Dashboards', 'Home']);
// Historical test name → settings rail tab label. (Views Editor is now the
// "Dashboards" tab; Sync is the "Data & Sync" tab.)
const SETTINGS_ITEMS: Record<string, string> = {
  'Cost Scope': 'Cost Scope',
  'Dimensions': 'Dimensions',
  'Views Editor': 'Dashboards',
  'AI Assistant': 'AI Assistant',
  'Sync': 'Data & Sync',
  'General': 'General',
  'Share': 'Share',
  'Import': 'Import',
  'Performance': 'Performance',
  'Workspaces': 'Workspaces',
};
const NAV_ALIASES: Record<string, string> = { Views: 'Views Editor' };
// Both top-bar <nav> elements have aria-labels — scope direct-nav lookups
// to them so we never pick up a same-named button living inside a view
// (e.g. "Sync region names" in DataManagement, "Trends" in some chart).
const LEFT_NAV_LABEL = 'Dashboards and analysis';
const RIGHT_NAV_LABEL = 'Sync and settings';
export const SETTINGS_NAV_LABEL = 'Settings sections';
const NAV_SIDE: Record<string, 'left' | 'right'> = {
  Trends: 'left', Findings: 'left', Tags: 'left', Explorer: 'left',
  Dashboards: 'left', Home: 'left',
};

async function openIfClosed(trigger: ReturnType<Page['getByRole']>): Promise<void> {
  // Radix Popover toggles open/closed on each trigger click. If a previous
  // test or step left the popover open, clicking again would CLOSE it and
  // the subsequent menu-item lookup would time out. Check aria-expanded
  // first.
  const expanded = await trigger.getAttribute('aria-expanded').catch(() => null);
  if (expanded === 'true') return;
  await trigger.click();
}

function topNav(page: Page, side: 'left' | 'right'): ReturnType<Page['getByRole']> {
  return page.getByRole('navigation', { name: side === 'left' ? LEFT_NAV_LABEL : RIGHT_NAV_LABEL });
}

function settingsGear(page: Page): ReturnType<Page['getByRole']> {
  return topNav(page, 'right').getByRole('button', { name: 'Settings', exact: true });
}

/** Enter setting mode (open the gear) if not already in it. Idempotent: the gear
 *  reflects its state via aria-expanded, so we never accidentally toggle out. */
export async function openSettings(page: Page): Promise<void> {
  const gear = settingsGear(page);
  const expanded = await gear.getAttribute('aria-expanded').catch(() => null);
  if (expanded !== 'true') await gear.click();
}

/** Return to view mode if currently in setting mode. Idempotent. */
export async function ensureViewMode(page: Page): Promise<void> {
  const gear = settingsGear(page);
  const expanded = await gear.getAttribute('aria-expanded').catch(() => null);
  if (expanded === 'true') await gear.click();
}

export async function openDashboardsDropdown(page: Page): Promise<void> {
  const trigger = topNav(page, 'left').getByRole('button', { name: 'Dashboards', exact: false }).first();
  // The Dashboards trigger now doubles as a Home button: if the user isn't
  // on the default dashboard, the first click navigates there instead of
  // opening the popover. Click once, see whether the popover actually
  // opened, and click again if not.
  await openIfClosed(trigger);
  const expanded = await trigger.getAttribute('aria-expanded').catch(() => null);
  if (expanded !== 'true') await trigger.click();
}

export async function clickNavButton(page: Page, name: string): Promise<void> {
  const resolved = NAV_ALIASES[name] ?? name;
  const railLabel = SETTINGS_ITEMS[resolved];
  if (railLabel !== undefined) {
    await openSettings(page);
    await page.getByRole('navigation', { name: SETTINGS_NAV_LABEL })
      .getByRole('button', { name: railLabel, exact: true }).click();
    return;
  }
  // View-mode target — leave setting mode first so the left nav / Dashboards
  // popover is on screen.
  await ensureViewMode(page);
  if (DIRECT_NAV.has(resolved)) {
    const side = NAV_SIDE[resolved] ?? 'left';
    await topNav(page, side).getByRole('button', { name: resolved, exact: false }).first().click();
    return;
  }
  // Custom dashboard — hidden behind the Dashboards popover.
  await openDashboardsDropdown(page);
  await page.getByRole('menuitem', { name: new RegExp(resolved) }).first().click();
}

export async function navigateTo(page: Page, buttonName: string, headingName: string): Promise<void> {
  await clickNavButton(page, buttonName);
  await expect(page.getByRole('heading', { name: headingName, exact: true })).toBeVisible({ timeout: 5000 });
  await waitForQuerySettle(page);
}

export async function navigateToText(page: Page, buttonName: string, visibleText: string): Promise<void> {
  await clickNavButton(page, buttonName);
  await expect(page.getByText(visibleText, { exact: false }).first()).toBeVisible({ timeout: 5000 });
  await waitForQuerySettle(page);
}

/** Open the date picker popover and click a preset by label. */
export async function selectDatePreset(page: Page, presetLabel: string): Promise<void> {
  // The trigger is a button containing a calendar icon + current label + chevron
  const trigger = page.locator('button:has(svg.lucide-calendar)');
  await trigger.click();
  // Inside the popover, click the preset text
  await page.getByText(presetLabel, { exact: true }).click();
}

export function writeCoverage(shardName: string, allCoverage: unknown[]): void {
  if (allCoverage.length > 0) {
    writeFileSync(join(V8_DIR, `coverage-${shardName}.json`), JSON.stringify(allCoverage));
  }
}
