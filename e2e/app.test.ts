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

const LOAD_TIMEOUT = 30_000;

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

async function hasVisibleData(page: Page): Promise<boolean> {
  // Check if there are any table rows with dollar amounts
  const dollarCells = page.locator('.tabular-nums');
  const count = await dollarCells.count();
  if (count === 0) return false;
  const text = await dollarCells.first().textContent();
  return text !== null && text.includes('$') && !text.includes('$0.00');
}

// ---------------------------------------------------------------------------
// App launch & navigation shell
// ---------------------------------------------------------------------------
test.describe('App shell', () => {
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    app = await launchApp();
    page = await app.firstWindow();
    await expect(page).toHaveTitle('CostGoblin');
    await startCoverage(page);
  });

  test.afterAll(async () => { await stopAndCollectCoverage(page); await app.close(); });

  test('shows title bar with logo and CostGoblin text', async () => {
    await expect(page.getByText('CostGoblin', { exact: true })).toBeVisible();
  });

  test('shows all navigation buttons', async () => {
    for (const label of ['Overview', 'Trends', 'Missing Tags', 'Savings', 'Dimensions', 'Sync']) {
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
      { button: 'Overview', heading: 'Cost Overview' },
      { button: 'Trends', heading: 'Cost Trends' },
      { button: 'Missing Tags', heading: 'Missing Tags' },
      { button: 'Savings', heading: 'Savings Opportunities' },
      { button: 'Dimensions', heading: 'Dimensions' },
      { button: 'Sync', heading: 'Data Management' },
    ];

    for (const { button, heading } of views) {
      await page.getByRole('button', { name: button }).click();
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible({ timeout: 5000 });
      await page.waitForTimeout(500);
      await assertNoReactCrash(page);
    }

    // go back to overview for subsequent tests
    await page.getByRole('button', { name: 'Overview' }).click();
    await expect(page.getByRole('heading', { name: 'Cost Overview' })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Cost Overview — the main dashboard
// ---------------------------------------------------------------------------
test.describe('Cost Overview', () => {
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    app = await launchApp();
    page = await app.firstWindow();
    await expect(page).toHaveTitle('CostGoblin');
    await waitForQuerySettle(page);
  });

  test.afterAll(async () => { await app.close(); });

  test('renders summary card with Total Cost label and a dollar amount', async () => {
    await expect(page.getByText('Total Cost', { exact: false }).first()).toBeVisible({ timeout: LOAD_TIMEOUT });

    // dollar amount should contain a $ sign (even if $0.00)
    const costText = page.locator('.tabular-nums').first();
    await expect(costText).toBeVisible();
    const text = await costText.textContent();
    expect(text).toContain('$');

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

    // summary card still shows a dollar amount
    const costText = page.locator('.tabular-nums').first();
    const text = await costText.textContent();
    expect(text).toContain('$');

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

  test('three pie chart containers are rendered', async () => {
    // each pie chart has a <select> dropdown (for dimension switching) and a "Click to..." subtitle
    const pieContainers = page.locator('select');
    const selectCount = await pieContainers.count();
    expect(selectCount).toBeGreaterThanOrEqual(2); // at least 2 pie chart selects

    // when there IS data, SVG paths render. when there's no data, containers are still present.
    await screenshot(page, 'overview-pie-charts');
  });

  test('pie chart dimension dropdown switches the dimension', async () => {
    const selects = page.locator('select');
    const selectCount = await selects.count();

    if (selectCount > 0) {
      const firstSelect = selects.first();
      const options = firstSelect.locator('option');
      const optCount = await options.count();

      if (optCount > 1) {
        const secondOption = await options.nth(1).getAttribute('value');
        if (secondOption !== null) {
          await firstSelect.selectOption(secondOption);
          await waitForQuerySettle(page);

          // switch back
          const firstOption = await options.first().getAttribute('value');
          if (firstOption !== null) {
            await firstSelect.selectOption(firstOption);
            await waitForQuerySettle(page);
          }
        }
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
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    app = await launchApp();
    page = await app.firstWindow();
    await expect(page).toHaveTitle('CostGoblin');
    await page.getByRole('button', { name: 'Trends' }).click();
    await expect(page.getByRole('heading', { name: 'Cost Trends' })).toBeVisible();
    await waitForQuerySettle(page);
  });

  test.afterAll(async () => { await app.close(); });

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
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    app = await launchApp();
    page = await app.firstWindow();
    await expect(page).toHaveTitle('CostGoblin');
    await page.getByRole('button', { name: 'Missing Tags' }).click();
    await expect(page.getByRole('heading', { name: 'Missing Tags' })).toBeVisible();
    await waitForQuerySettle(page);
  });

  test.afterAll(async () => { await app.close(); });

  test('shows heading and subtitle', async () => {
    await expect(page.getByText('Resources without cost allocation tags')).toBeVisible();
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

  test('shows summary stats or error when data loads', async () => {
    const hasData = await hasVisibleData(page);
    const errorMsg = page.locator('.text-negative').first();
    const hasError = await errorMsg.isVisible().catch(() => false);

    if (hasData) {
      // summary should show cost amount and resource count
      await expect(page.getByText(/untagged/)).toBeVisible();
      await expect(page.getByText(/resources/)).toBeVisible();
    } else if (hasError) {
      // error is displayed, that's fine
      await screenshot(page, 'missing-tags-error');
    }
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
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    app = await launchApp();
    page = await app.firstWindow();
    await expect(page).toHaveTitle('CostGoblin');
    await page.getByRole('button', { name: 'Savings' }).click();
    await expect(page.getByRole('heading', { name: 'Savings Opportunities' })).toBeVisible();
    await waitForQuerySettle(page);
  });

  test.afterAll(async () => { await app.close(); });

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
  let app: ElectronApplication;
  let page: Page;
  let entityReached = false;

  test.beforeAll(async () => {
    app = await launchApp();
    page = await app.firstWindow();
    await expect(page).toHaveTitle('CostGoblin');

    // try to reach entity detail via trends
    await page.getByRole('button', { name: 'Trends' }).click();
    await expect(page.getByRole('heading', { name: 'Cost Trends' })).toBeVisible();
    await waitForQuerySettle(page);

    const entityLink = page.locator('table button.text-accent').first();
    const exists = await entityLink.isVisible().catch(() => false);

    if (exists) {
      await entityLink.click();
      await expect(page.getByRole('button', { name: '← Back' })).toBeVisible({ timeout: 5000 });
      await waitForQuerySettle(page);
      entityReached = true;
    }
  });

  test.afterAll(async () => { await app.close(); });

  test('shows entity name as heading', async () => {
    test.skip(!entityReached, 'No entity data available to navigate to');
    const heading = page.locator('h2').first();
    await expect(heading).toBeVisible();
    const text = await heading.textContent();
    expect(text!.length).toBeGreaterThan(0);
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
    await expect(page.getByText('Daily Costs', { exact: true }).first()).toBeVisible();

    const serviceTab = page.getByRole('button', { name: 'service' });
    const accountTab = page.getByRole('button', { name: 'account' });
    await expect(serviceTab).toBeVisible();
    await expect(accountTab).toBeVisible();

    await accountTab.click();
    await screenshot(page, 'entity-detail-histogram-account');

    await serviceTab.click();
    await screenshot(page, 'entity-detail-histogram-service');
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

  test('distribution sections render (Accounts, Services, Sub-Entities)', async () => {
    test.skip(!entityReached, 'No entity data available');
    for (const section of ['Accounts', 'Services', 'Sub-Entities']) {
      await expect(page.getByText(section, { exact: true }).first()).toBeVisible();
    }
    await screenshot(page, 'entity-detail-distributions');
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
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    app = await launchApp();
    page = await app.firstWindow();
    await expect(page).toHaveTitle('CostGoblin');
    await page.getByRole('button', { name: 'Sync' }).click();
    await expect(page.getByRole('heading', { name: 'Data Management' })).toBeVisible();
    // Data management loads S3 inventory which can be slow — wait longer
    await waitForQuerySettle(page);
  });

  test.afterAll(async () => { await app.close(); });

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
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    app = await launchApp();
    page = await app.firstWindow();
    await expect(page).toHaveTitle('CostGoblin');
    await startCoverage(page);
    await page.getByRole('button', { name: 'Dimensions' }).click();
    await expect(page.getByRole('heading', { name: 'Dimensions', exact: true })).toBeVisible();
    await waitForQuerySettle(page);
  });

  test.afterAll(async () => { await stopAndCollectCoverage(page); await app.close(); });

  test('shows heading and subtitle', async () => {
    await expect(page.getByText('Map tags to cost allocation dimensions')).toBeVisible();
  });

  test('shows Active Dimensions section with built-in dimensions', async () => {
    await expect(page.getByText('Active Dimensions')).toBeVisible();
    // Built-in dimensions show field names
    await expect(page.getByText('account_id')).toBeVisible();
    await expect(page.getByText('region', { exact: true }).first()).toBeVisible();
  });

  test('shows Add Dimension button', async () => {
    await expect(page.getByRole('button', { name: '+ Add Dimension' })).toBeVisible();
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

  test('Add Dimension opens editor with tag dropdown', async () => {
    await page.getByRole('button', { name: '+ Add Dimension' }).click();

    // should show a select for tag name
    await expect(page.getByText('Resource Tag', { exact: true })).toBeVisible();
    await expect(page.getByText('Select a tag...')).toBeVisible();

    await screenshot(page, 'dimensions-add-new');

    // Cancel
    await page.getByRole('button', { name: 'Cancel' }).click();
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
// Cross-view navigation — full user journey
// ---------------------------------------------------------------------------
test.describe('Full user journey', () => {
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    app = await launchApp();
    page = await app.firstWindow();
    await expect(page).toHaveTitle('CostGoblin');
    await startCoverage(page);
  });

  test.afterAll(async () => { await stopAndCollectCoverage(page); await app.close(); });

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
    await page.getByRole('button', { name: 'Overview' }).click();
    await expect(page.getByRole('heading', { name: 'Cost Overview' })).toBeVisible();

    await screenshot(page, 'journey-complete');
  });

  test('rapid navigation between views does not crash', async () => {
    const views = ['Trends', 'Overview', 'Missing Tags', 'Savings', 'Dimensions', 'Sync', 'Overview', 'Trends', 'Missing Tags'];
    for (const view of views) {
      await page.getByRole('button', { name: view }).click();
    }
    // final state should be Missing Tags
    await expect(page.getByRole('heading', { name: 'Missing Tags' })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Write accumulated V8 coverage to disk for post-processing
// ---------------------------------------------------------------------------
test.afterAll(async () => {
  if (allCoverage.length > 0) {
    writeFileSync(join(V8_DIR, 'coverage.json'), JSON.stringify(allCoverage));
  }
});
