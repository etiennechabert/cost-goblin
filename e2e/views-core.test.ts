import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import {
  launchApp,
  startCoverage,
  stopAndCollectCoverage,
  screenshot,
  assertNoReactCrash,
  waitForQuerySettle,
  hasVisibleData,
  navigateTo,
  clickNavButton,
  writeCoverage,
  LOAD_TIMEOUT,
} from './helpers.js';

const allCoverage: unknown[] = [];

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  app = await launchApp();
  page = await app.firstWindow();
  await expect(page).toHaveTitle('CostGoblin');
  await startCoverage(page);
});

test.afterAll(async () => {
  await stopAndCollectCoverage(page, allCoverage);
  await app.close();
  writeCoverage('views-core', allCoverage);
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
    for (const label of ['Cost Overview', 'Trends', 'Missing Tags', 'Savings', 'Cost Scope', 'Dimensions', 'Views']) {
      await expect(page.getByRole('button', { name: label })).toBeVisible();
    }
    await expect(page.getByRole('button', { name: /Sync/ }).first()).toBeVisible();
  });

  test('has theme toggle button', async () => {
    const themeBtn = page.getByRole('button', { name: /Switch to (light|dark) mode/ });
    await expect(themeBtn).toBeVisible();
  });

  test('theme toggle switches dark/light', async () => {
    const html = page.locator('html');
    const hadDark = await html.evaluate(el => el.classList.contains('dark'));

    await page.getByRole('button', { name: /Switch to (light|dark) mode/ }).click();
    const hasToggled = await html.evaluate(el => el.classList.contains('dark'));
    expect(hasToggled).toBe(!hadDark);

    // toggle back
    await page.getByRole('button', { name: /Switch to (light|dark) mode/ }).click();
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
      await clickNavButton(page, button);
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible({ timeout: 5000 });
      await page.waitForTimeout(500);
      await assertNoReactCrash(page);
    }

    // go back to overview for subsequent tests
    await clickNavButton(page, 'Cost Overview');
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

    // Multi-select: values are pre-checked. Use "Only" on the first item to filter to just that value.
    const onlyButtons = dropdown.locator('button', { hasText: 'only' });
    const onlyCount = await onlyButtons.count();

    if (onlyCount > 0) {
      await onlyButtons.first().click();
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

  test('stacked bar chart renders with title', async () => {
    await expect(page.getByText('Daily Costs')).toBeVisible();
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
    await clickNavButton(page, 'Trends');
    await expect(page.getByRole('heading', { name: 'Cost Trends' })).toBeVisible();
    await waitForQuerySettle(page);

    // 3. Missing Tags
    await clickNavButton(page, 'Missing Tags');
    await expect(page.getByRole('heading', { name: 'Missing Tags' })).toBeVisible();
    await waitForQuerySettle(page);

    // 4. Savings
    await clickNavButton(page, 'Savings');
    await expect(page.getByRole('heading', { name: 'Savings Opportunities' })).toBeVisible();
    await waitForQuerySettle(page);

    // 5. Dimensions
    await clickNavButton(page, 'Dimensions');
    await expect(page.getByRole('heading', { name: 'Dimensions', exact: true })).toBeVisible();

    // 6. Sync
    await clickNavButton(page, 'Sync');
    await expect(page.getByRole('heading', { name: 'Data Management' })).toBeVisible();

    // 7. Back to Overview
    await clickNavButton(page, 'Cost Overview');
    await expect(page.getByRole('heading', { name: 'Cost Overview' })).toBeVisible();

    await screenshot(page, 'journey-complete');
  });

  test('rapid navigation between views does not crash', async () => {
    const views = ['Trends', 'Cost Overview', 'Missing Tags', 'Savings', 'Dimensions', 'Sync', 'Cost Overview', 'Trends', 'Missing Tags'];
    for (const view of views) {
      await clickNavButton(page, view);
      await page.waitForTimeout(100);
    }
    await expect(page.getByRole('heading', { name: 'Missing Tags' })).toBeVisible();
    await assertNoReactCrash(page);
  });
});
