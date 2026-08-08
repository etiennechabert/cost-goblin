import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { join } from 'node:path';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  DESKTOP_DIR,
  FIXTURE_CONFIG_DIR,
  FIXTURE_DATA_DIR,
  SETTINGS_NAV_LABEL,
  openSettings,
  startCoverage,
  stopAndCollectCoverage,
  writeCoverage,
} from './helpers.js';

// Workspace-mode e2e: unlike every other suite (which pins paths via
// COSTGOBLIN_DATA_DIR/COSTGOBLIN_CONFIG_DIR and therefore runs in "pinned"
// mode with workspace management disabled), this suite seeds a throwaway
// userData tree with a configured `default` workspace and launches with only
// COSTGOBLIN_USER_DATA_DIR — exercising the real workspace resolution path.

let app: ElectronApplication;
let page: Page;
let userDataDir: string;
const allCoverage: unknown[] = [];
let coverageCollected = false;

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
    // A second, unconfigured workspace seeded on disk: UI-driven creation now
    // always restarts into the new workspace (tested last, since it quits the
    // app), so list/chip/rename/delete run against this pre-seeded one.
    for (const sub of ['config', 'data', 'state', 'temp']) {
      mkdirSync(join(userDataDir, 'workspaces', 'client-b', sub), { recursive: true });
    }
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
    // Attach as early as possible: CDP coverage only counts execution after
    // enabling — starting after the boot waits below would report the whole
    // workspace-resolution boot path (this suite's unique contribution) as
    // uncovered.
    await startCoverage(page);
    await expect(page).toHaveTitle('CostGoblin');
    await expect(page.getByRole('heading', { name: 'Cost Overview' })).toBeVisible({ timeout: 15_000 });
  });

  test.afterAll(async () => {
    // Fallback harvest: if the restart test aborted before its in-test
    // collection point (earlier failure, --grep run), salvage what the
    // session has before the app goes away.
    if (!coverageCollected) await stopAndCollectCoverage(page, allCoverage);
    // Write before close: a hung close() must not discard harvested coverage.
    writeCoverage('workspaces', allCoverage);
    await app.close().catch(() => undefined);
    rmSync(userDataDir, { recursive: true, force: true });
  });

  test('settings tab lists both workspaces with active and not-set-up badges', async () => {
    await openWorkspacesTab();
    const row = page.getByTestId('workspace-row-default');
    await expect(row).toBeVisible();
    await expect(row.getByText('Active')).toBeVisible();
    await expect(page.getByTestId('workspace-row-client-b')).toBeVisible();
    await expect(page.getByTestId('workspace-row-client-b').getByText('Not set up')).toBeVisible();
  });

  test('chip shows in the title bar with two workspaces', async () => {
    const chip = page.getByTestId('workspace-chip');
    await expect(chip).toBeVisible();
    await expect(chip).toContainText('default');
  });

  test('create modal validates the name and lists existing workspaces', async () => {
    await openWorkspacesTab();
    await page.getByRole('button', { name: 'New workspace' }).click();
    await expect(page.getByText(/Existing:/)).toBeVisible();
    const nameInput = page.getByLabel('Workspace name');
    await nameInput.fill('bad name!');
    await expect(page.getByText(/letters, digits/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create & Restart' })).toBeDisabled();
    await nameInput.fill('client-x');
    await expect(page.getByRole('button', { name: 'Create & Restart' })).toBeEnabled();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByLabel('Workspace name')).toHaveCount(0);
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

  test('creating a workspace restarts into it (e2e mode quits instead of respawning)', async () => {
    await openWorkspacesTab();
    await page.getByRole('button', { name: 'New workspace' }).click();
    await page.getByLabel('Workspace name').fill('client-d');

    // The click below quits the app, so harvest renderer coverage now — the
    // afterAll runs against an already-closed page where collection would fail.
    await stopAndCollectCoverage(page, allCoverage);
    coverageCollected = true;

    const closed = app.waitForEvent('close');
    await page.getByRole('button', { name: 'Create & Restart' }).click();
    await closed;

    // The next launch resolves into the new (empty) workspace and shows the
    // setup wizard's get-started hub — asserted here via the persisted state.
    const state: unknown = JSON.parse(readFileSync(appStatePath(), 'utf-8'));
    expect(state).toMatchObject({ lastWorkspace: 'client-d' });
    for (const sub of ['config', 'data', 'state', 'temp']) {
      expect(existsSync(join(userDataDir, 'workspaces', 'client-d', sub))).toBe(true);
    }
  });
});
