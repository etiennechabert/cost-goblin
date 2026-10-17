import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseWorkspaceName } from '@costgoblin/core';
import { registerUIHandlers } from '../main/handlers/ui.js';
import { MAX_MEMORY_GB, MIN_MEMORY_GB, maxThreads, totalMemoryGB } from '../main/duckdb-tuning.js';
import { at, createHarness, num, type Harness, type TestWorkspace } from './helpers/ipc-harness.js';
import type { IpcContext } from '../main/handlers/context.js';

/** UI preferences and the Performance settings: where theme + palette live in
 *  pinned vs workspace mode, the tolerant read of a hand-edited prefs file,
 *  and the clamp-persist-apply path of perf:set. */

vi.mock('electron', async () => (await import('./helpers/electron-fake.js')).fakeElectronModule);
vi.mock('@sentry/electron/main', async () => (await import('./helpers/electron-fake.js')).fakeSentryModule);

const harnesses: Harness[] = [];

afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.dispose();
});

function appStatePath(ws: TestWorkspace): string {
  return join(ws.root, 'app-state.json');
}

/** Workspace mode keeps machine-level prefs in app-state.json. */
function workspaceMode(ws: TestWorkspace): Partial<IpcContext> {
  return {
    workspaceEnv: {
      mode: 'workspace', name: parseWorkspaceName('default'), workspacesRoot: ws.root, appStatePath: appStatePath(ws),
      dataDir: ws.dataDir, configBase: ws.configDir, stateDir: ws.stateDir, tempDir: ws.tempDir,
    },
  };
}

async function uiApp(mode: 'pinned' | 'workspace' = 'pinned'): Promise<Harness> {
  const h = await createHarness({ config: 'none', ...(mode === 'workspace' ? { overrides: workspaceMode } : {}) });
  registerUIHandlers(h.app);
  harnesses.push(h);
  return h;
}

const prefsFile = (h: Harness): string => join(h.ws.stateDir, 'ui-preferences.json');

describe('ui:get-preferences / ui:save-preferences', () => {
  it('defaults to dark + standard with nothing saved', async () => {
    const h = await uiApp();
    expect(await h.ipc.invoke('ui:get-preferences')).toEqual({ theme: 'dark', palette: 'standard', defaultViewId: undefined, performance: undefined });
  });

  it('round-trips prefs through the workspace file in pinned mode, keeping other blocks', async () => {
    const h = await uiApp();
    await writeFile(prefsFile(h), JSON.stringify({ telemetry: { errorReports: true } }));
    await h.ipc.invoke('ui:save-preferences', { theme: 'light', palette: 'colorblind', defaultViewId: 'overview' });
    expect(await h.ipc.invoke('ui:get-preferences')).toEqual({ theme: 'light', palette: 'colorblind', defaultViewId: 'overview', performance: undefined });
    expect(JSON.parse(await readFile(prefsFile(h), 'utf-8'))).toMatchObject({ telemetry: { errorReports: true } });
  });

  it('ignores values it does not recognise and a prefs file that is not JSON', async () => {
    const h = await uiApp();
    await writeFile(prefsFile(h), JSON.stringify({ theme: 'neon', palette: 3, defaultViewId: 9, performance: 'fast' }));
    expect(await h.ipc.invoke('ui:get-preferences')).toEqual({ theme: 'dark', palette: 'standard', defaultViewId: undefined, performance: undefined });
    await writeFile(prefsFile(h), '{ broken');
    expect(at(await h.ipc.invoke('ui:get-preferences'), 'theme')).toBe('dark');
  });

  it('starts a save from scratch when the prefs file holds something other than an object', async () => {
    const h = await uiApp();
    await writeFile(prefsFile(h), '[1, 2, 3]');
    await h.ipc.invoke('ui:save-preferences', { theme: 'light', palette: 'standard' });
    expect(JSON.parse(await readFile(prefsFile(h), 'utf-8'))).toEqual({ theme: 'light', palette: 'standard' });
  });

  it('keeps theme + palette machine-level in workspace mode, falling back to the workspace file', async () => {
    const h = await uiApp('workspace');
    await writeFile(prefsFile(h), JSON.stringify({ theme: 'light', palette: 'colorblind' }));
    // No app-state yet: the migrated workspace file still answers.
    expect(await h.ipc.invoke('ui:get-preferences')).toMatchObject({ theme: 'light', palette: 'colorblind' });
    await writeFile(appStatePath(h.ws), JSON.stringify({ theme: 'dark', palette: 'standard' }));
    expect(await h.ipc.invoke('ui:get-preferences')).toMatchObject({ theme: 'dark', palette: 'standard' });

    await h.ipc.invoke('ui:save-preferences', { theme: 'light', palette: 'standard' });
    expect(JSON.parse(await readFile(appStatePath(h.ws), 'utf-8'))).toMatchObject({ theme: 'light', palette: 'standard' });
  });
});

describe('Performance settings', () => {
  it('reports defaults and limits with no override saved', async () => {
    const h = await uiApp();
    const info = await h.ipc.invoke('perf:get-info');
    expect(at(info, 'current')).toEqual({ memoryLimitGB: null, threads: null, rollupConcurrency: null });
    expect(at(info, 'minMemoryGB')).toBe(MIN_MEMORY_GB);
    expect(at(info, 'maxMemoryGB')).toBe(MAX_MEMORY_GB);
    expect(at(info, 'maxThreads')).toBe(maxThreads());
    expect(num(at(info, 'defaultRollupConcurrency'))).toBeLessThanOrEqual(num(at(info, 'maxRollupConcurrency')));
  });

  it('clamps, persists and applies an override live', async () => {
    const h = await uiApp();
    const concurrency = vi.spyOn(h.app.rollupStore, 'setBuildConcurrency');
    await h.ipc.invoke('perf:set', { memoryLimitGB: 10_000, threads: 0, rollupConcurrency: 1 });
    // The memory ceiling is MAX_MEMORY_GB or the machine's RAM, whichever is
    // lower — a 16 GB CI runner clamps to 16.
    const ceiling = Math.max(MIN_MEMORY_GB, Math.min(MAX_MEMORY_GB, totalMemoryGB()));
    const saved = at(JSON.parse(await readFile(prefsFile(h), 'utf-8')), 'performance');
    expect(at(saved, 'memoryLimitGB')).toBe(ceiling);
    expect(at(saved, 'threads')).toBe(1);
    expect(at(saved, 'rollupConcurrency')).toBe(1);
    expect(h.db.configure).toHaveBeenCalledWith({ memoryGB: ceiling, threads: 1 });
    expect(concurrency).toHaveBeenCalledWith(1);
    expect(at(await h.ipc.invoke('perf:get-info'), 'current')).toEqual({ memoryLimitGB: ceiling, threads: 1, rollupConcurrency: 1 });
  });

  it('treats non-numeric fields as "Auto"', async () => {
    const h = await uiApp();
    await h.ipc.invoke('perf:set', { memoryLimitGB: null, threads: 'many', rollupConcurrency: undefined });
    expect(at(JSON.parse(await readFile(prefsFile(h), 'utf-8')), 'performance')).toEqual({ memoryLimitGB: null, threads: null, rollupConcurrency: null });
    const applied = h.db.configure.mock.calls[0]?.[0];
    expect(typeof applied?.memoryGB).toBe('number');
    expect(typeof applied?.threads).toBe('number');
    await writeFile(prefsFile(h), JSON.stringify({ performance: { memoryLimitGB: '4', threads: 2 } }));
    expect(at(await h.ipc.invoke('ui:get-preferences'), 'performance')).toEqual({ memoryLimitGB: null, threads: 2, rollupConcurrency: null });
    await writeFile(prefsFile(h), JSON.stringify({ performance: { memoryLimitGB: 6, threads: 'two', rollupConcurrency: 3 } }));
    expect(at(await h.ipc.invoke('perf:get-info'), 'current')).toEqual({ memoryLimitGB: 6, threads: null, rollupConcurrency: 3 });
  });
});
