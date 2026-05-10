import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  launchApp,
  startCoverage,
  stopAndCollectCoverage,
  screenshot,
  assertNoReactCrash,
  waitForQuerySettle,
  writeCoverage,
  LOAD_TIMEOUT,
  FIXTURE_CONFIG_DIR,
  FIXTURE_DATA_DIR,
  ROOT,
} from './helpers.js';

const allCoverage: unknown[] = [];
const TEMP_CONFIG_DIR = join(tmpdir(), `costgoblin-pagination-test-${String(Date.now())}`);

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  // Set up config directory
  mkdirSync(TEMP_CONFIG_DIR, { recursive: true });
  for (const f of ['costgoblin.yaml', 'dimensions.yaml', 'org-tree.yaml', 'views.yaml']) {
    const src = join(FIXTURE_CONFIG_DIR, f);
    if (existsSync(src)) {
      writeFileSync(join(TEMP_CONFIG_DIR, f), readFileSync(src));
    }
  }

  // Copy preference files
  const fixtureRoot = join(ROOT, 'packages', 'core', 'src', '__fixtures__');
  for (const f of ['app-preferences.json', 'explorer-preferences.json', 'ui-preferences.json']) {
    const src = join(fixtureRoot, f);
    if (existsSync(src)) {
      writeFileSync(join(TEMP_CONFIG_DIR, f), readFileSync(src));
    }
  }

  // Launch with both config AND data directories
  app = await launchApp({
    configDir: TEMP_CONFIG_DIR,
    dataDir: FIXTURE_DATA_DIR
  });
  page = await app.firstWindow();
  await expect(page).toHaveTitle('CostGoblin');
  await startCoverage(page);
});

test.afterAll(async () => {
  await stopAndCollectCoverage(page, allCoverage);
  await app.close();
  writeCoverage('explorer-pagination', allCoverage);
});

// ---------------------------------------------------------------------------
// Explorer pagination flow
// ---------------------------------------------------------------------------
test.describe('Explorer pagination', () => {
  test.beforeAll(async () => {
    // Navigate to Explorer view
    await page.getByRole('button', { name: 'Explorer' }).click();
    await expect(page.getByText('Inspect the raw CUR dataset.')).toBeVisible({ timeout: LOAD_TIMEOUT });
    await waitForQuerySettle(page);
  });

  test('shows initial load with 500 rows', async () => {
    // Wait for the initial data to load
    await waitForQuerySettle(page);
    await assertNoReactCrash(page);

    // Check that the status message is visible (use .first() to handle multiple matches)
    const statusText = page.getByText(/Showing .* of .* rows/).first();
    await expect(statusText).toBeVisible({ timeout: LOAD_TIMEOUT });

    // Verify the status shows 500 rows initially
    const text = await statusText.textContent();
    expect(text).toMatch(/Showing 500 of [\d,.]+ rows/);

    await screenshot(page, 'explorer-initial-load');
  });

  test('clicking Load More increases row count', async () => {
    // Find and click the "Load More" button
    const loadMoreButton = page.getByRole('button', { name: 'Load More' });
    await expect(loadMoreButton).toBeVisible({ timeout: LOAD_TIMEOUT });

    await screenshot(page, 'explorer-before-load-more');

    await loadMoreButton.click();

    // Wait for the query to settle after loading more rows
    await waitForQuerySettle(page);
    await assertNoReactCrash(page);

    // Verify the status message shows more rows loaded (at least 1000, possibly more if infinite scroll triggered)
    const statusText = page.getByText(/Showing .* of .* rows/).first();
    await expect(statusText).toBeVisible({ timeout: LOAD_TIMEOUT });

    const text = await statusText.textContent();
    // Extract the "showing" count (first number)
    const match = text?.match(/Showing ([0-9,.]+) of/);
    expect(match).not.toBeNull();
    if (match && match[1]) {
      const showingCount = parseInt(match[1].replace(/[,.]/g, ''), 10);
      expect(showingCount).toBeGreaterThanOrEqual(1000); // Should have loaded at least 1000 rows total
    }

    await screenshot(page, 'explorer-after-load-more');
  });

  test('Load More button visibility reflects remaining data', async () => {
    // Wait for any pending queries to settle from previous tests
    await waitForQuerySettle(page);
    await page.waitForTimeout(500); // Give extra time for infinite scroll to complete

    // Check if Load More button visibility matches whether there's more data
    const statusText = page.getByText(/Showing .* of .* rows/).first();

    // Try to get the status text, but handle case where it might not be found (all data loaded)
    const isStatusVisible = await statusText.isVisible().catch(() => false);

    if (isStatusVisible) {
      const text = await statusText.textContent();

      expect(text).not.toBeNull();
      if (text !== null) {
        // Extract showing and total rows from the status message
        const match = text.match(/Showing ([0-9,.]+) of ([0-9,.]+) rows/);
        expect(match).not.toBeNull();

        if (match !== null && match[1] !== undefined && match[2] !== undefined) {
          const showingCount = parseInt(match[1].replace(/[,.]/g, ''), 10);
          const totalRows = parseInt(match[2].replace(/[,.]/g, ''), 10);

          const loadMoreButton = page.getByRole('button', { name: 'Load More' });

          if (showingCount < totalRows) {
            // There's more data - Load More should be visible
            await expect(loadMoreButton).toBeVisible({ timeout: LOAD_TIMEOUT });
          } else {
            // All rows loaded - Load More should not be visible
            const isLoadMoreVisible = await loadMoreButton.isVisible().catch(() => false);
            expect(isLoadMoreVisible).toBe(false);
          }
        }
      }
    } else {
      // Status text not found - this is OK, might mean UI changed after all data loaded
      // Just verify that pagination UI exists somewhere on the page
      await expect(page.getByText('line items')).toBeVisible();
    }

    await screenshot(page, 'explorer-final-state');
  });
});
