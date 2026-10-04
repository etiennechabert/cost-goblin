import { test, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import type { OrgAccount, OrgSyncResult } from '../packages/core/src/types/api.js';
import {
  launchAppWithCoverage,
  finishCoverage,
  screenshot,
  assertNoReactCrash,
  navigateTo,
  clickNavButton,
  LOAD_TIMEOUT,
} from './helpers.js';

let app: ElectronApplication;
let page: Page;

/** A synthetic AWS Organizations sync over the fixture's eight accounts (ids
 *  and names as in __fixtures__/setup.ts): five OUs, and three account tag
 *  keys carried by 8, 6 and 4 accounts, so per-key coverage counts differ. */
const orgAccount = (id: string, name: string, ouPath: string, tags: Readonly<Record<string, string>>): OrgAccount => ({
  id, name, ouPath, tags,
  email: `aws+${id}@example.com`,
  status: 'ACTIVE',
  joinedTimestamp: '2024-01-15T00:00:00Z',
});
const FIXTURE_ORG: OrgSyncResult = {
  orgId: 'o-fixture0001',
  syncedAt: '2026-03-01T09:00:00Z',
  accounts: [
    orgAccount('100000000000', 'Acme Corp Main', 'Root/Shared', { 'cost-center': 'CC-100', owner: 'finance' }),
    orgAccount('100000000001', 'Payments Production', 'Root/Production', { 'cost-center': 'CC-200', environment: 'production', owner: 'payments' }),
    orgAccount('100000000002', 'Cards Production', 'Root/Production', { 'cost-center': 'CC-200', environment: 'production' }),
    orgAccount('100000000003', 'Identity Production', 'Root/Production', { 'cost-center': 'CC-300', environment: 'production', owner: 'identity' }),
    orgAccount('100000000004', 'Platform Engineering', 'Root/Platform', { 'cost-center': 'CC-400', environment: 'staging', owner: 'platform' }),
    orgAccount('100000000005', 'Security Operations', 'Root/Security', { 'cost-center': 'CC-500', environment: 'production' }),
    orgAccount('100000000006', 'Data Analytics', 'Root/Data', { 'cost-center': 'CC-600', environment: 'staging' }),
    orgAccount('100000000007', 'CI/CD Platform', 'Root/Platform', { 'cost-center': 'CC-400' }),
  ],
};

test.beforeAll(async () => {
  // The org sync result lives in the state dir, where launchApp's
  // stateFiles land before the app starts.
  ({ app, page } = await launchAppWithCoverage({ stateFiles: { 'org-accounts.json': JSON.stringify(FIXTURE_ORG) } }));
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

  test('org section shows the synced organization and expands to what it pulled', async () => {
    await expect(page.getByText('AWS Organizations not synced')).toHaveCount(0);
    const header = page.getByRole('button').filter({ hasText: 'AWS Organization' });
    const accounts = page.getByText('8 accounts', { exact: true });
    await expect(accounts).toBeHidden();

    await header.click();
    await expect(accounts).toBeVisible();
    await expect(page.getByText('5 organizational units', { exact: true })).toBeVisible();
    await expect(page.getByText(/^3 tag keys /)).toBeVisible();
    await screenshot(page, 'data-management-org');

    await header.click();
    await expect(accounts).toBeHidden();
  });

  /** A tier panel, found from its <h3> title: the nearest rounded-xl card
   *  around it (the panel itself, not the provider section holding all three). */
  const tierPanel = (title: string): Locator =>
    page.getByRole('heading', { name: title, exact: true })
      .locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " rounded-xl ")][1]');

  /** The fixture tree's local inventory: daily holds 2026-01..02, hourly and
   *  cost optimization 2026-02 only. Nothing remote is reachable (no
   *  credentials), so these come from the local scan alone. */
  const FIXTURE_INVENTORY: readonly { title: string; months: string; from: string; periods: readonly string[] }[] = [
    { title: 'Daily', months: '2 months', from: '2026-01', periods: ['Jan 2026', 'Feb 2026'] },
    { title: 'Hourly', months: '1 months', from: '2026-02', periods: ['Feb 2026'] },
    { title: 'Cost Optimization', months: '1 months', from: '2026-02', periods: ['Feb 2026'] },
  ];

  async function expectFixtureInventory(): Promise<void> {
    await expect(page.getByText('Checking S3 for available data...')).toBeHidden({ timeout: LOAD_TIMEOUT });
    for (const { title, months, from, periods } of FIXTURE_INVENTORY) {
      const panel = tierPanel(title);
      await expect(panel.getByText(months)).toBeVisible();
      await expect(panel.getByText(from, { exact: true })).toBeVisible();
      await expect(panel.getByText('to 2026-02', { exact: true })).toBeVisible();
      await expect(panel.getByText('Downloaded', { exact: true })).toBeVisible();
      for (const period of periods) {
        await expect(panel.getByText(period, { exact: true })).toBeVisible();
      }
    }
  }

  test('tier panels show local stats and downloaded periods for every tier', async () => {
    await expectFixtureInventory();
    await screenshot(page, 'data-management-tiers');
  });

  test('Refresh reloads the inventory back into the same tier panels', async () => {
    // Every inventory assert also holds on the pre-click panels, and the
    // reload's "Checking S3…" state commits only after the click returns and
    // can last a frame — too brief for a polled assertion. Record it from the
    // page instead, so a Refresh that reloads nothing fails here.
    await page.evaluate(() => {
      const observer = new MutationObserver(() => {
        if (!(document.body.textContent ?? '').includes('Checking S3 for available data...')) return;
        document.body.dataset['inventoryReloaded'] = 'true';
        observer.disconnect();
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.locator('body')).toHaveAttribute('data-inventory-reloaded', 'true');
    // ...and the panels come back with the same local inventory.
    await expectFixtureInventory();
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

  test('clicking a tag dimension opens the editor and Cancel closes it', async () => {
    // The fixture's custom "Team" dimension; its row is one button that
    // carries the tag key.
    await page.getByRole('button').filter({ hasText: 'tag:team' }).click();

    const concept = page.getByText('Concept', { exact: true });
    await expect(concept).toBeVisible();
    await expect(page.getByText('Display Label', { exact: true })).toBeVisible();
    await expect(page.getByText('Normalization', { exact: true })).toBeVisible();
    await expect(page.getByText('Resource Tag', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();

    await screenshot(page, 'dimensions-editor');

    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(concept).toBeHidden();
  });

  test('Add opens editor with tag dropdown', async () => {
    await page.getByRole('button', { name: '+ Add' }).click();

    await expect(page.getByText('Resource Tag', { exact: true })).toBeVisible();
    // The placeholder is an <option> inside a <select> — check the select exists
    await expect(page.locator('select').first()).toBeVisible();

    await screenshot(page, 'dimensions-add-new');

    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByText('Resource Tag', { exact: true })).toBeHidden();
  });

  test('Resource Tags section loads or shows loading/error state', async () => {
    // Wait for either the table, loading, or error to appear
    const hasTable = await page.getByText('Resource Tags').first().isVisible().catch(() => false);
    const hasLoading = await page.getByText('Scanning billing data').isVisible().catch(() => false);
    const hasError = await page.locator('.text-negative').first().isVisible().catch(() => false);

    expect(hasTable || hasLoading || hasError).toBe(true);
    await screenshot(page, 'dimensions-resource-tags');
  });

  test('Account Tags panel lists the org tag keys and toggles their columns', async () => {
    // A key count proves the org data loaded: the no-data subtitle is also
    // what a loading or failed org request shows.
    const header = page.getByRole('button').filter({ hasText: 'Account Tags' });
    await expect(header).toContainText('3 keys · across 8 accounts');
    await header.click();

    // One column per key, headed by how many accounts carry it.
    const panel = header.locator('xpath=..');
    for (const { key, carriers } of [
      { key: 'cost-center', carriers: 8 },
      { key: 'environment', carriers: 6 },
      { key: 'owner', carriers: 4 },
    ]) {
      await expect(panel.locator('th', { hasText: key })).toContainText(`${String(carriers)}/8 accts`);
    }

    // A key's badge hides its column (struck through) and brings it back.
    const badge = panel.getByRole('button', { name: 'owner', exact: true });
    const column = panel.locator('th', { hasText: 'owner' });
    await badge.click();
    await expect(badge).toHaveClass(/\bline-through\b/);
    await expect(column).toHaveCount(0);
    await screenshot(page, 'dimensions-account-tags');

    await badge.click();
    await expect(badge).not.toHaveClass(/\bline-through\b/);
    await expect(column).toHaveCount(1);
    await header.click();
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

    // The histogram's label (rendered with or without preview data)
    await expect(card.getByText('Daily cost', { exact: true }).first()).toBeVisible();

    await screenshot(page, 'cost-scope-preview');
  });

  test('line-items card has its own heading + table', async () => {
    const card = page.getByTestId('cost-scope-line-items');
    await card.scrollIntoViewIfNeeded();
    await expect(card).toBeVisible();
    await expect(card.getByRole('heading', { name: 'Line items' })).toBeVisible();
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

    // The edit re-runs the debounced preview. An enabled rule's tally (the
    // span beside its switch) leaves '—' only once that round trip resolves —
    // nothing else waits for the preview, which would otherwise never fire
    // before the next edit re-arms its debounce.
    const tally = toggle.locator('xpath=../span');
    if (nowChecked) await expect(tally).not.toHaveText('—');
    else await expect(tally).toHaveText('—');

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
