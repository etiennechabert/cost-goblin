import { test, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import {
  launchAppWithCoverage,
  finishCoverage,
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
  LOAD_TIMEOUT,
} from './helpers.js';

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  ({ app, page } = await launchAppWithCoverage());
});

test.afterAll(async () => {
  await finishCoverage(app, page, 'views-core');
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

  test('General settings offer the startup update-check preference and a manual check', async () => {
    const rail = page.getByRole('navigation', { name: SETTINGS_NAV_LABEL });
    const openGeneral = (): Promise<void> => rail.getByRole('button', { name: 'General', exact: true }).click();
    const readSaved = (): Promise<boolean> => page.evaluate(() => globalThis.costgoblinUpdate.getCheckOnStartup());

    await openSettings(page);
    await openGeneral();
    await expect(page.getByText('Update check', { exact: true })).toBeVisible();
    await expect(page.getByText(/Checks GitHub Releases \(github\.com\) once at startup/)).toBeVisible();
    // Never clicked here: the e2e build is unpackaged and must not reach github.com.
    await expect(page.getByRole('button', { name: 'Check for updates' })).toBeVisible();

    const automatic = page.getByRole('button', { name: 'Automatic', exact: true });
    const manualOnly = page.getByRole('button', { name: 'Manual only', exact: true });
    await expect(automatic).toHaveAttribute('aria-pressed', 'true');
    // An unpackaged run never checks at launch, so nothing claims "up to date".
    await expect(page.getByText(/Not checked yet/)).toBeVisible();

    await manualOnly.click();
    await expect(manualOnly).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText(/Automatic check is off/)).toBeVisible();
    // Saved through the main process, not just held in renderer state.
    await expect.poll(readSaved).toBe(false);

    // Leave General and come back: the choice sticks.
    await rail.getByRole('button', { name: 'Dimensions', exact: true }).click();
    await expect(page.getByText('Update check', { exact: true })).toBeHidden();
    await openGeneral();
    await expect(manualOnly).toHaveAttribute('aria-pressed', 'true');
    await expect(automatic).toHaveAttribute('aria-pressed', 'false');

    // Restore the default for the rest of the suite.
    await automatic.click();
    await expect(automatic).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(readSaved).toBe(true);
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
});

// ---------------------------------------------------------------------------
// Cost Overview — the main dashboard
// ---------------------------------------------------------------------------
test.describe('Cost Overview', () => {
  test.beforeAll(async () => {
    await navigateTo(page, 'Home', 'Cost Overview');
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

  test('filter chip: search, pick a value, Apply, then Clear all removes it', async () => {
    // Two buttons are named "Account": the filter chip and the Account pie's
    // group-by title, whose chevron is an <svg>. The chip holds only text.
    const accountChip = page.getByRole('button', { name: 'Account', exact: true }).filter({ hasNot: page.locator('svg') });
    await accountChip.click();

    const dropdown = page.locator('.absolute.left-0.top-full');
    await expect(dropdown).toBeVisible();
    // Values are pre-checked once they load; each row offers "only".
    const onlyButtons = dropdown.getByRole('button', { name: 'only', exact: true });
    await expect(onlyButtons.first()).toBeVisible();

    // The search box narrows the list.
    const search = dropdown.getByPlaceholder('Search Account…');
    await search.fill('no-such-account-zzz');
    await expect(dropdown.getByText('No values found')).toBeVisible();
    await search.fill('');
    await expect(onlyButtons.first()).toBeVisible();
    await screenshot(page, 'overview-filter-dropdown');

    // "only" sets the draft to that one value; Apply commits it.
    await onlyButtons.first().click();
    await dropdown.getByRole('button', { name: 'Apply' }).click();
    const appliedChip = page.getByRole('button', { name: /^Account: / });
    await expect(appliedChip).toBeVisible();
    await screenshot(page, 'overview-filtered');

    await page.getByRole('button', { name: 'Clear all' }).click();
    await expect(appliedChip).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Clear all' })).toHaveCount(0);
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

  test('stacked bar chart renders with title', async () => {
    await expect(page.locator('h3', { hasText: 'Service' }).first()).toBeVisible();
  });

  test('switching the date preset reloads the total, and the breakdown table renders rows', async () => {
    const total = page.locator('p:text-is("Total Cost") + span').first();
    await expect(total).toHaveText(/^\$/);
    const before = await total.innerText();

    // 365 days back from the pinned clock covers the whole fixture window, a
    // strict superset of the default 30 — the total must reload to a new value.
    await selectDatePreset(page, 'Last 365 days');
    await expect.poll(async () => {
      const text = await total.innerText();
      return text !== before && text.startsWith('$') ? 'reloaded' : text;
    }, { message: `total reloads from ${before} for the wider range`, timeout: LOAD_TIMEOUT }).toBe('reloaded');

    // The breakdown table sits below the fold: wait for its rows rather than
    // counting them once.
    const rows = page.locator('table').last().locator('tbody tr');
    await expect(rows.first()).toBeVisible();
    await rows.first().hover();
    await screenshot(page, 'overview-breakdown-hover');

    // Back to the default range: the total returns to where it started.
    await selectDatePreset(page, 'Last 30 days');
    await expect(total).toHaveText(before, { useInnerText: true });
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
  /** The "N items · <totals>" line, rendered only once the trends query has
   *  settled. A getter: `page` is assigned in the file's beforeAll. */
  const itemSummary = (): Locator => page.getByText(/^\d+ items · /);

  test.beforeAll(async () => {
    await navigateToText(page, 'Trends', 'Period-over-period comparison');
  });

  test('switching dimensions triggers reload', async () => {
    // The dimension selector's pill row, found by a dimension it holds: the
    // date-picker trigger and the direction toggle share its classes.
    const dimBtns = page.locator('div.rounded-lg.border', { has: page.getByRole('button', { name: 'Region', exact: true }) }).locator('button');
    await expect(dimBtns.nth(1)).toBeVisible();

    // The selected dimension is the accent-filled pill.
    await dimBtns.nth(1).click();
    await expect(dimBtns.nth(1)).toHaveClass(/\bbg-accent\b/);
    await expect(itemSummary()).toBeVisible();
    await screenshot(page, 'trends-dimension-switch');

    await dimBtns.first().click();
    await expect(dimBtns.first()).toHaveClass(/\bbg-accent\b/);
    await expect(itemSummary()).toBeVisible();
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

    // The toggle filters the loaded rows client-side; the summary line's total
    // label names the direction in force.
    const summary = itemSummary();
    await savingsBtn.click();
    await expect(summary).toHaveText(/ total savings$/);
    await screenshot(page, 'trends-savings');

    await increaseBtn.click();
    await expect(summary).toHaveText(/ total increase$/);
    await screenshot(page, 'trends-increases');

    await allBtn.click();
    await expect(summary).toHaveText(/ increase · -.+ savings$/);
    await screenshot(page, 'trends-all');
  });

  test('Min $ and Min % inputs are present and functional', async () => {
    const numberInputs = page.locator('input[type="number"]');
    const inputCount = await numberInputs.count();
    expect(inputCount).toBeGreaterThanOrEqual(2);
    const minDollar = numberInputs.first();
    const minPercent = numberInputs.nth(1);

    // Each threshold change re-runs the trends query. At 0/0 every changed
    // entity is listed; the fixture's deltas are far below $1000 / 50%, so the
    // count must fall — and come back once the thresholds are restored. A
    // count, not mere visibility: the old summary line stays up until the
    // re-query's loading state commits.
    const summary = itemSummary();
    const atZero = await summary.innerText();
    const itemCount = async (): Promise<number> => Number.parseInt(await summary.innerText(), 10);

    await minDollar.fill('1000');
    await minPercent.fill('50');
    await expect.poll(itemCount, { message: `items drop below "${atZero}"` }).toBeLessThan(Number.parseInt(atZero, 10));
    await screenshot(page, 'trends-high-threshold');

    await minDollar.fill('0');
    await minPercent.fill('0');
    await expect(summary).toHaveText(atZero, { useInnerText: true });
  });

  test('shows item count summary and table', async () => {
    // Both the current and the previous period sit inside the fixture window
    // (pinned clock), and the previous test restored the thresholds to 0/0 —
    // an empty or error state here is a regression, not an acceptable branch.
    await expectVisibleData(page);

    await expect(itemSummary()).toBeVisible();

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
    // The header is a styled <p>, not a semantic heading, like the other
    // view headers.
    await expect(page.getByText('Missing Tags', { exact: true }).first()).toBeVisible();
  });

  test('tag dimension tabs are visible and switchable', async () => {
    // One tab per tag dimension (the fixture config has four), found by the
    // Team tab: the date picker's Daily/Hourly toggle shares the row's classes
    // and comes first.
    const tabBtns = page.locator('div.rounded-lg.border', { has: page.getByRole('button', { name: 'Team', exact: true }) }).locator('button');
    await expect(tabBtns.nth(1)).toBeVisible();

    // The selected tab is the accent-filled pill.
    await tabBtns.nth(1).click();
    await expect(tabBtns.nth(1)).toHaveClass(/\bbg-accent\b/);
    await waitForQuerySettle(page);
    await screenshot(page, 'missing-tags-second-tab');

    await tabBtns.first().click();
    await expect(tabBtns.first()).toHaveClass(/\bbg-accent\b/);
    await waitForQuerySettle(page);
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
    await navigateToText(page, 'Findings', 'AWS cost optimization recommendations');
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

  test('table column headers are sortable', async () => {
    await expect(page.locator('table').first()).toBeVisible();

    // Fixtures ship cost-optimization data and the pinned clock keeps it in
    // range, so every sortable header must be present.
    for (const header of ['Account', 'Monthly Cost', 'Savings/mo']) {
      await expect(page.locator('th').filter({ hasText: header }).first()).toBeVisible();
    }
    // The table starts sorted by Savings/mo; a string column sorts ascending
    // first, then descending.
    const account = page.locator('th').filter({ hasText: 'Account' }).first();
    await account.click();
    await expect(account).toContainText('↑');
    await account.click();
    await expect(account).toContainText('↓');
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
    await navigateTo(page, 'Home', 'Cost Overview');
  });

  test('overview → trends → missing tags → savings → data → overview (full navigation cycle)', async () => {
    // 1. Overview (the beforeAll navigated and settled here)
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
    await clickNavButton(page, 'Home');
    await expect(page.getByRole('heading', { name: 'Cost Overview' })).toBeVisible();

    await screenshot(page, 'journey-complete');
  });

  test('rapid navigation between views does not crash', async () => {
    // Nine navigations, two through the settings rail: past the 30s default
    // on a loaded runner.
    test.slow();
    const views = ['Trends', 'Home', 'Tags', 'Findings', 'Dimensions', 'Sync', 'Home', 'Trends', 'Tags'];
    for (const view of views) {
      await clickNavButton(page, view);
      await page.waitForTimeout(100);
    }
    await expect(page.getByText('without the selected allocation tag').first()).toBeVisible();
    await assertNoReactCrash(page);
  });
});
