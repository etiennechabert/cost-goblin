import { test, expect, type ConsoleMessage, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertNoReactCrash,
  clickNavButton,
  ensureViewMode,
  FIXTURE_CONFIG_DIR,
  FIXTURE_DATA_DIR,
  launchApp,
  selectDatePreset,
  waitForQuerySettle,
} from './helpers.js';

/**
 * UI monkey — Phase 2 of the fuzz effort (Layer 4: real Electron app).
 *
 * Drives the actual app by clicking/toggling random controls from the
 * accessibility tree, hunting for crashes the param fuzzer (Layer 2) can't see:
 * render crashes, rapid-navigation cancellation races, prefs-file write races,
 * widget-scheduler saturation. It is a CRASH oracle, not a correctness oracle —
 * it asserts the app never dies, never fires its React error boundary, and never
 * throws an uncaught page error; it cannot judge whether a number is right.
 *
 * Reproducibility: every click is driven by a seeded PRNG and appended to an
 * action log that is dumped on failure. The DOM is dynamic so replay is a strong
 * lead, not a guarantee — pair the log with the seed.
 *
 * Run it (opt-in — NOT part of the CI `e2e` gate, to keep that deterministic):
 *   FUZZ_ACTIONS=150 npm run e2e:fuzz                 # default-ish soak
 *   FUZZ_SEED=12345 FUZZ_ACTIONS=500 npm run e2e:fuzz # replay / longer soak
 */

// --- seeded PRNG (inline so the e2e dir stays self-contained) ---------------
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Controls that open native dialogs, hit the network, or mutate persisted state
// destructively — skipped so the monkey stays in the safe exploratory surface
// (navigation, toggles, filters, sorts, date presets) and never hangs on an OS
// file picker Playwright can't dismiss.
const DENYLIST =
  /sync|import|export|delete|remove|reload|refresh|login|sso|sign in|\bopen\b|browse|choose|upload|download|\bsave\b|connect|add server|quit|update|install|reset/i;

const CANDIDATE_SELECTOR = [
  'button',
  '[role="menuitem"]',
  '[role="tab"]',
  '[role="switch"]',
  '[role="radio"]',
  '[role="checkbox"]',
  'th',
  '[role="columnheader"]',
].join(', ');

const SAFE_NAV = ['Trends', 'Tags', 'Findings', 'Explorer', 'Dashboards'];
const DATE_PRESETS = ['Last 7 days', 'Last 30 days', 'Last 90 days', 'This month', 'Last month'];

const ACTIONS = Number.parseInt(process.env['FUZZ_ACTIONS'] ?? '150', 10);
const SEED = Number.parseInt(process.env['FUZZ_SEED'] ?? String(Date.now() & 0xffffffff), 10);

function pickIndex(rng: () => number, length: number): number {
  return Math.floor(rng() * length);
}

async function nameOf(el: Locator): Promise<string> {
  const aria = await el.getAttribute('aria-label').catch(() => null);
  if (aria !== null && aria.length > 0) return aria;
  const text = await el.textContent().catch(() => null);
  return (text ?? '').trim();
}

async function clickRandomControl(page: Page, rng: () => number, log: string[]): Promise<void> {
  const targets = await page.locator(CANDIDATE_SELECTOR).all();
  if (targets.length === 0) return;
  for (let attempt = 0; attempt < 6; attempt++) {
    const el = targets[pickIndex(rng, targets.length)];
    if (el === undefined) continue;
    if (!(await el.isVisible().catch(() => false))) continue;
    const name = await nameOf(el);
    if (DENYLIST.test(name)) continue;
    log.push(`click: ${name.slice(0, 48) || '<unnamed>'}`);
    await el.click({ timeout: 1200 }).catch(() => undefined);
    return;
  }
}

async function navigateRandom(page: Page, rng: () => number, log: string[]): Promise<void> {
  const target = SAFE_NAV[pickIndex(rng, SAFE_NAV.length)] ?? 'Dashboards';
  log.push(`nav: ${target}`);
  await clickNavButton(page, target).catch(() => undefined);
}

async function pickRandomDate(page: Page, rng: () => number, log: string[]): Promise<void> {
  const preset = DATE_PRESETS[pickIndex(rng, DATE_PRESETS.length)] ?? 'Last 30 days';
  log.push(`date: ${preset}`);
  await selectDatePreset(page, preset).catch(() => undefined);
}

let app: ElectronApplication;
let page: Page;
const pageErrors: string[] = [];
const consoleErrors: string[] = [];

// Isolated, throwaway dirs seeded from the committed fixtures. The monkey
// toggles settings that persist — config (dimensions, theme) lands in the config
// dir, and prefs (explorer-preferences.json) land in dirname(dataDir). Both are
// copies so a soak never dirties the working tree.
const MONKEY_TMP = join(tmpdir(), 'costgoblin-e2e-fuzz-monkey');
const MONKEY_CONFIG_DIR = join(MONKEY_TMP, 'config');
const MONKEY_DATA_DIR = join(MONKEY_TMP, 'data');

test.beforeAll(async () => {
  rmSync(MONKEY_TMP, { recursive: true, force: true });
  mkdirSync(MONKEY_TMP, { recursive: true });
  cpSync(FIXTURE_CONFIG_DIR, MONKEY_CONFIG_DIR, { recursive: true });
  // Isolate the data dir too (prefs are written to its parent) unless the caller
  // pinned a real one for a soak against live data.
  if (process.env['COSTGOBLIN_DATA_DIR'] === undefined) {
    cpSync(FIXTURE_DATA_DIR, MONKEY_DATA_DIR, { recursive: true });
    process.env['COSTGOBLIN_DATA_DIR'] = MONKEY_DATA_DIR;
  }
  app = await launchApp({ configDir: MONKEY_CONFIG_DIR });
  page = await app.firstWindow();
  await expect(page).toHaveTitle('CostGoblin');
  page.on('pageerror', err => pageErrors.push(err.message));
  page.on('crash', () => pageErrors.push('renderer process crashed'));
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  // Native dialogs would hang the run; dismiss any page-level dialog defensively.
  page.on('dialog', d => void d.dismiss().catch(() => undefined));
});

test.afterAll(async () => {
  await app.close();
  rmSync(MONKEY_TMP, { recursive: true, force: true });
});

test.describe('UI monkey', () => {
  test('clicks randomly through the app without crashing', async () => {
    test.setTimeout(ACTIONS * 2_500 + 60_000);
    const rng = makeRng(SEED);
    const log: string[] = [`seed=${SEED} actions=${ACTIONS}`];

    for (let i = 0; i < ACTIONS; i++) {
      const roll = rng();
      if (roll < 0.12) await navigateRandom(page, rng, log);
      else if (roll < 0.2) await pickRandomDate(page, rng, log);
      else await clickRandomControl(page, rng, log);

      await waitForQuerySettle(page);

      // Escape hatch: periodically close any stuck popover/modal and return to
      // view mode so the monkey doesn't wedge itself in a corner of the UI.
      if (i % 25 === 24) {
        await page.keyboard.press('Escape').catch(() => undefined);
        await ensureViewMode(page).catch(() => undefined);
      }

      if (pageErrors.length > 0) {
        throw new Error(`page error after ${i + 1} actions:\n  ${pageErrors.join('\n  ')}\n\naction log:\n${log.join('\n')}`);
      }
      // assertNoReactCrash throws with detail if the error boundary fired.
      await assertNoReactCrash(page);
    }

    expect(page.isClosed(), `app window closed unexpectedly\n\naction log:\n${log.join('\n')}`).toBe(false);

    if (consoleErrors.length > 0) {
      // Non-fatal: surfaced for triage, not asserted (console errors include
      // benign warnings). A spike here is still worth a look.
      test.info().annotations.push({ type: 'console-errors', description: `${consoleErrors.length} console error(s); first: ${consoleErrors[0] ?? ''}` });
    }
  });
});
