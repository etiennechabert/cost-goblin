import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import {
  launchAppWithCoverage,
  finishCoverage,
  screenshot,
  assertNoReactCrash,
  waitForQuerySettle,
  waitForCostScopePreview,
  costScopePreviewBars,
  navigateTo,
  clickNavButton,
  LOAD_TIMEOUT,
} from './helpers.js';

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  ({ app, page } = await launchAppWithCoverage());
});

test.afterAll(async () => {
  await finishCoverage(app, page, 'views-config');
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

  test('shows action buttons and the automatic schedule controls', async () => {
    // One-off actions plus the auto-sync / auto-prune schedule, which lives
    // here (not the top toolbar) since it automates these very controls.
    await expect(page.getByRole('button', { name: /Prune/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete All Data' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open Folder' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible();
    await expect(page.getByText('Automatic schedule')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Toggle auto-sync' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Toggle auto-prune' })).toBeVisible();
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

  test('Prune removes nothing: main measures retention from the pinned clock too', async () => {
    // As of FIXTURE_NOW every fixture month is inside its tier's window
    // (hourly 30d, cost-opt 90d, daily 365d), so the renderer counts nothing
    // to prune and the button reads plain "Prune". Main must decide from the
    // same date: on the wall clock it would delete the Feb-2026 hourly and
    // cost-optimization months.
    await page.getByRole('button', { name: 'Prune', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Prune', exact: true }).click();
    await expect(page.getByText('Nothing to prune — all local data is within retention.')).toBeVisible({ timeout: LOAD_TIMEOUT });
  });

  test('Add Provider and the tier gear open their setup wizard dialogs and Close dismisses them', async () => {
    // Two different wizard dialogs behind two buttons: the header's Add
    // Provider and the Daily panel's gear. Role queries reach them only
    // because the dialogs are no longer inside an aria-hidden overlay.
    for (const { trigger, dialogName, shot } of [
      { trigger: 'Add Provider', dialogName: 'Add provider', shot: 'add-provider' },
      { trigger: 'Configure daily', dialogName: /^Configure daily data source for /, shot: 'daily' },
    ]) {
      await page.getByRole('button', { name: trigger, exact: true }).first().click();
      const dialog = page.getByRole('dialog', { name: dialogName });
      await expect(dialog).toBeVisible();
      await screenshot(page, `data-management-modal-${shot}`);
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(dialog).toBeHidden();
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

  test('Resource Tags panel lists the fixture tag keys and toggles their columns', async () => {
    // Discovery samples the 30 days before the main process's clock. The
    // window's start date proves main honours COSTGOBLIN_NOW; on the wall
    // clock the sample would hold no fixture rows and report 0 keys.
    const header = page.getByRole('button').filter({ hasText: 'Resource Tags' });
    await header.click();
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    await expect(header).toContainText('3 keys · sampled from last 30 days (since 2026-01-31)', { timeout: LOAD_TIMEOUT });

    // One badge and one sample-value column per discovered key.
    const panel = header.locator('xpath=..');
    for (const key of ['environment', 'team', 'system']) {
      await expect(panel.getByRole('button', { name: key, exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(panel.locator('th', { hasText: key })).toHaveCount(1);
    }

    // A key's badge hides its column and brings it back.
    const badge = panel.getByRole('button', { name: 'team', exact: true });
    const column = panel.locator('th', { hasText: 'team' });
    await badge.click();
    await expect(badge).toHaveAttribute('aria-pressed', 'false');
    await expect(badge).toHaveClass(/\bline-through\b/);
    await expect(column).toHaveCount(0);
    await screenshot(page, 'dimensions-badge-toggled');

    await badge.click();
    await expect(badge).toHaveAttribute('aria-pressed', 'true');
    await expect(column).toHaveCount(1);
    await header.click();
    await expect(header).toHaveAttribute('aria-expanded', 'false');
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

  test('cost metric picker lists the four FOCUS metrics (CUR-era names retired)', async () => {
    await expect(page.getByRole('heading', { name: 'Cost metric' })).toBeVisible();
    // Check the actual radio values, which are unique — the labels repeat
    // in adjacent description copy so role/name queries are ambiguous.
    await expect(page.locator('input[type="radio"][value="effective"]')).toBeVisible();
    await expect(page.locator('input[type="radio"][value="billed"]')).toBeVisible();
    await expect(page.locator('input[type="radio"][value="list"]')).toBeVisible();
    await expect(page.locator('input[type="radio"][value="contracted"]')).toBeVisible();
    // CUR-era metric names are gone; legacy configs are migrated at load
    // time (unblended → billed, amortized/blended → effective).
    await expect(page.locator('input[type="radio"][value="unblended"]')).toHaveCount(0);
    await expect(page.locator('input[type="radio"][value="amortized"]')).toHaveCount(0);

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

  test('preview histogram plots every day of the fixture window', async () => {
    // Main computes the window from the pinned clock: the 30 days ending at
    // the 2-day lag before FIXTURE_NOW, every one of them a fixture day.
    const bars = costScopePreviewBars(page);
    await expect(bars).toHaveCount(30);
    await expect(bars.first()).toHaveAttribute('title', /^2026-01-30\nkept: /);
    await expect(bars.last()).toHaveAttribute('title', /^2026-02-28\nkept: /);
    const card = page.getByTestId('cost-scope-preview').filter({ visible: true });
    await expect(card.getByText('2026-01-30', { exact: true })).toBeVisible();
    await expect(card.getByText('2026-02-28', { exact: true })).toBeVisible();

    await bars.first().hover();
    await screenshot(page, 'cost-scope-histogram-hover');
  });

  test('line-items table renders the fixture window rows', async () => {
    const lineItemsCard = page.getByTestId('cost-scope-line-items');
    await lineItemsCard.scrollIntoViewIfNeeded();
    // The preview window always holds fixture data (see the histogram test),
    // so the table must render.
    const table = lineItemsCard.locator('table');
    await expect(table).toBeVisible();

    // Fixed columns lead in scan order; one column per tag dimension follows
    // (the fixture's `system` tag is labelled "Service", so that name repeats).
    const headers = await table.locator('thead th').allTextContents();
    expect(headers.slice(0, 7)).toEqual(['Date', 'Cost', 'List', 'Service', 'Account', 'Charge category', 'Region']);
    expect(headers).toEqual(expect.arrayContaining(['Team', 'Environment']));

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
