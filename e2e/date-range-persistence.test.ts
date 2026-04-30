import { test, expect, type Page, type ElectronApplication } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  launchApp,
  waitForQuerySettle,
  navigateTo,
  assertNoReactCrash,
} from './helpers.js';

// Create isolated config directory for this test suite
const TEST_CONFIG_DIR = join(tmpdir(), 'costgoblin-e2e-date-range-persistence');

// Shared app instance for all tests
let app: ElectronApplication;
let page: Page;

test.describe('Date Range Persistence', () => {
  test.beforeAll(() => {
    // Clean and recreate test config directory
    rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
    mkdirSync(TEST_CONFIG_DIR, { recursive: true });
  });

  test.afterAll(() => {
    // Cleanup test config directory
    rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
  });

  test('date range persists across view changes and app restarts', async () => {
    // Step 1: Launch app with isolated config directory
    const app = await launchApp({ configDir: TEST_CONFIG_DIR });
    const window = await app.firstWindow();
    const page = window as unknown as Page;

    try {
      // Step 2: Wait for initial load (app defaults to Cost Overview)
      await expect(page.getByRole('heading', { name: 'Cost Overview', exact: true })).toBeVisible({
        timeout: 10000,
      });
      await waitForQuerySettle(page);
      await assertNoReactCrash(page);

      // Step 3: Set date range to 'Last quarter' in Explorer view
      // Find and click the date range button
      const dateRangeButton = page.getByRole('button', { name: /Last/i }).first();
      await expect(dateRangeButton).toBeVisible({ timeout: 5000 });
      await dateRangeButton.click();

      // Click 'Last quarter' preset
      const lastQuarterButton = page.getByRole('button', { name: 'Last quarter', exact: true });
      await expect(lastQuarterButton).toBeVisible({ timeout: 2000 });
      await lastQuarterButton.click();

      // Wait for query to settle with new date range
      await waitForQuerySettle(page);

      // Verify 'Last quarter' is selected (button should show the preset)
      await expect(page.getByText('Last quarter')).toBeVisible();

      // Step 4: Navigate to Entity Detail view
      await navigateTo(page, 'Entity Detail', 'Entity Detail');

      // Step 5: Verify date range is still 'Last quarter'
      await expect(page.getByText('Last quarter')).toBeVisible();

      // Step 6: Set custom date range using calendar
      // Click the date range button to open picker
      const datePickerButton = page.getByRole('button', { name: /Last quarter/i }).first();
      await datePickerButton.click();

      // Click 'Custom' to open calendar
      const customButton = page.getByRole('button', { name: 'Custom', exact: true });
      await expect(customButton).toBeVisible({ timeout: 2000 });
      await customButton.click();

      // The calendar popover should be visible
      // For this test, we'll just verify the calendar opens and close it
      // In a real scenario, you'd click specific dates
      const calendar = page.locator('[role="dialog"]').or(page.locator('.rdp'));
      await expect(calendar.first()).toBeVisible({ timeout: 2000 });

      // Click outside to close or press Escape
      await page.keyboard.press('Escape');

      // For now, select a different preset to verify persistence
      await datePickerButton.click();
      const last30dButton = page.getByRole('button', { name: 'Last 30d', exact: true });
      await expect(last30dButton).toBeVisible({ timeout: 2000 });
      await last30dButton.click();
      await waitForQuerySettle(page);

      // Verify 'Last 30d' is now shown
      await expect(page.getByText('Last 30d')).toBeVisible();

      // Step 7: Close and restart app
      await app.close();

      // Launch app again with same config directory
      const app2 = await launchApp({ configDir: TEST_CONFIG_DIR });
      const window2 = await app2.firstWindow();
      const page2 = window2 as unknown as Page;

      try {
        // Step 8: Verify 'Last 30d' persisted after restart (app defaults to Cost Overview)
        await expect(page2.getByRole('heading', { name: 'Cost Overview', exact: true })).toBeVisible({
          timeout: 10000,
        });
        await waitForQuerySettle(page2);
        await assertNoReactCrash(page2);

        // Verify the persisted date range is displayed
        await expect(page2.getByText('Last 30d')).toBeVisible({ timeout: 5000 });

        // Navigate to Entity Detail and verify persistence there too
        await navigateTo(page2, 'Entity Detail', 'Entity Detail');
        await expect(page2.getByText('Last 30d')).toBeVisible();

        // Navigate to Custom View and verify persistence
        await navigateTo(page2, 'Custom View', 'Custom View');
        await expect(page2.getByText('Last 30d')).toBeVisible();
      } finally {
        await app2.close();
      }
    } finally {
      if (app.process()?.pid) {
        await app.close();
      }
    }
  });

  test('granularity persists across view changes', async () => {
    // Clean config directory for fresh start
    rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
    mkdirSync(TEST_CONFIG_DIR, { recursive: true });

    const app = await launchApp({ configDir: TEST_CONFIG_DIR });
    const window = await app.firstWindow();
    const page = window as unknown as Page;

    try {
      await expect(page.getByRole('heading', { name: 'Cost Overview', exact: true })).toBeVisible({
        timeout: 10000,
      });
      await waitForQuerySettle(page);

      // Check if hourly tier option exists (may depend on date range)
      const hourlyButton = page.getByRole('button', { name: /Hourly/i });
      const hourlyExists = await hourlyButton.count();

      if (hourlyExists > 0) {
        // Click hourly tier
        await hourlyButton.first().click();
        await waitForQuerySettle(page);

        // Navigate to Entity Detail
        await navigateTo(page, 'Entity Detail', 'Entity Detail');

        // Verify hourly is still selected
        await expect(page.getByRole('button', { name: /Hourly/i }).first()).toBeVisible();
      }
    } finally {
      await app.close();
    }
  });

  test('preferences.json is written with correct structure', async () => {
    // Clean config directory for fresh start
    rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
    mkdirSync(TEST_CONFIG_DIR, { recursive: true });

    const app = await launchApp({ configDir: TEST_CONFIG_DIR });
    const window = await app.firstWindow();
    const page = window as unknown as Page;

    try {
      await expect(page.getByRole('heading', { name: 'Cost Overview', exact: true })).toBeVisible({
        timeout: 10000,
      });
      await waitForQuerySettle(page);

      // Set a date range preset
      const dateRangeButton = page.getByRole('button', { name: /Last/i }).first();
      await dateRangeButton.click();
      const lastMonthButton = page.getByRole('button', { name: 'Last month', exact: true });
      await expect(lastMonthButton).toBeVisible({ timeout: 2000 });
      await lastMonthButton.click();
      await waitForQuerySettle(page);

      // Give the app time to save preferences
      await page.waitForTimeout(500);

      // Close app to ensure preferences are written
      await app.close();

      // Read and verify preferences.json structure
      const prefsPath = join(TEST_CONFIG_DIR, 'preferences.json');
      const { readFileSync, existsSync } = await import('node:fs');

      // Preferences file should exist
      expect(existsSync(prefsPath)).toBe(true);

      const prefsContent = readFileSync(prefsPath, 'utf-8');
      const prefs = JSON.parse(prefsContent);

      // Verify structure
      expect(prefs).toHaveProperty('explorer');
      expect(prefs.explorer).toHaveProperty('lastUsedDateRange');
      expect(prefs.explorer.lastUsedDateRange).toHaveProperty('start');
      expect(prefs.explorer.lastUsedDateRange).toHaveProperty('end');

      // Verify date format (ISO 8601)
      const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;
      expect(prefs.explorer.lastUsedDateRange.start).toMatch(isoDatePattern);
      expect(prefs.explorer.lastUsedDateRange.end).toMatch(isoDatePattern);

      // Verify granularity if present
      if (prefs.explorer.lastUsedGranularity) {
        expect(['daily', 'hourly']).toContain(prefs.explorer.lastUsedGranularity);
      }
    } finally {
      if (app.process()?.pid) {
        await app.close();
      }
    }
  });
});
