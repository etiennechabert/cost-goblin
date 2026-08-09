import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { closeApp, launchApp } from './helpers.js';

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  app = await launchApp();
  page = await app.firstWindow();
  await expect(page).toHaveTitle('CostGoblin');
});

test.afterAll(async () => {
  await closeApp(app);
});

test('renderer is sandboxed', async () => {
  const sandboxed = await page.evaluate(() => {
    const debug = (window as { costgoblinDebug?: { isSandboxed: () => boolean } }).costgoblinDebug;
    return debug?.isSandboxed() ?? false;
  });
  expect(sandboxed).toBe(true);
});
