import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { join } from 'node:path';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DESKTOP_DIR, FIXTURE_CONFIG_DIR, FIXTURE_DATA_DIR, SETTINGS_NAV_LABEL, openSettings } from './helpers.js';

// Workspace-mode e2e: unlike every other suite (which pins paths via
// COSTGOBLIN_DATA_DIR/COSTGOBLIN_CONFIG_DIR and therefore runs in "pinned"
// mode with workspace management disabled), this suite seeds a throwaway
// userData tree with a configured `default` workspace and launches with only
// COSTGOBLIN_USER_DATA_DIR — exercising the real workspace resolution path.

let app: ElectronApplication;
let page: Page;
let userDataDir: string;

function appStatePath(): string {
  return join(userDataDir, 'app-state.json');
}

async function openWorkspacesTab(): Promise<void> {
  await openSettings(page);
  await page.getByLabel(SETTINGS_NAV_LABEL).getByRole('button', { name: 'Workspaces' }).click();
  await expect(page.getByRole('heading', { name: 'Workspaces' })).toBeVisible();
}

test.describe('Workspaces (workspace mode)', () => {
  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'cg-e2e-userdata-'));
    const wsRoot = join(userDataDir, 'workspaces', 'default');
    mkdirSync(join(wsRoot, 'state'), { recursive: true });
    mkdirSync(join(wsRoot, 'temp'), { recursive: true });
    cpSync(FIXTURE_CONFIG_DIR, join(wsRoot, 'config'), { recursive: true });
    cpSync(FIXTURE_DATA_DIR, join(wsRoot, 'data'), { recursive: true });
    writeFileSync(
      appStatePath(),
      JSON.stringify({ schemaVersion: 1, lastWorkspace: 'default', lastUsed: { default: new Date().toISOString() } }),
    );

    // Strip the pinned-mode env vars the outer runner may carry — their
    // presence would flip the app into pinned mode and hide the feature.
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue;
      if (key === 'COSTGOBLIN_DATA_DIR' || key === 'COSTGOBLIN_CONFIG_DIR') continue;
      env[key] = value;
    }
    app = await _electron.launch({
      args: [join(DESKTOP_DIR, 'out', 'main', 'main.js')],
      env: { ...env, NODE_ENV: 'production', COSTGOBLIN_E2E: '1', COSTGOBLIN_USER_DATA_DIR: userDataDir },
    });
    // Surface main-process logs in the test output — a silent main-side quit
    // or crash is otherwise invisible from the renderer.
    app.process().stdout?.on('data', (chunk: Buffer) => { console.log(`[main] ${chunk.toString().trimEnd()}`); });
    app.process().stderr?.on('data', (chunk: Buffer) => { console.log(`[main:err] ${chunk.toString().trimEnd()}`); });
    page = await app.firstWindow();
    await expect(page).toHaveTitle('CostGoblin');
    await expect(page.getByRole('heading', { name: 'Cost Overview' })).toBeVisible({ timeout: 15_000 });
  });

  test.afterAll(async () => {
    await app.close().catch(() => undefined);
    rmSync(userDataDir, { recursive: true, force: true });
  });

  test('settings tab lists the active default workspace', async () => {
    await openWorkspacesTab();
    const row = page.getByTestId('workspace-row-default');
    await expect(row).toBeVisible();
    await expect(row.getByText('Active')).toBeVisible();
    // Single workspace ⇒ no switcher chip in the title bar.
    await expect(page.getByTestId('workspace-chip')).toHaveCount(0);
  });

  test('creates a second workspace without switching', async () => {
    await openWorkspacesTab();
    await page.getByRole('button', { name: 'New workspace' }).click();
    const nameInput = page.getByLabel('Workspace name');
    await nameInput.fill('bad name!');
    await expect(page.getByText(/letters, digits/i)).toBeVisible();
    await nameInput.fill('client-b');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByTestId('workspace-row-client-b')).toBeVisible();
    await expect(page.getByTestId('workspace-row-client-b').getByText('Not set up')).toBeVisible();
  });

  test('chip appears in the title bar once two workspaces exist', async () => {
    const chip = page.getByTestId('workspace-chip');
    await expect(chip).toBeVisible();
    await expect(chip).toContainText('default');
  });

  test('renames an inactive workspace', async () => {
    await openWorkspacesTab();
    await page.getByTestId('workspace-row-client-b').getByRole('button', { name: 'Rename' }).click();
    const input = page.getByLabel('New name');
    await input.fill('client-c');
    await page.getByRole('button', { name: 'Rename', exact: true }).last().click();
    await expect(page.getByTestId('workspace-row-client-c')).toBeVisible();
    await expect(page.getByTestId('workspace-row-client-b')).toHaveCount(0);
  });

  test('deletes an inactive workspace after confirmation', async () => {
    await openWorkspacesTab();
    await page.getByTestId('workspace-row-client-c').getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByText(/permanently deletes/i)).toBeVisible();
    await page.getByRole('button', { name: 'Delete Workspace' }).click();
    await expect(page.getByTestId('workspace-row-client-c')).toHaveCount(0);
    // Back to one workspace ⇒ chip hides again.
    await expect(page.getByTestId('workspace-chip')).toHaveCount(0);
  });

  test('switching persists the target workspace and quits (e2e mode skips respawn)', async () => {
    await openWorkspacesTab();
    await page.getByRole('button', { name: 'New workspace' }).click();
    await page.getByLabel('Workspace name').fill('client-d');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByTestId('workspace-row-client-d')).toBeVisible();

    const closed = app.waitForEvent('close');
    await page.getByTestId('workspace-row-client-d').getByRole('button', { name: 'Switch' }).click();
    await page.getByRole('button', { name: 'Switch & Restart' }).click();
    await closed;

    const state: unknown = JSON.parse(readFileSync(appStatePath(), 'utf-8'));
    expect(state).toMatchObject({ lastWorkspace: 'client-d' });
  });
});
