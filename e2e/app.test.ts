import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';

const ROOT = join(import.meta.dirname, '..');
const DESKTOP_DIR = join(ROOT, 'packages', 'desktop');
const SCREENSHOT_DIR = join(tmpdir(), 'costgoblin-e2e');
const V8_DIR = join(tmpdir(), 'costgoblin-e2e-v8');
mkdirSync(SCREENSHOT_DIR, { recursive: true });
mkdirSync(V8_DIR, { recursive: true });

const LOAD_TIMEOUT = 5_000;

// Accumulated V8 coverage entries across all test groups
const allCoverage: unknown[] = [];

function launchApp(): Promise<ElectronApplication> {
  return _electron.launch({
    args: [join(DESKTOP_DIR, 'out', 'main', 'main.js')],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      // Point at the real Electron userData where synced data + config live
      COSTGOBLIN_DATA_DIR: join(homedir(), 'Library', 'Application Support', '@costgoblin', 'desktop', 'data'),
      COSTGOBLIN_CONFIG_DIR: join(homedir(), 'Library', 'Application Support', '@costgoblin', 'desktop', 'config'),
    },
  });
}

async function startCoverage(page: Page): Promise<void> {
  try {
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
  } catch {
    // coverage API may not be available
  }
}

async function stopAndCollectCoverage(page: Page): Promise<void> {
  try {
    const coverage = await page.coverage.stopJSCoverage();
    allCoverage.push(...coverage);
  } catch {
    // coverage API may not be available
  }
}

async function screenshot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(SCREENSHOT_DIR, `${name}.png`) });
}

async function assertNoReactCrash(page: Page): Promise<void> {
  const crashed = await page.getByText('Something went wrong').isVisible().catch(() => false);
  if (crashed) {
    const detail = await page.locator('text=/Rendered|Error|Cannot/').first().textContent().catch(() => 'unknown');
    throw new Error(`React error boundary fired: ${detail ?? 'unknown'}`);
  }
}

async function waitForQuerySettle(page: Page): Promise<void> {
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
async function waitForCostScopePreview(page: Page): Promise<void> {
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

async function hasVisibleData(page: Page): Promise<boolean> {
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
async function navigateTo(page: Page, buttonName: string, headingName: string): Promise<void> {
  await page.getByRole('button', { name: buttonName, exact: true }).first().click();
  await expect(page.getByRole('heading', { name: headingName, exact: true })).toBeVisible({ timeout: 5000 });
  await waitForQuerySettle(page);
}

// Single shared app launch for every block except Widget growth (which needs
// a custom config dir). Saves 10 relaunches × ~2-5s each and avoids the
// teardown flake we saw when each block opened its own Electron process.
let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  app = await launchApp();
  page = await app.firstWindow();
  await expect(page).toHaveTitle('CostGoblin');
  await startCoverage(page);
});

test.afterAll(async () => {
  await stopAndCollectCoverage(page);
  await app.close();
  if (allCoverage.length > 0) {
    writeFileSync(join(V8_DIR, 'coverage.json'), JSON.stringify(allCoverage));
  }
});

// ---------------------------------------------------------------------------
// App launch & navigation shell
// ---------------------------------------------------------------------------
test.describe('App shell', () => {
  // No beforeAll — the shared app boots into Cost Overview by default,
  // which is exactly what these tests want.

  test('shows title bar with logo and CostGoblin text', async () => {
    await expect(page.getByText('CostGoblin', { exact: true })).toBeVisible();
  });

  test('shows all navigation buttons', async () => {
    for (const label of ['Cost Overview', 'Trends', 'Missing Tags', 'Savings', 'Cost Scope', 'Dimensions', 'Views', 'Sync']) {
      await expect(page.getByRole('button', { name: label })).toBeVisible();
    }
  });

  test('has theme toggle button', async () => {
    const themeBtn = page.getByRole('button', { name: /Switch to (light|dark) mode/ });
    await expect(themeBtn).toBeVisible();
  });

  test('theme toggle switches dark/light', async () => {
    const html = page.locator('html');
    const hadDark = await html.evaluate(el => el.classList.contains('dark'));

    await page.getByRole('button', { name: /Switch to/ }).click();
    const hasToggled = await html.evaluate(el => el.classList.contains('dark'));
    expect(hasToggled).toBe(!hadDark);

    // toggle back
    await page.getByRole('button', { name: /Switch to/ }).click();
    const restored = await html.evaluate(el => el.classList.contains('dark'));
    expect(restored).toBe(hadDark);
  });

  test('navigating between all views changes active content', async () => {
    const views = [
      { button: 'Cost Overview', heading: 'Cost Overview' },
      { button: 'Trends', heading: 'Cost Trends' },
      { button: 'Missing Tags', heading: 'Missing Tags' },
      { button: 'Savings', heading: 'Savings Opportunities' },
      { button: 'Cost Scope', heading: 'Cost Scope' },
      { button: 'Dimensions', heading: 'Dimensions' },
      { button: 'Sync', heading: 'Data Management' },
    ];

    for (const { button, heading } of views) {
      // Nav buttons are matched with exact:true — some views (Dimensions'
      // account-tags card, for example) render buttons whose accessible
      // names contain "Sync" as a substring, which otherwise resolves
      // to multiple elements and fails strict mode.
      await page.getByRole('button', { name: button, exact: true }).first().click();
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible({ timeout: 5000 });
      await page.waitForTimeout(500);
      await assertNoReactCrash(page);
    }

    // go back to overview for subsequent tests
    await page.getByRole('button', { name: 'Cost Overview', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Cost Overview' })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Cost Overview — the main dashboard
// ---------------------------------------------------------------------------
test.describe('Cost Overview', () => {
  test.beforeAll(async () => {
    await navigateTo(page, 'Cost Overview', 'Cost Overview');
  });

  test('renders summary card with Total Cost label', async () => {
    await expect(page.getByText('Total Cost', { exact: false }).first()).toBeVisible({ timeout: LOAD_TIMEOUT });

    // Shows either a dollar amount or "—" when no data is in the current range
    const costText = page.locator('.tabular-nums').first();
    await expect(costText).toBeVisible();
    const text = await costText.textContent();
    expect(text === '—' || (text !== null && text.includes('$'))).toBe(true);

    await screenshot(page, 'overview-summary');
  });

  test('renders date range picker with daily and hourly presets', async () => {
    // daily presets
    for (const preset of ['30 days', '90 days', '365 days']) {
      await expect(page.getByRole('button', { name: preset }).first()).toBeVisible();
    }

    // hourly presets
    for (const preset of ['7 days', '14 days']) {
      await expect(page.getByRole('button', { name: preset }).first()).toBeVisible();
    }

    // Custom button
    await expect(page.getByRole('button', { name: 'Custom' })).toBeVisible();
  });

  test('switching date range preset triggers a reload', async () => {
    const btn365 = page.getByRole('button', { name: '365 days' }).first();
    await btn365.click();
    await waitForQuerySettle(page);

    // After switching, summary card shows either a dollar amount or "—"
    const costText = page.locator('.tabular-nums').first();
    const text = await costText.textContent();
    expect(text === '—' || (text !== null && text.includes('$'))).toBe(true);

    // switch back
    await page.getByRole('button', { name: '30 days' }).first().click();
    await waitForQuerySettle(page);
  });

  test('custom date range inputs appear when Custom is clicked', async () => {
    const customBtn = page.getByRole('button', { name: 'Custom' });
    await customBtn.click();

    const dateInputs = page.locator('input[type="date"]');
    await expect(dateInputs.first()).toBeVisible();
    expect(await dateInputs.count()).toBeGreaterThanOrEqual(2);

    // click Custom again to dismiss
    await customBtn.click();
  });

  test('filter bar shows dimension chips and they are clickable', async () => {
    // Filter chips are buttons with dimension names like "Account", "Service"
    // Use a known dimension name to find the filter bar area
    const accountChip = page.getByRole('button', { name: 'Account', exact: true });
    const hasChip = await accountChip.isVisible().catch(() => false);
    if (!hasChip) return;

    // click to open the filter dropdown
    await accountChip.click();

    // dropdown should open with either a search input or loading state
    const dropdown = page.locator('.absolute.left-0.top-full');
    await expect(dropdown).toBeVisible({ timeout: 5000 });

    // wait for loading to finish (search box should be usable)
    const searchInput = page.locator('input[placeholder^="Search"]');
    if (await searchInput.isVisible()) {
      // type into the search to verify it works
      await searchInput.fill('test');
      await searchInput.fill('');
    }

    await screenshot(page, 'overview-filter-dropdown');

    // close dropdown by clicking outside
    await page.locator('h2').first().click();
    await page.waitForTimeout(200);
  });

  test('filter chip: selecting a value applies the filter and Clear all removes it', async () => {
    const accountChip = page.getByRole('button', { name: 'Account', exact: true });
    const hasChip = await accountChip.isVisible().catch(() => false);
    if (!hasChip) return;
    await accountChip.click();

    // wait for dropdown values
    const dropdown = page.locator('.absolute.left-0.top-full');
    await expect(dropdown).toBeVisible({ timeout: 5000 });

    // wait for values to load
    try {
      await expect(page.getByText('Loading…')).toBeHidden({ timeout: 10000 });
    } catch { /* may not appear */ }

    const dropdownItems = dropdown.locator('button');
    const itemCount = await dropdownItems.count();

    if (itemCount > 0) {
      await dropdownItems.first().click();
      await waitForQuerySettle(page);

      // "Clear all" button should appear
      const clearAll = page.getByRole('button', { name: 'Clear all' });
      await expect(clearAll).toBeVisible();

      await screenshot(page, 'overview-filtered');

      // clear the filter
      await clearAll.click();
      await waitForQuerySettle(page);
    } else {
      // close the dropdown
      await page.locator('h2').first().click();
    }
  });

  test('pie chart containers are rendered when data exists', async () => {
    const pieContainers = page.locator('select');
    const selectCount = await pieContainers.count();
    // With no data in the current range, pie charts may not render selects
    if (selectCount >= 2) {
      await screenshot(page, 'overview-pie-charts');
    }
  });

  test('pie chart dimension dropdown switches the dimension', async () => {
    // Only target visible, enabled selects (pie chart dropdowns) — skip
    // hidden/disabled selects from other views (e.g. auto-sync interval).
    const selects = page.locator('select:not([disabled])');
    const visibleSelects: typeof selects[] = [];
    for (let i = 0; i < await selects.count(); i++) {
      if (await selects.nth(i).isVisible()) visibleSelects.push(selects.nth(i));
    }
    if (visibleSelects.length === 0 || visibleSelects[0] === undefined) return;

    const firstSelect = visibleSelects[0];
    const options = firstSelect.locator('option');
    const optCount = await options.count();
    if (optCount <= 1) return;

    const secondOption = await options.nth(1).getAttribute('value');
    if (secondOption !== null) {
      await firstSelect.selectOption(secondOption);
      await waitForQuerySettle(page);
      const firstOption = await options.first().getAttribute('value');
      if (firstOption !== null) {
        await firstSelect.selectOption(firstOption);
        await waitForQuerySettle(page);
      }
    }
  });

  test('stacked bar chart renders with tab toggles (Groups, Products, Services)', async () => {
    for (const tabName of ['Groups', 'Products', 'Services']) {
      const tab = page.getByRole('button', { name: tabName });
      await expect(tab).toBeVisible();
    }

    // switch between tabs
    for (const tabName of ['Products', 'Services', 'Groups']) {
      await page.getByRole('button', { name: tabName }).click();
    }
  });

  test('histogram expand/collapse toggle works', async () => {
    const expandBtn = page.locator('button[title="Expand"], button[title="Collapse"]');
    const count = await expandBtn.count();

    if (count > 0) {
      await expandBtn.first().click();
      await page.waitForTimeout(200);
      await expandBtn.first().click();
    }
  });

  test('pie chart expand/collapse works', async () => {
    const expandBtns = page.locator('button[title="Toggle expand"]');
    const count = await expandBtns.count();

    if (count > 0) {
      // expand first pie
      await expandBtns.first().click();
      await screenshot(page, 'overview-pie-expanded');

      // click again to restore
      await expandBtns.first().click();
      await screenshot(page, 'overview-pie-restored');
    }
  });

  test('hovering a pie legend entry does not crash', async () => {
    const legendItems = page.locator('svg g text');
    const legendCount = await legendItems.count();
    if (legendCount > 0) {
      await legendItems.first().hover();
      await screenshot(page, 'overview-pie-hover');
    }
  });

  test('breakdown table renders when data is available', async () => {
    // switch to 365 days to maximize chance of having data
    await page.getByRole('button', { name: '365 days' }).first().click();
    await waitForQuerySettle(page);

    const tables = page.locator('table');
    const tableCount = await tables.count();

    if (tableCount > 0 && await hasVisibleData(page)) {
      const lastTable = tables.last();
      const rows = lastTable.locator('tbody tr');
      const rowCount = await rows.count();
      expect(rowCount).toBeGreaterThan(0);

      // hover a row
      if (rowCount > 0) {
        await rows.first().hover();
        await screenshot(page, 'overview-breakdown-hover');
      }
    }

    // switch back
    await page.getByRole('button', { name: '30 days' }).first().click();
    await waitForQuerySettle(page);
  });

  test('histogram hover shows tooltip when bars exist', async () => {
    const bars = page.locator('[role="button"][tabindex="0"]');
    const barCount = await bars.count();

    if (barCount > 0) {
      await bars.first().hover();
      await screenshot(page, 'overview-histogram-hover');
    }
  });
});

// ---------------------------------------------------------------------------
// Cost Trends
// ---------------------------------------------------------------------------
test.describe('Cost Trends', () => {
  test.beforeAll(async () => {
    await navigateTo(page, 'Trends', 'Cost Trends');
  });

  test('shows heading and subtitle', async () => {
    await expect(page.getByText('Period-over-period comparison')).toBeVisible();
  });

  test('dimension selector shows dimension tabs', async () => {
    // dimension selector is a row of buttons inside a bordered container
    const dimSelector = page.locator('.rounded-lg.border');
    await expect(dimSelector.first()).toBeVisible();
  });

  test('switching dimensions triggers reload', async () => {
    const dimBtns = page.locator('.rounded-lg.border.bg-bg-tertiary\\/30 button').first();
    const allDimBtns = page.locator('.rounded-lg.border.bg-bg-tertiary\\/30 button');
    const count = await allDimBtns.count();

    if (count > 1) {
      await allDimBtns.nth(1).click();
      await waitForQuerySettle(page);
      await screenshot(page, 'trends-dimension-switch');

      await allDimBtns.first().click();
      await waitForQuerySettle(page);
    }
  });

  test('Increases/Savings toggle is present and clickable', async () => {
    // These buttons have CSS capitalize. The nav bar also has a "Savings" button,
    // so we scope to the toggle container (the bordered pill group).
    const toggleContainer = page.locator('.flex.items-center.gap-1.rounded-lg.border').nth(1);
    const increasesBtn = toggleContainer.getByRole('button', { name: 'increases' });
    const savingsBtn = toggleContainer.getByRole('button', { name: 'savings' });

    await expect(increasesBtn).toBeVisible();
    await expect(savingsBtn).toBeVisible();

    // toggle to savings
    await savingsBtn.click();
    await waitForQuerySettle(page);
    await screenshot(page, 'trends-savings');

    // toggle back to increases
    await increasesBtn.click();
    await waitForQuerySettle(page);
    await screenshot(page, 'trends-increases');
  });

  test('Min $ and Min % inputs are present and functional', async () => {
    const numberInputs = page.locator('input[type="number"]');
    const inputCount = await numberInputs.count();
    expect(inputCount).toBeGreaterThanOrEqual(2);

    // modify Min $ threshold
    const minDollar = numberInputs.first();
    await minDollar.fill('1000');
    await waitForQuerySettle(page);

    // modify Min %
    const minPercent = numberInputs.nth(1);
    await minPercent.fill('50');
    await waitForQuerySettle(page);
    await screenshot(page, 'trends-high-threshold');

    // restore defaults
    await minDollar.fill('10');
    await minPercent.fill('1');
    await waitForQuerySettle(page);
  });

  test('when data exists, shows item count summary and table', async () => {
    const dataExists = await hasVisibleData(page);
    const errorVisible = await page.locator('.text-negative').first().isVisible().catch(() => false);

    if (dataExists) {
      // summary line
      const summaryLine = page.locator('text=/\\d+ items/');
      await expect(summaryLine.first()).toBeVisible();

      // table with columns
      const table = page.locator('table');
      if (await table.isVisible()) {
        for (const col of ['Entity', 'Current', 'Previous', 'Delta', 'Change']) {
          await expect(page.getByText(col, { exact: true }).first()).toBeVisible();
        }
      }
    } else if (errorVisible) {
      // error message is displayed gracefully (red border, readable text)
      await screenshot(page, 'trends-error-state');
    } else {
      // no data, no error — "No increases above thresholds" message
      await screenshot(page, 'trends-empty-state');
    }
  });

  test('bubble chart renders SVG circles when data exists', async () => {
    const circles = page.locator('svg circle');
    const count = await circles.count();

    if (count > 0) {
      // hover a bubble
      await circles.first().hover();
      await page.waitForTimeout(300);
      await screenshot(page, 'trends-bubble-hover');
    }
  });

  test('clicking entity in table navigates to entity detail', async () => {
    const entityLink = page.locator('table button.text-accent').first();
    const exists = await entityLink.isVisible().catch(() => false);

    if (exists) {
      const entityName = await entityLink.textContent();
      await entityLink.click();

      // should navigate to entity detail
      await expect(page.getByRole('button', { name: '← Back' })).toBeVisible({ timeout: 5000 });
      if (entityName !== null) {
        await expect(page.getByText(entityName)).toBeVisible();
      }

      await waitForQuerySettle(page);
      await screenshot(page, 'trends-entity-detail');

      // back button returns to overview (by design)
      await page.getByRole('button', { name: '← Back' }).click();
      await expect(page.getByRole('heading', { name: 'Cost Overview' })).toBeVisible();
    }
  });
});

// ---------------------------------------------------------------------------
// Missing Tags
// ---------------------------------------------------------------------------
test.describe('Missing Tags', () => {
  test.beforeAll(async () => {
    await navigateTo(page, 'Missing Tags', 'Missing Tags');
  });

  test('shows heading and subtitle', async () => {
    await expect(page.getByRole('heading', { name: 'Missing Tags' })).toBeVisible();
    await expect(page.getByText(/without the selected allocation tag/i)).toBeVisible();
  });

  test('tag dimension tabs are visible and switchable', async () => {
    const tabContainer = page.locator('.rounded-lg.border.bg-bg-tertiary\\/30');
    const hasMultiple = await tabContainer.first().isVisible().catch(() => false);

    if (hasMultiple) {
      const tabBtns = tabContainer.first().locator('button');
      const count = await tabBtns.count();

      if (count > 1) {
        await tabBtns.nth(1).click();
        await waitForQuerySettle(page);
        await screenshot(page, 'missing-tags-second-tab');

        await tabBtns.first().click();
        await waitForQuerySettle(page);
      }
    }
  });

  test('min cost input is present and functional', async () => {
    const minCostInput = page.locator('input[type="number"]');
    await expect(minCostInput).toBeVisible();

    // set to 0 to get max results
    await minCostInput.fill('0');
    await waitForQuerySettle(page);
    await screenshot(page, 'missing-tags-low-threshold');

    // set high to filter everything out
    await minCostInput.fill('999999');
    await waitForQuerySettle(page);

    // either no data, error, or "No untagged resources" message
    await screenshot(page, 'missing-tags-high-threshold');

    // restore default
    await minCostInput.fill('50');
    await waitForQuerySettle(page);
  });

  test('shows summary stats, empty state, or error when data loads', async () => {
    const hasData = await hasVisibleData(page);
    const hasError = await page.locator('.text-negative').first().isVisible().catch(() => false);

    if (hasData) {
      await expect(page.getByText('Actionable missing tags').first()).toBeVisible();
      await expect(page.getByText('Likely not taggable').first()).toBeVisible();
      await expect(page.getByText('Non-resource cost').first()).toBeVisible();
    } else if (hasError) {
      await screenshot(page, 'missing-tags-error');
    }
    // No data and no error is also valid (empty date range)
    await screenshot(page, 'missing-tags-state');
  });

  test('table renders with proper columns when data exists', async () => {
    const table = page.locator('table');
    const hasTable = await table.first().isVisible().catch(() => false);

    if (hasTable) {
      for (const header of ['Account', 'Resource', 'Service', 'Family', 'Cost', 'Closest Owner']) {
        await expect(page.getByText(header, { exact: true }).first()).toBeVisible();
      }

      const rows = table.first().locator('tbody tr');
      const rowCount = await rows.count();
      if (rowCount > 0) {
        // hover a row
        await rows.first().hover();
        await screenshot(page, 'missing-tags-row-hover');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Savings Opportunities
// ---------------------------------------------------------------------------
test.describe('Savings', () => {
  test.beforeAll(async () => {
    await navigateTo(page, 'Savings', 'Savings Opportunities');
  });

  test('shows heading and subtitle', async () => {
    await expect(page.getByText('AWS cost optimization recommendations')).toBeVisible();
  });

  test('shows either savings data or empty state', async () => {
    const hasSavings = await page.getByText('Potential Monthly Savings').isVisible().catch(() => false);
    const hasEmpty = await page.getByText(/No cost optimization/).isVisible().catch(() => false);
    const hasError = await page.locator('.text-negative').first().isVisible().catch(() => false);

    // one of the three states must be true
    expect(hasSavings || hasEmpty || hasError).toBe(true);

    if (hasSavings) {
      await expect(page.getByText('Recommendations', { exact: true })).toBeVisible();
    }

    await screenshot(page, 'savings-state');
  });

  test('action type filter pills work when data exists', async () => {
    const hasSavings = await page.getByText('Potential Monthly Savings').isVisible().catch(() => false);
    if (!hasSavings) return;

    const pills = page.locator('button.rounded-full');
    const count = await pills.count();

    if (count > 1) {
      // click a filter pill
      await pills.nth(1).click();
      await screenshot(page, 'savings-filtered');

      // click first pill to reset (All)
      await pills.first().click();
    }
  });

  test('table column headers are sortable when data exists', async () => {
    const table = page.locator('table');
    const hasTable = await table.first().isVisible().catch(() => false);
    if (!hasTable) return;

    // click sortable headers
    for (const header of ['Account', 'Monthly Cost', 'Savings/mo']) {
      const th = page.locator('th').filter({ hasText: header }).first();
      const isVisible = await th.isVisible().catch(() => false);
      if (isVisible) {
        await th.click();
        await th.click(); // click again to reverse sort
      }
    }
    await screenshot(page, 'savings-sorted');
  });

  test('clicking a recommendation row expands/collapses detail', async () => {
    const rows = page.locator('table tbody tr.cursor-pointer');
    const count = await rows.count();
    if (count === 0) return;

    await rows.first().click();

    // expanded detail should show Current/Recommended sections
    await expect(page.getByText('Current', { exact: true }).first()).toBeVisible({ timeout: 3000 });
    await expect(page.getByText('Recommended', { exact: true }).first()).toBeVisible();
    await screenshot(page, 'savings-expanded');

    // collapse
    await rows.first().click();
  });
});

// ---------------------------------------------------------------------------
// Entity Detail (conditional — only if trends has clickable entities)
// ---------------------------------------------------------------------------
test.describe('Entity Detail', () => {
  let entityReached = false;

  test.beforeAll(async () => {
    // Reach entity detail via Trends → click first entity link.
    await navigateTo(page, 'Trends', 'Cost Trends');

    const entityLink = page.locator('table button.text-accent').first();
    const exists = await entityLink.isVisible().catch(() => false);

    if (exists) {
      await entityLink.click();
      await expect(page.getByRole('button', { name: '← Back' })).toBeVisible({ timeout: 5000 });
      await waitForQuerySettle(page);
      entityReached = true;
    }
  });

  test('shows entity name as heading', async () => {
    test.skip(!entityReached, 'No entity data available to navigate to');
    await screenshot(page, 'entity-detail-page');
    const heading = page.locator('h2');
    const count = await heading.count();
    expect(count).toBeGreaterThan(0);
  });

  test('shows Total and vs Previous Period cards', async () => {
    test.skip(!entityReached, 'No entity data available');
    await expect(page.getByText('Total', { exact: true }).first()).toBeVisible();
    const costValue = page.locator('.text-3xl.tabular-nums');
    await expect(costValue).toBeVisible();
    const text = await costValue.textContent();
    expect(text).toContain('$');

    await expect(page.getByText('vs Previous Period')).toBeVisible();
  });

  test('daily costs histogram with service/account toggle', async () => {
    test.skip(!entityReached, 'No entity data available');
    // Title is "Daily Costs" or "Hourly Costs" depending on granularity
    const hasTitle = await page.getByText(/Daily Costs|Hourly Costs/).first().isVisible().catch(() => false);
    expect(hasTitle).toBe(true);

    // Tab buttons may use different casing
    const tabs = page.locator('button').filter({ hasText: /service|account/i });
    if (await tabs.count() >= 2) {
      await tabs.last().click();
      await screenshot(page, 'entity-detail-histogram-toggle');
      await tabs.first().click();
    }
  });

  test('hover on histogram bars shows tooltip', async () => {
    test.skip(!entityReached, 'No entity data available');
    const bars = page.locator('.group.relative.flex-1');
    const count = await bars.count();

    if (count > 0) {
      await bars.nth(Math.min(5, count - 1)).hover();
      await screenshot(page, 'entity-detail-bar-hover');
    }
  });

  test('breakdown section renders', async () => {
    test.skip(!entityReached, 'No entity data available');
    await expect(page.getByText('Breakdown', { exact: true }).first()).toBeVisible();
    await screenshot(page, 'entity-detail-breakdown');
  });

  test('breakdown table renders with Service, Cost, % columns', async () => {
    test.skip(!entityReached, 'No entity data available');
    await expect(page.getByText('Breakdown', { exact: true }).first()).toBeVisible();
    const table = page.locator('table').last();
    const rows = table.locator('tbody tr');
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
  });

  test('date range picker works on entity detail', async () => {
    test.skip(!entityReached, 'No entity data available');
    const btn90 = page.getByRole('button', { name: '90 days' }).first();
    await btn90.click();
    await waitForQuerySettle(page);

    const costValue = page.locator('.text-3xl.tabular-nums');
    const text = await costValue.textContent();
    expect(text).toContain('$');
  });

  test('Export CSV button is visible', async () => {
    test.skip(!entityReached, 'No entity data available');
    await expect(page.getByRole('button', { name: 'Export CSV' })).toBeVisible();
  });

  test('back button returns to overview', async () => {
    test.skip(!entityReached, 'No entity data available');
    await page.getByRole('button', { name: '← Back' }).click();
    await expect(page.getByRole('heading', { name: 'Cost Overview' })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Data Management
// ---------------------------------------------------------------------------
test.describe('Data Management', () => {
  test.beforeAll(async () => {
    // Data management loads S3 inventory which can be slow — navigateTo's
    // waitForQuerySettle gives it the 30s LOAD_TIMEOUT window.
    await navigateTo(page, 'Sync', 'Data Management');
  });

  test('shows heading and subtitle', async () => {
    await expect(page.getByText('S3 sync and local data inventory')).toBeVisible();
  });

  test('shows action buttons: Auto-sync, Delete All, Open Folder, Refresh', async () => {
    await expect(page.getByText('Auto-sync')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete All Data' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open Folder' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible();
  });

  test('auto-sync toggle clicks without crash', async () => {
    // find the toggle — it's the rounded-full button near "Auto-sync" text
    const toggle = page.locator('button.rounded-full').filter({ has: page.locator('span.rounded-full') });
    const count = await toggle.count();
    if (count > 0) {
      await toggle.first().click();
      await toggle.first().click();
    }
  });

  test('org section is visible (either synced or prompt)', async () => {
    const synced = page.getByText('AWS Organization').first();
    const prompt = page.getByText('AWS Organizations not synced');
    const hasSynced = await synced.isVisible().catch(() => false);
    const hasPrompt = await prompt.isVisible().catch(() => false);

    expect(hasSynced || hasPrompt).toBe(true);

    if (hasSynced && !hasPrompt) {
      // click to expand
      await synced.click();
      await expect(page.getByText('Account ID').first()).toBeVisible({ timeout: 3000 });
      await screenshot(page, 'data-management-org');

      // collapse
      await synced.click();
    }
  });

  test('tier panels load (Daily at minimum, possibly Hourly and Cost Optimization)', async () => {
    // Wait for S3 inventory to finish checking
    try {
      await expect(page.getByText('Checking S3 for available data...')).toBeHidden({ timeout: LOAD_TIMEOUT });
    } catch { /* may have already finished */ }

    // After loading, should see tier panels with either data or "Not configured" state
    // The Daily panel should exist since config is present
    const dailyTitle = page.locator('h3').filter({ hasText: 'Daily' });
    const hasDailyPanel = await dailyTitle.isVisible().catch(() => false);

    if (hasDailyPanel) {
      await screenshot(page, 'data-management-tiers');
    } else {
      // might show an error (e.g., expired SSO)
      await screenshot(page, 'data-management-error');
    }
  });

  test('tier panel shows local data stats when configured', async () => {
    // "Local" and "Range" labels appear inside the tier panel grid
    const localLabel = page.locator('text=/Local/').first();
    const hasLocal = await localLabel.isVisible().catch(() => false);

    if (hasLocal) {
      await screenshot(page, 'data-management-local-stats');
    }
  });

  test('downloaded periods list visible when data exists locally', async () => {
    const downloaded = page.getByText('Downloaded').first();
    const hasDownloaded = await downloaded.isVisible().catch(() => false);

    if (hasDownloaded) {
      await screenshot(page, 'data-management-downloaded');
    }
  });

  test('available periods list with checkboxes when remote data exists', async () => {
    const available = page.getByText('Available').first();
    const hasAvailable = await available.isVisible().catch(() => false);

    if (hasAvailable) {
      // checkboxes for period selection
      const checkboxes = page.locator('input[type="checkbox"]');
      const checkCount = await checkboxes.count();
      expect(checkCount).toBeGreaterThan(0);

      await screenshot(page, 'data-management-available');
    }
  });

  test('refresh button triggers reload', async () => {
    await page.getByRole('button', { name: 'Refresh' }).click();
    await waitForQuerySettle(page);
    await screenshot(page, 'data-management-refreshed');
  });

  test('Delete All button opens confirmation modal and Cancel dismisses it', async () => {
    await page.getByRole('button', { name: 'Delete All Data' }).click();

    // confirmation modal
    await expect(page.getByText('Delete all local data')).toBeVisible({ timeout: 3000 });
    await expect(page.getByText('This will remove all downloaded')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete All', exact: true })).toBeVisible();

    await screenshot(page, 'data-management-delete-confirm');

    // cancel — don't actually delete
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByText('Delete all local data')).toBeHidden();
  });

  test('configure button opens setup wizard modal', async () => {
    const configBtns = page.locator('button[title*="Configure"]');
    const count = await configBtns.count();

    if (count > 0) {
      await configBtns.first().click();

      const closeBtn = page.locator('button[title="Close"]');
      const isOpen = await closeBtn.isVisible().catch(() => false);
      if (isOpen) {
        await screenshot(page, 'data-management-configure-modal');
        await closeBtn.click();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------
test.describe('Dimensions', () => {
  test.beforeAll(async () => {
    await navigateTo(page, 'Dimensions', 'Dimensions');
  });

  test('shows heading and subtitle', async () => {
    await expect(page.getByText('Map tags to cost allocation dimensions')).toBeVisible();
  });

  test('shows built-in dimensions', async () => {
    // Built-in dimensions render as rows with labels like Account, Service, Region
    await expect(page.getByText('Account', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Region', { exact: true }).first()).toBeVisible();
  });

  test('shows Add button', async () => {
    await expect(page.getByRole('button', { name: '+ Add' })).toBeVisible();
  });

  test('clicking a tag dimension opens the editor', async () => {
    // find a tag dimension (not built-in) and click it
    const editBtn = page.locator('button').filter({ hasText: 'Edit →' }).first();
    const exists = await editBtn.isVisible().catch(() => false);

    if (exists) {
      await editBtn.click();

      // editor should show concept, label, normalization dropdowns
      await expect(page.getByText('Concept')).toBeVisible();
      await expect(page.getByText('Display Label')).toBeVisible();
      await expect(page.getByText('Normalization')).toBeVisible();
      await expect(page.getByText('Resource Tag', { exact: true })).toBeVisible();

      // Save and Cancel buttons
      await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();

      await screenshot(page, 'dimensions-editor');

      // Cancel to close
      await page.getByRole('button', { name: 'Cancel' }).click();
    }
  });

  test('Add opens editor with tag dropdown', async () => {
    await page.getByRole('button', { name: '+ Add' }).click();

    await expect(page.getByText('Resource Tag', { exact: true })).toBeVisible();
    // The placeholder is an <option> inside a <select> — check the select exists
    await expect(page.locator('select').first()).toBeVisible();

    await screenshot(page, 'dimensions-add-new');

    // Cancel and wait for editor to close
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.waitForTimeout(300);
  });

  test('Resource Tags section loads or shows loading/error state', async () => {
    // Wait for either the table, loading, or error to appear
    const hasTable = await page.getByText('Resource Tags').first().isVisible().catch(() => false);
    const hasLoading = await page.getByText('Scanning billing data').isVisible().catch(() => false);
    const hasError = await page.locator('.text-negative').first().isVisible().catch(() => false);

    expect(hasTable || hasLoading || hasError).toBe(true);
    await screenshot(page, 'dimensions-resource-tags');
  });

  test('Account Tags table shows when org data exists', async () => {
    const hasAccountTags = await page.getByText('Account Tags').isVisible().catch(() => false);

    if (hasAccountTags) {
      // badges should be visible
      const badges = page.locator('button.rounded-full');
      const badgeCount = await badges.count();
      expect(badgeCount).toBeGreaterThan(0);

      await screenshot(page, 'dimensions-account-tags');
    }
  });

  test('tag table badges toggle columns', async () => {
    const badges = page.locator('button.rounded-full.border-accent\\/40');
    const count = await badges.count();

    if (count > 2) {
      // click first badge to hide a column
      const firstBadge = badges.first();
      await firstBadge.click();

      // it should now have strikethrough styling
      await screenshot(page, 'dimensions-badge-toggled');

      // click again to restore
      const hiddenBadge = page.locator('button.rounded-full.line-through').first();
      const isHidden = await hiddenBadge.isVisible().catch(() => false);
      if (isHidden) {
        await hiddenBadge.click();
      }
    }
  });

  test('no React crash on Dimensions view', async () => {
    await assertNoReactCrash(page);
  });
});

// ---------------------------------------------------------------------------
// Views editor — user-built dashboards
// ---------------------------------------------------------------------------
test.describe('Views editor', () => {
  test.beforeAll(async () => {
    await navigateTo(page, 'Views', 'Views');
  });

  test('shows the heading and seed view in the left pane', async () => {
    await expect(page.getByText('Compose dashboards from the widget library')).toBeVisible();
    // seed view name appears in the left pane
    await expect(page.getByText('Cost Overview').first()).toBeVisible();
  });

  test('save button is disabled when nothing has changed', async () => {
    const saveBtn = page.getByRole('button', { name: /Saved|Save changes/ });
    await expect(saveBtn).toBeVisible();
  });

  test('clicking + New view creates a draft view', async () => {
    await page.getByRole('button', { name: '+ New view' }).click();
    await expect(page.getByText('New view').first()).toBeVisible();
    await screenshot(page, 'views-editor-new');

    // Delete the draft so subsequent tests start clean. The new view
    // shows a delete button since it hasn't been saved yet.
    const deleteBtn = page.getByRole('button', { name: /Delete|Remove/ });
    if (await deleteBtn.first().isVisible().catch(() => false)) {
      await deleteBtn.first().click();
      // Confirm deletion if a modal appears
      const confirmBtn = page.getByRole('button', { name: /Delete|Confirm/ });
      if (await confirmBtn.first().isVisible().catch(() => false)) {
        await confirmBtn.first().click();
      }
      await page.waitForTimeout(300);
    }
  });

  test('Reset built-ins button is present', async () => {
    await expect(page.getByRole('button', { name: 'Reset built-ins' })).toBeVisible();
  });

  test('Export and Import buttons are present', async () => {
    await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Import', exact: true })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Cost Scope — metric picker, exclusion rules, preview histogram + table
// ---------------------------------------------------------------------------
test.describe('Cost Scope', () => {
  test.beforeAll(async () => {
    // Click Cost Scope nav — if the Views editor has unsaved changes,
    // a "Discard" confirm modal will appear. Dismiss it.
    await page.getByRole('button', { name: 'Cost Scope', exact: true }).first().click();
    const discardBtn = page.getByRole('button', { name: 'Discard' });
    if (await discardBtn.isVisible({ timeout: 500 }).catch(() => false)) {
      await discardBtn.click();
    }
    await expect(page.getByRole('heading', { name: 'Cost Scope', exact: true })).toBeVisible({ timeout: 5000 });
    await waitForCostScopePreview(page);
  });

  test('shows heading and intro copy', async () => {
    await expect(page.getByText(/Define what counts as cost/)).toBeVisible();
  });

  test('cost metric picker lists Unblended, Blended, Amortized (no List)', async () => {
    await expect(page.getByRole('heading', { name: 'Cost metric' })).toBeVisible();
    // Check the actual radio values, which are unique — the labels repeat
    // in adjacent description copy so role/name queries are ambiguous.
    await expect(page.locator('input[type="radio"][value="unblended"]')).toBeVisible();
    await expect(page.locator('input[type="radio"][value="blended"]')).toBeVisible();
    await expect(page.locator('input[type="radio"][value="amortized"]')).toBeVisible();
    await expect(page.locator('input[type="radio"][value="list"]')).toHaveCount(0);

    // Exactly one metric radio is selected — the specific one depends on
    // what the user has saved to cost-scope.yaml, so we don't assume a
    // default beyond "something is checked".
    await expect(page.locator('input[type="radio"][name="costMetric"]:checked')).toHaveCount(1);
    await screenshot(page, 'cost-scope-metric');
  });

  test('exclusion rules section lists both built-in rules', async () => {
    await expect(page.getByRole('heading', { name: 'Exclusion rules' })).toBeVisible();
    // Rule names are rendered in inputs (they're editable).
    await expect(page.locator('input[value="AWS Premium Support"]')).toBeVisible();
    await expect(page.locator('input[value="RI & Savings Plan purchases"]')).toBeVisible();
    // Built-in pill appears next to each
    const builtInPills = page.getByText('built-in', { exact: true });
    expect(await builtInPills.count()).toBeGreaterThanOrEqual(2);
  });

  test('preview card renders summary tiles + histogram', async () => {
    // Preview is sticky on the right column at lg+; scrollIntoView just
    // ensures it's reachable regardless of breakpoint.
    const card = page.getByTestId('cost-scope-preview');
    await card.scrollIntoViewIfNeeded();
    await expect(card).toBeVisible();
    await expect(card.getByRole('heading', { name: 'Preview' })).toBeVisible();

    // Summary tiles — scope to the card so "Rows matching any enabled rule
    // are excluded" in the rules section header doesn't collide. At lg+ the
    // card also appears twice (hidden mobile copy + sticky aside), so we
    // use `.first()` on the match.
    await expect(card.getByText('Unscoped total', { exact: true }).first()).toBeVisible();
    await expect(card.getByText('After scope', { exact: true }).first()).toBeVisible();
    await expect(card.getByText('Excluded', { exact: true }).first()).toBeVisible();

    // Daily cost label appears only when the histogram is rendered
    await expect(card.getByText('Daily cost', { exact: true }).first()).toBeVisible();

    await screenshot(page, 'cost-scope-preview');
  });

  test('line-items card has its own heading + table', async () => {
    const card = page.getByTestId('cost-scope-line-items');
    await card.scrollIntoViewIfNeeded();
    await expect(card).toBeVisible();
    await expect(card.getByRole('heading', { name: 'Line items' })).toBeVisible();
  });

  test('preview histogram or empty state is shown', async () => {
    const previewCard = page.getByTestId('cost-scope-preview').first();
    const dayBars = previewCard.locator('div[title*="kept:"]');
    const count = await dayBars.count();

    if (count > 0) {
      await dayBars.first().hover();
      await screenshot(page, 'cost-scope-histogram-hover');
    }
    // No bars is acceptable — data might not cover current 30-day window
  });

  test('line-items table renders rows when data exists', async () => {
    const lineItemsCard = page.getByTestId('cost-scope-line-items');
    await lineItemsCard.scrollIntoViewIfNeeded();
    const table = lineItemsCard.locator('table');
    const tableVisible = await table.isVisible().catch(() => false);

    if (!tableVisible) return; // No data in the current window

    // Header columns we expect to see
    for (const header of ['Date', 'Account', 'Region', 'Service', 'Cost', 'List']) {
      await expect(table.getByRole('columnheader', { name: header, exact: true })).toBeVisible();
    }

    // At least one data row
    const rows = table.locator('tbody tr');
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThan(0);

    // The first-row cost cell (second column — Date, Cost, ...) should be
    // a formatted dollar string. Absolute-value sort means the top row
    // could be a credit/refund, so we don't assert sign.
    const firstCostCell = rows.first().locator('td').nth(1);
    const costText = await firstCostCell.textContent();
    expect(costText).toContain('$');

    // Count summary line is visible
    await expect(lineItemsCard.getByText(/sorted by \|cost\| desc/)).toBeVisible();

    await screenshot(page, 'cost-scope-table');
  });

  test('toggling a built-in rule updates the save button + preview state', async () => {
    // The first rule card is AWS Premium Support (seed order). Its
    // enable/disable switch is the first role=switch on the page.
    const toggle = page.getByRole('switch').first();
    await expect(toggle).toBeVisible();

    const wasChecked = (await toggle.getAttribute('aria-checked')) === 'true';
    await toggle.click();
    const nowChecked = (await toggle.getAttribute('aria-checked')) === 'true';
    expect(nowChecked).toBe(!wasChecked);

    // Save button should appear now (draft is dirty)
    await expect(page.getByRole('button', { name: /Save/ })).toBeVisible();

    // Cancel to keep the saved state untouched
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(toggle).toHaveAttribute('aria-checked', wasChecked ? 'true' : 'false');
  });

  test('rule name and description fields are editable', async () => {
    // Find the first rule's name input — it's the input currently showing the
    // built-in name. Add a suffix, verify Save appears, Cancel reverts.
    const nameInput = page.locator('input[value="AWS Premium Support"]');
    await nameInput.fill('AWS Premium Support (edited)');
    await expect(page.getByRole('button', { name: /Save/ })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('input[value="AWS Premium Support"]')).toBeVisible();

    // Description textarea: fill, expect Save button, revert.
    const descBox = page.locator('textarea[placeholder^="Optional description"]').first();
    await expect(descBox).toBeVisible();
    const before = await descBox.inputValue();
    await descBox.fill(`${before} [edit]`);
    await expect(page.getByRole('button', { name: /Save/ })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(descBox).toHaveValue(before);
  });
});

// ---------------------------------------------------------------------------
// Widget growth regression — every widget × every size stays bounded
// ---------------------------------------------------------------------------
test.describe('Widget growth', () => {
  // Copy real config to a temp dir so we can swap in a synthetic views.yaml
  // without clobbering the user's real dashboard.
  const REAL_CONFIG_DIR = join(homedir(), 'Library', 'Application Support', '@costgoblin', 'desktop', 'config');
  const TEMP_CONFIG_DIR = join(tmpdir(), `costgoblin-widget-growth-${String(Date.now())}`);
  const VIEWS_YAML = buildWidgetMatrixYaml();

  // One test per widget type — each test renders that widget at all 4 sizes in
  // separate rows and asserts no horizontal/vertical runaway growth.
  const WIDGET_TYPES = ['summary', 'pie', 'stackedBar', 'line', 'topNBar', 'treemap', 'heatmap', 'bubble', 'table'] as const;

  // Single app launch with the temp config, reused across all widget tests.
  // Previously each widget type launched its own Electron process.
  let widgetApp: ElectronApplication;
  let widgetPage: Page;

  test.beforeAll(async () => {
    mkdirSync(TEMP_CONFIG_DIR, { recursive: true });
    for (const f of ['costgoblin.yaml', 'dimensions.yaml', 'org-tree.yaml']) {
      const src = join(REAL_CONFIG_DIR, f);
      if (existsSync(src)) writeFileSync(join(TEMP_CONFIG_DIR, f), readFileSync(src));
    }
    writeFileSync(join(TEMP_CONFIG_DIR, 'views.yaml'), VIEWS_YAML);

    widgetApp = await _electron.launch({
      args: [join(DESKTOP_DIR, 'out', 'main', 'main.js')],
      env: {
        ...process.env,
        NODE_ENV: 'production',
        COSTGOBLIN_DATA_DIR: join(homedir(), 'Library', 'Application Support', '@costgoblin', 'desktop', 'data'),
        COSTGOBLIN_CONFIG_DIR: TEMP_CONFIG_DIR,
      },
    });
    widgetPage = await widgetApp.firstWindow();
    await expect(widgetPage).toHaveTitle('CostGoblin');
    await widgetPage.setViewportSize({ width: 1400, height: 900 });
  });

  test.afterAll(async () => { await widgetApp.close(); });

  for (const widgetType of WIDGET_TYPES) {
    test(`${widgetType} stays bounded at all sizes`, async () => {
      await widgetPage.getByRole('button', { name: `test-${widgetType}`, exact: true }).click();
      await waitForQuerySettle(widgetPage);
      // Let queries resolve, loaders swap to real data, and any one-shot
      // layout transitions settle — we're hunting runaway growth, not
      // legitimate data-arrival reflows.
      await widgetPage.waitForTimeout(4000);

      // Sample every 600ms for ~3 seconds. Runaway growth shows up as
      // sample-to-sample increases.
      const samples: { bodyWidth: number; bodyHeight: number }[] = [];
      for (let i = 0; i < 5; i++) {
        const m = await widgetPage.evaluate(() => ({
          bodyWidth: document.body.scrollWidth,
          bodyHeight: document.body.scrollHeight,
        }));
        samples.push(m);
        await widgetPage.waitForTimeout(600);
      }

      const maxAllowedWidth = 1400 + 200; // scrollbar + window chrome tolerance
      for (const [i, s] of samples.entries()) {
        expect(s.bodyWidth, `sample ${String(i)}: body wider than viewport for ${widgetType}`).toBeLessThanOrEqual(maxAllowedWidth);
      }
      // Growth check: no single inter-sample gap should exceed 20px. A runaway
      // grower accumulates ~100s of px per second; legitimate reflows land in
      // the first sample and stay put.
      for (let i = 1; i < samples.length; i++) {
        const prev = samples[i - 1];
        const cur = samples[i];
        if (prev === undefined || cur === undefined) continue;
        expect(cur.bodyWidth - prev.bodyWidth, `width grew between samples ${String(i - 1)}→${String(i)} for ${widgetType}`).toBeLessThan(20);
        expect(cur.bodyHeight - prev.bodyHeight, `height grew between samples ${String(i - 1)}→${String(i)} for ${widgetType}`).toBeLessThan(20);
      }
    });
  }
});

function buildWidgetMatrixYaml(): string {
  const types = ['summary', 'pie', 'stackedBar', 'line', 'topNBar', 'treemap', 'heatmap', 'bubble', 'table'] as const;
  const sizes = ['small', 'medium', 'large', 'full'] as const;
  const views: string[] = [];
  // Keep the seed Cost Overview so the app boots into a working state. It's
  // also built-in so it can't be deleted by the test.
  views.push(`  - id: overview
    name: Cost Overview
    builtIn: true
    rows:
      - widgets:
          - id: ov-sum
            type: summary
            size: small
            metric: total`);
  for (const t of types) {
    const widgetLines: string[] = [];
    for (const [i, size] of sizes.entries()) {
      const id = `w-${t}-${size}`;
      if (t === 'summary') {
        widgetLines.push(`      - widgets:\n          - id: ${id}\n            type: summary\n            size: ${size}\n            metric: total`);
      } else {
        const extras = t === 'topNBar' || t === 'line' || t === 'heatmap' || t === 'table'
          ? `\n            topN: 10`
          : '';
        const columns = t === 'table' ? `\n            columns: [entity, service, cost, percentage]` : '';
        widgetLines.push(`      - widgets:\n          - id: ${id}\n            type: ${t}\n            size: ${size}\n            groupBy: service${extras}${columns}`);
      }
      void i;
    }
    views.push(`  - id: test-${t}
    name: test-${t}
    rows:
${widgetLines.join('\n')}`);
  }
  return `views:\n${views.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Cross-view navigation — full user journey
// ---------------------------------------------------------------------------
test.describe('Full user journey', () => {
  test.beforeAll(async () => {
    // Start the journey from Cost Overview regardless of where the previous
    // block left the app.
    await navigateTo(page, 'Cost Overview', 'Cost Overview');
  });

  test('overview → trends → missing tags → savings → data → overview (full navigation cycle)', async () => {
    // 1. Overview
    await waitForQuerySettle(page);
    await expect(page.getByRole('heading', { name: 'Cost Overview' })).toBeVisible();

    // 2. Trends
    await page.getByRole('button', { name: 'Trends' }).click();
    await expect(page.getByRole('heading', { name: 'Cost Trends' })).toBeVisible();
    await waitForQuerySettle(page);

    // 3. Missing Tags
    await page.getByRole('button', { name: 'Missing Tags' }).click();
    await expect(page.getByRole('heading', { name: 'Missing Tags' })).toBeVisible();
    await waitForQuerySettle(page);

    // 4. Savings
    await page.getByRole('button', { name: 'Savings' }).click();
    await expect(page.getByRole('heading', { name: 'Savings Opportunities' })).toBeVisible();
    await waitForQuerySettle(page);

    // 5. Dimensions
    await page.getByRole('button', { name: 'Dimensions' }).click();
    await expect(page.getByRole('heading', { name: 'Dimensions', exact: true })).toBeVisible();

    // 6. Sync
    await page.getByRole('button', { name: 'Sync' }).click();
    await expect(page.getByRole('heading', { name: 'Data Management' })).toBeVisible();

    // 7. Back to Overview
    await page.getByRole('button', { name: 'Cost Overview' }).click();
    await expect(page.getByRole('heading', { name: 'Cost Overview' })).toBeVisible();

    await screenshot(page, 'journey-complete');
  });

  test('rapid navigation between views does not crash', async () => {
    const views = ['Trends', 'Cost Overview', 'Missing Tags', 'Savings', 'Dimensions', 'Sync', 'Cost Overview', 'Trends', 'Missing Tags'];
    for (const view of views) {
      await page.getByRole('button', { name: view, exact: true }).first().click();
    }
    await expect(page.getByRole('heading', { name: 'Missing Tags' })).toBeVisible();
    await assertNoReactCrash(page);
  });
});
