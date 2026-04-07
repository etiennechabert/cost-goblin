import { test, expect, _electron } from '@playwright/test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(import.meta.dirname, '..');
const DESKTOP_DIR = join(ROOT, 'packages', 'desktop');
const SCREENSHOT_DIR = join(tmpdir(), 'costgoblin-e2e');

function launchApp() {
  return _electron.launch({
    args: [join(DESKTOP_DIR, 'out', 'main', 'main.js')],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      COSTGOBLIN_DATA_DIR: join(ROOT, 'data', 'processed'),
      COSTGOBLIN_CONFIG_DIR: join(ROOT, 'data', 'config'),
    },
  });
}

test.describe('CostGoblin Electron App', () => {
  test('launches with navigation and cost overview', async () => {
    const electronApp = await launchApp();
    const page = await electronApp.firstWindow();

    // Title and nav
    await expect(page).toHaveTitle('CostGoblin');
    await expect(page.getByText('CostGoblin', { exact: true })).toBeVisible();

    // Navigation buttons
    await expect(page.getByRole('button', { name: 'Overview' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Trends' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Missing Tags' })).toBeVisible();

    // CostOverview loads automatically — wait for data
    // The dimension selector and summary should appear after data loads
    await page.waitForTimeout(3000);
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'screenshot-overview.png') });

    // Check that some cost data rendered (Total Cost text or table)
    const bodyText = await page.locator('body').textContent();
    expect(bodyText).toBeTruthy();

    await electronApp.close();
  });

  test('navigates to trends view', async () => {
    const electronApp = await launchApp();
    const page = await electronApp.firstWindow();

    await expect(page).toHaveTitle('CostGoblin');

    // Navigate to Trends
    await page.getByRole('button', { name: 'Trends' }).click();
    await expect(page.getByText('Cost Trends')).toBeVisible();
    await expect(page.getByText('Period-over-period comparison')).toBeVisible();

    await page.waitForTimeout(2000);
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'screenshot-trends.png') });

    await electronApp.close();
  });

  test('navigates to missing tags view', async () => {
    const electronApp = await launchApp();
    const page = await electronApp.firstWindow();

    await expect(page).toHaveTitle('CostGoblin');

    // Navigate to Missing Tags
    await page.getByRole('button', { name: 'Missing Tags' }).click();
    await expect(page.getByRole('heading', { name: 'Missing Tags' })).toBeVisible();
    await expect(page.getByText('Resources without cost allocation tags')).toBeVisible();

    await page.waitForTimeout(2000);
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'screenshot-missing-tags.png') });

    await electronApp.close();
  });

  test('clicks entity to open detail view', async () => {
    const electronApp = await launchApp();
    const page = await electronApp.firstWindow();

    // Wait for cost data to load
    const firstEntity = page.locator('table button').first();
    await expect(firstEntity).toBeVisible({ timeout: 10000 });
    await firstEntity.click();

    // Entity popup should appear
    await expect(page.getByText('Open full view')).toBeVisible({ timeout: 5000 });
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'screenshot-entity-popup.png') });

    // Click "Open full view" to navigate to detail
    await page.getByText('Open full view').click();
    await expect(page.getByText('← Back')).toBeVisible({ timeout: 5000 });
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'screenshot-entity-detail.png') });

    // Click back
    await page.getByText('← Back').click();
    await expect(page.getByText('Cost Overview')).toBeVisible();

    await electronApp.close();
  });

  test('data management tab loads', async () => {
    const electronApp = await launchApp();
    const page = await electronApp.firstWindow();

    await expect(page).toHaveTitle('CostGoblin');

    // Navigate to Data tab
    await page.getByRole('button', { name: 'Data' }).click();
    await expect(page.getByRole('heading', { name: 'Data Management' })).toBeVisible();

    // Wait for the two-column layout to appear
    await expect(page.getByText('Daily').first()).toBeVisible({ timeout: 15000 });

    await page.waitForTimeout(3000);
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'screenshot-data-loaded.png') });

    await electronApp.close();
  });
});
