import { expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';

export const ROOT = join(import.meta.dirname, '..');
export const DESKTOP_DIR = join(ROOT, 'packages', 'desktop');
export const SCREENSHOT_DIR = join(tmpdir(), 'costgoblin-e2e');
export const V8_DIR = join(tmpdir(), 'costgoblin-e2e-v8');
mkdirSync(SCREENSHOT_DIR, { recursive: true });
mkdirSync(V8_DIR, { recursive: true });

export const LOAD_TIMEOUT = 5_000;

const DEFAULT_DATA_DIR = join(homedir(), 'Library', 'Application Support', '@costgoblin', 'desktop', 'data');
const DEFAULT_CONFIG_DIR = join(homedir(), 'Library', 'Application Support', '@costgoblin', 'desktop', 'config');
export const FIXTURE_DATA_DIR = join(ROOT, 'packages', 'core', 'src', '__fixtures__', 'synthetic');
export const FIXTURE_CONFIG_DIR = join(ROOT, 'packages', 'core', 'src', '__fixtures__', 'config');

export function launchApp(overrides?: { configDir?: string }): Promise<ElectronApplication> {
  const dataDir = process.env['COSTGOBLIN_DATA_DIR'] ?? DEFAULT_DATA_DIR;
  const configDir = overrides?.configDir ?? process.env['COSTGOBLIN_CONFIG_DIR'] ?? DEFAULT_CONFIG_DIR;
  return _electron.launch({
    args: [join(DESKTOP_DIR, 'out', 'main', 'main.js')],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      COSTGOBLIN_DATA_DIR: dataDir,
      COSTGOBLIN_CONFIG_DIR: configDir,
    },
  });
}

export async function startCoverage(page: Page): Promise<void> {
  try {
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
  } catch {
    // coverage API may not be available
  }
}

export async function stopAndCollectCoverage(page: Page, allCoverage: unknown[]): Promise<void> {
  try {
    const coverage = await page.coverage.stopJSCoverage();
    allCoverage.push(...coverage);
  } catch {
    // coverage API may not be available
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

// Click a nav button, wait for the destination heading, and let initial
// queries settle. Shared app launch means each describe block navigates
// between views via clicks instead of relaunching Electron.
export async function navigateTo(page: Page, buttonName: string, headingName: string): Promise<void> {
  await page.getByRole('button', { name: buttonName, exact: true }).first().click();
  await expect(page.getByRole('heading', { name: headingName, exact: true })).toBeVisible({ timeout: 5000 });
  await waitForQuerySettle(page);
}

export function writeCoverage(shardName: string, allCoverage: unknown[]): void {
  if (allCoverage.length > 0) {
    writeFileSync(join(V8_DIR, `coverage-${shardName}.json`), JSON.stringify(allCoverage));
  }
}
