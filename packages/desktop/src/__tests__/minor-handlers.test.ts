import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { SEED_VIEWS_CONFIG } from '@costgoblin/core';
import { registerBaselinesHandlers } from '../main/handlers/baselines.js';
import { registerMcpHandlers } from '../main/handlers/mcp-handler.js';
import { registerRollupHandlers } from '../main/handlers/rollup.js';
import { registerSavingsHandlers } from '../main/handlers/savings.js';
import { POST_SETUP_FLAG } from '../main/handlers/setup.js';
import { registerSyncLogHandlers } from '../main/handlers/sync-log.js';
import { registerTelemetryHandlers } from '../main/handlers/telemetry.js';
import { registerUpdateHandlers } from '../main/handlers/update.js';
import { registerViewsHandlers } from '../main/handlers/views.js';
import { regenerateMcpToken, startMcpServer } from '../main/mcp.js';
import { clearSyncLog } from '../main/sync-log.js';
import { app as electronApp, newIpcScope, openFakeWindow, resetElectronFakes, shell } from './helpers/electron-fake.js';
import { at, createHarness, list, type Harness, type HarnessOptions } from './helpers/ipc-harness.js';

/** The small handler modules: rollup status / stats, savings and telemetry
 *  preferences, views seeding / save / reset, the update + relaunch channels,
 *  baselines option defaults, the MCP token, and the sync-log relay — each
 *  with its main→renderer broadcast where it has one. */

const updates = vi.hoisted(() => {
  const listeners: ((status: unknown) => void)[] = [];
  return { listeners };
});

vi.mock('electron', async () => (await import('./helpers/electron-fake.js')).fakeElectronModule);
vi.mock('@sentry/electron/main', async () => (await import('./helpers/electron-fake.js')).fakeSentryModule);
vi.mock('../main/update-manager.js', () => ({
  checkForUpdates: vi.fn(() => Promise.resolve()),
  downloadUpdate: vi.fn(() => Promise.resolve()),
  getStatusSnapshot: vi.fn(() => ({ status: { state: 'idle' } })),
  quitAndInstall: vi.fn(),
  onStatusChanged: vi.fn((listener: (status: unknown) => void) => { updates.listeners.push(listener); }),
}));
vi.mock('../main/mcp.js', () => ({
  startMcpServer: vi.fn(() => Promise.resolve()),
  stopMcpServer: vi.fn(() => Promise.resolve()),
  isMcpServerRunning: vi.fn(() => false),
  getMcpToken: vi.fn(() => 'token-1'),
  regenerateMcpToken: vi.fn(() => Promise.resolve('token-2')),
}));

const harnesses: Harness[] = [];

beforeEach(() => {
  resetElectronFakes();
  updates.listeners.length = 0;
});

afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.dispose();
});

async function harness(options: HarnessOptions = { config: 'single' }): Promise<Harness> {
  const h = await createHarness(options);
  harnesses.push(h);
  return h;
}

describe('rollup channels', () => {
  it('reports status, broadcasts transitions, and has no stats before a build', async () => {
    const h = await harness();
    const win = openFakeWindow();
    registerRollupHandlers(h.app);
    // Subscribing replays the current state to the renderer immediately.
    expect(win.webContents.send).toHaveBeenCalledWith('rollup:status-changed', { state: 'idle' });
    expect(await h.ipc.invoke('rollup:get-status')).toEqual({ state: 'idle' });
    expect(await h.ipc.invoke('rollup:get-stats')).toBeNull();
  });

  it('adds the raw daily size to the built rollup\'s stats', async () => {
    const h = await harness({ config: 'single', data: 'synthetic', rollupBuilds: true });
    registerRollupHandlers(h.app);
    h.app.warmupBase();
    await h.app.awaitWarmup(10_000);
    await vi.waitFor(() => { expect(h.app.rollupStore.getStatus().state).toBe('ready'); }, { timeout: 15_000 });
    const stats = await h.ipc.invoke('rollup:get-stats');
    expect(at(stats, 'months')).toBe(2);
    expect(Number(at(stats, 'rollupRows'))).toBeGreaterThan(0);
    expect(Number(at(stats, 'rawBytes'))).toBeGreaterThan(0);

    // The raw size is best-effort: no provider → 0, stats still served.
    h.app.state.config = { ...(await h.app.getConfig()), providers: [] };
    expect(at(await h.ipc.invoke('rollup:get-stats'), 'rawBytes')).toBe(0);
  });
});

describe('savings preferences', () => {
  it('defaults to nothing hidden and round-trips a saved list', async () => {
    const h = await harness();
    registerSavingsHandlers(h.app);
    expect(await h.ipc.invoke('savings:get-preferences')).toEqual({ hiddenActionTypes: [] });
    await h.ipc.invoke('savings:save-preferences', { hiddenActionTypes: ['Delete', 'Upgrade'] });
    expect(await h.ipc.invoke('savings:get-preferences')).toEqual({ hiddenActionTypes: ['Delete', 'Upgrade'] });
  });

  it('ignores a malformed saved list', async () => {
    const h = await harness();
    registerSavingsHandlers(h.app);
    await writeFile(join(h.ws.stateDir, 'savings-preferences.json'), JSON.stringify({ hiddenActionTypes: ['Delete', 3] }));
    expect(await h.ipc.invoke('savings:get-preferences')).toEqual({ hiddenActionTypes: [] });
  });
});

describe('views channels', () => {
  it('seeds the default views when the file is missing', async () => {
    const h = await harness();
    registerViewsHandlers(h.app);
    await rm(h.ws.viewsPath);
    expect(await h.ipc.invoke('views:get-config')).toEqual(SEED_VIEWS_CONFIG);
    expect(await readFile(h.ws.viewsPath, 'utf-8')).toMatch(/\S/);
    expect(await h.ipc.invoke('views:get-config')).not.toBe(SEED_VIEWS_CONFIG);
  });

  it('validates and saves a views config, and resets to the defaults', async () => {
    const h = await harness();
    registerViewsHandlers(h.app);
    const current = await h.app.getViews();
    const first = current.views[0];
    if (first === undefined) throw new Error('fixture has a view');
    await h.ipc.invoke('views:save-config', { ...current, views: [{ ...first, name: 'Renamed overview' }] });
    expect(JSON.stringify(parse(await readFile(h.ws.viewsPath, 'utf-8')))).toContain('Renamed overview');
    expect(h.app.state.views).toBeNull();
    await expect(h.ipc.invoke('views:save-config', { views: 'nope' })).rejects.toThrow('views must be an array');

    expect(await h.ipc.invoke('views:reset-defaults')).toEqual(SEED_VIEWS_CONFIG);
    expect(JSON.stringify(parse(await readFile(h.ws.viewsPath, 'utf-8')))).not.toContain('Renamed overview');
    await h.ipc.invoke('views:reveal-folder');
    expect(shell.showItemInFolder).toHaveBeenCalledWith(h.ws.viewsPath);
  });
});

describe('telemetry preferences', () => {
  it('defaults to everything off, and persists a normalized choice next to other prefs', async () => {
    const h = await harness();
    registerTelemetryHandlers(h.app);
    const off = await h.ipc.invoke('telemetry:get-preferences');
    expect(off).toMatchObject({ errorReports: false, performance: false });
    const prefsFile = join(h.ws.stateDir, 'ui-preferences.json');
    await writeFile(prefsFile, JSON.stringify({ theme: 'light' }));
    await h.ipc.invoke('telemetry:set-preferences', { errorReports: true, nativeCrashReports: 'yes', performance: false, analytics: true });
    const saved: unknown = JSON.parse(await readFile(prefsFile, 'utf-8'));
    expect(at(saved, 'theme')).toBe('light');
    expect(at(saved, 'telemetry', 'errorReports')).toBe(true);
    expect(at(saved, 'telemetry', 'nativeCrashReports')).toBe(false);
    expect(await h.ipc.invoke('telemetry:get-preferences')).toMatchObject({ errorReports: true });
    expect(at(await h.ipc.invoke('telemetry:get-status'), 'active')).toBe(false);
    expect(await h.ipc.invoke('telemetry:get-outbox')).toEqual([]);
  });
});

describe('update and relaunch channels', () => {
  it('relaunches with the post-setup flag only when asked, dropping a stale one', async () => {
    const h = await harness();
    const ipc = newIpcScope();
    registerUpdateHandlers(h.ws.stateDir);
    process.argv.push(POST_SETUP_FLAG);
    try {
      await ipc.invoke('app:relaunch', false);
      expect(electronApp.relaunch).toHaveBeenLastCalledWith({ args: expect.not.arrayContaining([POST_SETUP_FLAG]) });
      await ipc.invoke('app:relaunch', true);
      const args = electronApp.relaunch.mock.calls.at(-1)?.[0]?.args ?? [];
      expect(args.filter(a => a === POST_SETUP_FLAG)).toHaveLength(1);
    } finally {
      process.argv.splice(process.argv.indexOf(POST_SETUP_FLAG), 1);
    }
    expect(electronApp.quit).toHaveBeenCalledTimes(2);
    expect(await ipc.invoke('update:get-app-version')).toBe('9.9.9-test');
    expect(await ipc.invoke('update:get-status')).toEqual({ status: { state: 'idle' } });
  });

  it('relays update status to every open window, and stores the startup-check preference', async () => {
    const h = await harness();
    const ipc = newIpcScope();
    registerUpdateHandlers(h.ws.stateDir);
    const a = openFakeWindow();
    const b = openFakeWindow();
    for (const listener of updates.listeners) listener({ state: 'available', version: '9.9.10' });
    expect(a.webContents.send).toHaveBeenCalledWith('update:status-changed', { state: 'available', version: '9.9.10' });
    expect(b.webContents.send).toHaveBeenCalledTimes(1);

    await ipc.invoke('update:set-check-on-startup', false);
    expect(await ipc.invoke('update:get-check-on-startup')).toBe(false);
    await ipc.invoke('update:check');
    await ipc.invoke('update:download');
    await ipc.invoke('update:quit-and-install');
  });
});

describe('baselines, MCP and sync-log channels', () => {
  it('recompute defaults its options, and status changes reach the renderer', async () => {
    const h = await harness();
    const recompute = vi.spyOn(h.app.baselineStore, 'recompute').mockResolvedValue(undefined);
    const win = openFakeWindow();
    registerBaselinesHandlers(h.app);
    await h.ipc.invoke('baselines:recompute');
    expect(recompute).toHaveBeenCalledWith(h.app.baselineEngineDeps, {});
    await h.ipc.invoke('baselines:recompute', { startFresh: true });
    expect(recompute).toHaveBeenLastCalledWith(h.app.baselineEngineDeps, { startFresh: true });
    expect(await h.ipc.invoke('baselines:status')).toEqual(h.app.baselineStore.getStatus());
    // Subscribing replays the current status to the open window.
    expect(win.webContents.send).toHaveBeenCalledWith('baselines:status-changed', h.app.baselineStore.getStatus());
    await h.app.baselineStore.resetConfig();
    expect(win.webContents.send.mock.calls.every(c => c[0] === 'baselines:status-changed')).toBe(true);
  });

  it('serves and rotates the MCP token, and persists the enable switch', async () => {
    const h = await harness();
    registerMcpHandlers(h.app);
    expect(await h.ipc.invoke('mcp:get-running')).toBe(false);
    expect(await h.ipc.invoke('mcp:get-token')).toBe('token-1');
    expect(await h.ipc.invoke('mcp:regenerate-token')).toBe('token-2');
    expect(regenerateMcpToken).toHaveBeenCalledTimes(1);
    await h.ipc.invoke('mcp:set-running', true);
    expect(startMcpServer).toHaveBeenCalledWith(h.app);
    expect(JSON.parse(await readFile(join(h.ws.stateDir, 'ui-preferences.json'), 'utf-8'))).toMatchObject({ mcp: { enabled: true } });
    await expect(h.ipc.invoke('mcp:set-running', 'yes')).rejects.toThrow('mcp:set-running expects a boolean');
  });

  it('records renderer lines at a known level, ignores non-text, and relays every append', async () => {
    const ipc = newIpcScope();
    clearSyncLog();
    const win = openFakeWindow();
    registerSyncLogHandlers();
    await ipc.invoke('sync-log:record', 'warn', 'Checking S3');
    await ipc.invoke('sync-log:record', 'shout', 'Defaulted level');
    await ipc.invoke('sync-log:record', 'error', 42);
    for (const level of ['debug', 'error']) await ipc.invoke('sync-log:record', level, `at ${level}`);
    const lines = list(await ipc.invoke('sync-log:get')).map(l => [at(l, 'level'), at(l, 'message')]);
    expect(lines).toEqual([['warn', 'Checking S3'], ['info', 'Defaulted level'], ['debug', 'at debug'], ['error', 'at error']]);
    expect(win.webContents.send).toHaveBeenCalledWith('sync-log:append', expect.objectContaining({ message: 'Checking S3' }));
    await ipc.invoke('sync-log:clear');
    expect(await ipc.invoke('sync-log:get')).toEqual([]);
  });
});
