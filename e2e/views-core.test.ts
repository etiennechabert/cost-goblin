import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import {
  launchApp,
  closeApp,
  startCoverage,
  stopAndCollectCoverage,
  screenshot,
  assertNoReactCrash,
  waitForQuerySettle,
  expectVisibleData,
  navigateTo,
  navigateToText,
  selectDatePreset,
  clickNavButton,
  openSettings,
  ensureViewMode,
  SETTINGS_NAV_LABEL,
  writeCoverage,
  LOAD_TIMEOUT,
} from './helpers.js';

const allCoverage: unknown[] = [];

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  app = await launchApp();
  page = await app.firstWindow();
  // Attach before any other await: the title is static HTML, so awaiting it
  // first lets the module bundle win the race, and functions that ran
  // pre-attach are simply ABSENT from V8's report. v8-to-istanbul treats an
  // absent function as covered (it zeroes down from "all covered"), so a lost
  // race inflates this shard toward 100%. collect-coverage.ts fails the run
  // if it detects one.
  await startCoverage(page);
  await expect(page).toHaveTitle('CostGoblin');
});

test.afterAll(async () => {
  await stopAndCollectCoverage(page, allCoverage);
  // Write before close: a hung or rejected close() must not discard the
  // coverage already harvested (writeCoverage is synchronous).
  writeCoverage('views-core', allCoverage);
  await closeApp(app);
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
    // View-mode nav buttons + the Settings gear.
    for (const label of ['Dashboards', 'Trends', 'Tags', 'Findings', 'Explorer']) {
      await expect(page.getByRole('button', { name: label, exact: false }).first()).toBeVisible();
    }
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
    // Configuration pages live as tabs in the settings rail.
    await openSettings(page);
    const rail = page.getByRole('navigation', { name: SETTINGS_NAV_LABEL });
    for (const label of ['Cost Scope', 'Dimensions', 'Dashboards', 'Data & Sync']) {
      await expect(rail.getByRole('button', { name: label, exact: true })).toBeVisible();
    }
    await ensureViewMode(page);
  });

  test('has theme toggle in General settings', async () => {
    await openSettings(page);
    await page.getByRole('navigation', { name: SETTINGS_NAV_LABEL }).getByRole('button', { name: 'General', exact: true }).click();
    // Theme is a segmented Dark / Light control.
    await expect(page.getByRole('button', { name: 'Dark', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Light', exact: true })).toBeVisible();
    await ensureViewMode(page);
  });

  test('theme toggle switches dark/light', async () => {
    const html = page.locator('html');
    const hadDark = await html.evaluate(el => el.classList.contains('dark'));

    await openSettings(page);
    await page.getByRole('navigation', { name: SETTINGS_NAV_LABEL }).getByRole('button', { name: 'General', exact: true }).click();
    // Clicking the inactive segment flips the theme.
    await page.getByRole('button', { name: hadDark ? 'Light' : 'Dark', exact: true }).click();
    const hasToggled = await html.evaluate(el => el.classList.contains('dark'));
    expect(hasToggled).toBe(!hadDark);

    await page.getByRole('button', { name: hadDark ? 'Dark' : 'Light', exact: true }).click();
    const restored = await html.evaluate(el => el.classList.contains('dark'));
    expect(restored).toBe(hadDark);
    await ensureViewMode(page);
  });

  test('navigating between all views changes active content', async () => {
    const views: { button: string; marker: { type: 'heading'; name: string } | { type: 'text'; text: string } }[] = [
      { button: 'Cost Overview', marker: { type: 'heading', name: 'Cost Overview' } },
      { button: 'Trends', marker: { type: 'text', text: 'Period-over-period comparison' } },
      { button: 'Tags', marker: { type: 'text', text: 'without the selected allocation tag' } },
      { button: 'Findings', marker: { type: 'text', text: 'cost optimization recommendations' } },
      { button: 'Cost Scope', marker: { type: 'heading', name: 'Cost Scope' } },
      { button: 'Dimensions', marker: { type: 'heading', name: 'Dimensions' } },
      { button: 'Sync', marker: { type: 'heading', name: 'Data Management' } },
    ];

    for (const { button, marker } of views) {
      await clickNavButton(page, button);
      if (marker.type === 'heading') {
        await expect(page.getByRole('heading', { name: marker.name, exact: true })).toBeVisible({ timeout: 5000 });
      } else {
        await expect(page.getByText(marker.text, { exact: false }).first()).toBeVisible({ timeout: 5000 });
      }
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

    // Fixture data plus the pinned COSTGOBLIN_NOW clock guarantee the default
    // range holds data — "—" or $0.00 here means the pipeline broke.
    await expect(page.locator('.tabular-nums').first()).toBeVisible();
    await expectVisibleData(page);

    await screenshot(page, 'overview-summary');
  });

  test('renders date range picker popover with presets', async () => {
    const trigger = page.locator('button:has(svg.lucide-calendar)');
    await expect(trigger).toBeVisible();

    await trigger.click();
    const popover = page.locator('[data-radix-popper-content-wrapper]');
    await expect(popover).toBeVisible({ timeout: 5000 });

    await expect(popover.getByText('Days', { exact: true })).toBeVisible();
    await expect(popover.getByText('Period', { exact: true })).toBeVisible();
    await expect(popover.getByText('Custom range…')).toBeVisible();

    await trigger.click();
  });

  test('switching date range preset triggers a reload', async () => {
    await selectDatePreset(page, 'Last 90 days');
    await waitForQuerySettle(page);

    // 90 days back from the pinned clock covers the whole fixture window, so
    // the reloaded total must be a real dollar amount.
    await expectVisibleData(page);

    // switch back
    await selectDatePreset(page, 'Last 30 days');
    await waitForQuerySettle(page);
  });

  test('custom date range inputs appear when Custom range is clicked', async () => {
    const trigger = page.locator('button:has(svg.lucide-calendar)').first();
    await trigger.click();
    const popover = page.locator('[data-radix-popper-content-wrapper]');
    await expect(popover).toBeVisible({ timeout: 5000 });
    await popover.getByText('Custom range…').click();

    await expect(popover.getByText('From', { exact: true })).toBeVisible();
    await expect(popover.getByText('To', { exact: true })).toBeVisible();

    await page.keyboard.press('Escape');
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
      // "only" sets the draft — click Apply to commit the filter
      const applyBtn = dropdown.getByRole('button', { name: 'Apply' });
      await applyBtn.click();
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
    // The seed Cost Overview shows three pie widgets grouped by Account, Region
    // and Service (seed-views.ts). Dashboard pies render as an <svg> under an
    // <h3> title — no dimension <select> — and the pinned clock keeps the range
    // in data, so assert the pie headings appear rather than silently skipping.
    // Account and Region are pie-only here (Service is also the stacked-bar
    // title), so checking those two confirms the pies rendered.
    await expect(page.getByRole('heading', { name: 'Account', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Region', exact: true })).toBeVisible();
    await screenshot(page, 'overview-pie-charts');
  });

  test('pie chart dimension dropdown switches the dimension', async () => {
    // Only target visible, enabled selects (pie chart dropdowns) — guard
    // against any hidden/disabled selects other widgets might render.
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
    await expect(page.locator('h3', { hasText: 'Service' }).first()).toBeVisible();
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

  test('breakdown table renders rows for the fixture range', async () => {
    await selectDatePreset(page, 'Last 365 days');
    await waitForQuerySettle(page);

    await expectVisibleData(page);
    const tables = page.locator('table');
    expect(await tables.count()).toBeGreaterThan(0);

    const rows = tables.last().locator('tbody tr');
    expect(await rows.count()).toBeGreaterThan(0);
    await rows.first().hover();
    await screenshot(page, 'overview-breakdown-hover');

    await selectDatePreset(page, 'Last 30 days');
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
    await navigateToText(page, 'Trends', 'Period-over-period comparison');
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

  test('All/Increase/Savings toggle is present and clickable', async () => {
    // Toggle now has three options. The nav bar also has a "Findings" /
    // "Savings"-flavoured button, so scope to the bordered pill group.
    const toggleContainer = page.locator('.flex.items-center.gap-1.rounded-lg.border').nth(1);
    const allBtn = toggleContainer.getByRole('button', { name: 'All', exact: true });
    const increaseBtn = toggleContainer.getByRole('button', { name: 'Increase', exact: true });
    const savingsBtn = toggleContainer.getByRole('button', { name: 'Savings', exact: true });

    await expect(allBtn).toBeVisible();
    await expect(increaseBtn).toBeVisible();
    await expect(savingsBtn).toBeVisible();

    await savingsBtn.click();
    await waitForQuerySettle(page);
    await screenshot(page, 'trends-savings');

    await increaseBtn.click();
    await waitForQuerySettle(page);
    await screenshot(page, 'trends-increases');

    await allBtn.click();
    await waitForQuerySettle(page);
    await screenshot(page, 'trends-all');
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
    await minDollar.fill('0');
    await minPercent.fill('0');
    await waitForQuerySettle(page);
  });

  test('shows item count summary and table', async () => {
    // Both the current and the previous period sit inside the fixture window
    // (pinned clock), and the previous test restored the thresholds to 0/0 —
    // an empty or error state here is a regression, not an acceptable branch.
    await expectVisibleData(page);

    const summaryLine = page.locator('text=/\\d+ items/');
    await expect(summaryLine.first()).toBeVisible();

    await expect(page.locator('table').first()).toBeVisible();
    for (const col of ['Entity', 'Current', 'Previous', 'Delta', 'Change']) {
      await expect(page.getByText(col, { exact: true }).first()).toBeVisible();
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

  test('clicking entity in table opens the default dashboard filtered to it', async () => {
    // Thresholds sit at 0/0 (restored two tests up) and the fixture window is
    // in range, so the table must offer at least one entity link.
    const entityLink = page.locator('table button.text-accent').first();
    await expect(entityLink).toBeVisible({ timeout: 5000 });
    await entityLink.click();

    // Entity click routes to the first dashboard with the entity applied as a
    // filter (App.handleEntityClick) — the standalone Entity Detail page is no
    // longer reachable in the app.
    await expect(page.getByRole('heading', { name: 'Cost Overview' })).toBeVisible({ timeout: 5000 });
    await waitForQuerySettle(page);
    await expect(page.getByRole('button', { name: 'Clear all' })).toBeVisible();
    await screenshot(page, 'trends-entity-click-filtered');

    // clear the filter so later blocks start from an unfiltered overview
    await page.getByRole('button', { name: 'Clear all' }).click();
    await waitForQuerySettle(page);
  });
});

// ---------------------------------------------------------------------------
// Missing Tags
// ---------------------------------------------------------------------------
test.describe('Missing Tags', () => {
  test.beforeAll(async () => {
    await navigateToText(page, 'Tags', 'without the selected allocation tag');
  });

  test('shows heading and subtitle', async () => {
    // The header is no longer a semantic heading — it's a styled <p> now,
    // matching the other view headers.
    await expect(page.getByText('Missing Tags', { exact: true }).first()).toBeVisible();
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

  test('shows the Actionable section once data loads', async () => {
    // Min cost 0 → every untagged resource qualifies. With the pinned clock
    // the range is inside the fixture window, so rows must appear — the old
    // "no data is also valid" branch only ever hid the fixture-clock gap.
    const minCostInput = page.locator('input[type="number"]');
    await minCostInput.fill('0');
    await waitForQuerySettle(page);

    await expectVisibleData(page);
    await expect(page.getByText('Actionable', { exact: false }).first()).toBeVisible();
    await expect(page.getByText('untagged resources in taggable categories').first()).toBeVisible();
    await screenshot(page, 'missing-tags-state');

    // restore the default threshold
    await minCostInput.fill('50');
    await waitForQuerySettle(page);
  });

  test('table renders with proper columns', async () => {
    const table = page.locator('table');
    await expect(table.first()).toBeVisible();

    for (const header of ['Account', 'Resource', 'Service', 'Service Category', 'Cost', 'Fallback Team']) {
      await expect(page.locator('th').filter({ hasText: header }).first()).toBeVisible();
    }

    const rows = table.first().locator('tbody tr');
    expect(await rows.count()).toBeGreaterThan(0);
    await rows.first().hover();
    await screenshot(page, 'missing-tags-row-hover');
  });
});

// ---------------------------------------------------------------------------
// Savings Opportunities
// ---------------------------------------------------------------------------
test.describe('Findings', () => {
  test.beforeAll(async () => {
    await navigateToText(page, 'Findings', 'cost optimization recommendations');
  });

  test('shows heading and subtitle', async () => {
    await expect(page.getByText('AWS cost optimization recommendations')).toBeVisible();
  });

  test('shows the recommendations summary and table', async () => {
    // The synthetic fixtures ship cost-optimization data, so the loaded state
    // is the only acceptable one — the old tri-state check let a stale label
    // pass as "empty state" forever.
    await expect(page.getByText(/potential savings/).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /^All \(/ }).first()).toBeVisible();
    await expect(page.locator('table').first()).toBeVisible();

    await screenshot(page, 'savings-state');
  });

  test('action type filter pills work', async () => {
    const pills = page.locator('button.rounded-full');
    expect(await pills.count()).toBeGreaterThan(1);

    // click a filter pill
    await pills.nth(1).click();
    await screenshot(page, 'savings-filtered');

    // click first pill to reset (All)
    await pills.first().click();
  });

  test('table column headers are sortable', async () => {
    await expect(page.locator('table').first()).toBeVisible();

    // Fixtures ship cost-optimization data and the pinned clock keeps it in
    // range, so every sortable header must be present — assert each is visible,
    // then exercise the ascending/descending sort toggles.
    for (const header of ['Account', 'Monthly Cost', 'Savings/mo']) {
      const th = page.locator('th').filter({ hasText: header }).first();
      await expect(th).toBeVisible();
      await th.click();
      await th.click(); // click again to reverse sort
    }
    await screenshot(page, 'savings-sorted');
  });

  test('clicking a recommendation row expands/collapses detail', async () => {
    const rows = page.locator('table tbody tr.cursor-pointer');
    expect(await rows.count()).toBeGreaterThan(0);

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
    await expect(page.getByText('Period-over-period comparison').first()).toBeVisible();
    await waitForQuerySettle(page);

    // 3. Tags
    await clickNavButton(page, 'Tags');
    await expect(page.getByText('without the selected allocation tag').first()).toBeVisible();
    await waitForQuerySettle(page);

    // 4. Findings
    await clickNavButton(page, 'Findings');
    await expect(page.getByText('cost optimization recommendations').first()).toBeVisible();
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
    const views = ['Trends', 'Cost Overview', 'Tags', 'Findings', 'Dimensions', 'Sync', 'Cost Overview', 'Trends', 'Tags'];
    for (const view of views) {
      await clickNavButton(page, view);
      await page.waitForTimeout(100);
    }
    await expect(page.getByText('without the selected allocation tag').first()).toBeVisible();
    await assertNoReactCrash(page);
  });
});
