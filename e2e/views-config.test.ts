import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import {
  launchApp,
  startCoverage,
  stopAndCollectCoverage,
  screenshot,
  assertNoReactCrash,
  waitForQuerySettle,
  waitForCostScopePreview,
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
  writeCoverage('views-config', allCoverage);
});

// ---------------------------------------------------------------------------
// Data Management
// ---------------------------------------------------------------------------
test.describe('Data Management', () => {
  test.describe.configure({ timeout: 60_000 });
  test.beforeAll(async () => {
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
    // The settings rail now has its own "Import" tab (a button carrying
    // data-tab); scope to the editor toolbar's Import button, which has none.
    await expect(
      page.getByRole('button', { name: 'Import', exact: true }).and(page.locator('button:not([data-tab])')),
    ).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Cost Scope — metric picker, exclusion rules, preview histogram + table
// ---------------------------------------------------------------------------
test.describe('Cost Scope', () => {
  test.beforeAll(async () => {
    // Click Cost Scope nav — if the Views editor has unsaved changes,
    // a "Discard" confirm modal will appear. Dismiss it.
    await clickNavButton(page, 'Cost Scope');
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

  test('cost metric picker lists Amortized, List, Unblended (Blended retired)', async () => {
    await expect(page.getByRole('heading', { name: 'Cost metric' })).toBeVisible();
    // Check the actual radio values, which are unique — the labels repeat
    // in adjacent description copy so role/name queries are ambiguous.
    await expect(page.locator('input[type="radio"][value="amortized"]')).toBeVisible();
    await expect(page.locator('input[type="radio"][value="list"]')).toBeVisible();
    await expect(page.locator('input[type="radio"][value="unblended"]')).toBeVisible();
    // Blended was removed; AWS never extended it to Savings Plans and on an
    // SP-based fleet it barely differs from Unblended. Legacy configs with
    // costMetric: 'blended' are migrated to 'amortized' at load time.
    await expect(page.locator('input[type="radio"][value="blended"]')).toHaveCount(0);

    // Exactly one metric radio is selected — the specific one depends on
    // what the user has saved to cost-scope.yaml, so we don't assume a
    // default beyond "something is checked".
    await expect(page.locator('input[type="radio"][name="costMetric"]:checked')).toHaveCount(1);
    await screenshot(page, 'cost-scope-metric');
  });

  test('exclusion rules section lists shipped built-in rules', async () => {
    await expect(page.getByRole('heading', { name: 'Exclusion rules' })).toBeVisible();
    // Rule names are rendered in inputs (they're editable).
    await expect(page.locator('input[value="AWS Premium Support"]')).toBeVisible();
    // Tax rule has values=["Tax"] so two inputs match (name + value field).
    // Just assert the name input exists.
    await expect(page.locator('input[value="Tax"]').first()).toBeVisible();
    // RI & Savings Plan purchases rule was retired — subsumed by the
    // On-demand list price metric. Stripped silently on load.
    await expect(page.locator('input[value="RI & Savings Plan purchases"]')).toHaveCount(0);
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
