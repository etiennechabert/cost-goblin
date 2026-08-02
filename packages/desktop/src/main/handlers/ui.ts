import { ipcMain } from 'electron';
import { parseJsonObject, isStringRecord } from '@costgoblin/core';
import type { UIPreferences, PerformanceInfo, PerformanceSettings } from '@costgoblin/core';
import { readAppStateSync } from '../workspace-env.js';
import { type AppContext, prefsPath } from './context.js';
import { updatePrefsFile } from './prefs-file.js';
import {
  MAX_MEMORY_GB,
  MIN_MEMORY_GB,
  clampMemoryGB,
  clampRollupConcurrency,
  clampThreads,
  computeDefaultMemoryGB,
  computeDefaultThreads,
  maxRollupConcurrency,
  maxThreads,
  resolveMemoryGB,
  resolveRollupConcurrency,
  resolveThreads,
  totalMemoryGB,
} from '../duckdb-tuning.js';

function parsePerformance(parsed: Record<string, unknown> | null): PerformanceSettings | undefined {
  const perf = parsed?.['performance'];
  if (!isStringRecord(perf)) return undefined;
  const mem = perf['memoryLimitGB'];
  const threads = perf['threads'];
  const rollupConcurrency = perf['rollupConcurrency'];
  return {
    memoryLimitGB: typeof mem === 'number' ? mem : null,
    threads: typeof threads === 'number' ? threads : null,
    rollupConcurrency: typeof rollupConcurrency === 'number' ? rollupConcurrency : null,
  };
}

export function registerUIHandlers(app: AppContext): void {
  const { ctx } = app;

  const uiPrefsPath = () => prefsPath(ctx.stateDir, 'ui-preferences');
  // Theme + chart palette are machine-level (shared across workspaces), stored
  // in app-state.json. In pinned mode (env-overridden paths — dev/e2e) there is
  // no app-state; they stay in the workspace's ui-preferences.json as before.
  const appStatePath = ctx.workspaceEnv.mode === 'workspace' ? ctx.workspaceEnv.appStatePath : null;

  async function readPrefs(): Promise<Record<string, unknown> | null> {
    const fs = await import('node:fs/promises');
    try {
      return parseJsonObject(await fs.readFile(await uiPrefsPath(), 'utf-8'));
    } catch {
      return null;
    }
  }

  ipcMain.handle('ui:get-preferences', async (): Promise<UIPreferences> => {
    const parsed = await readPrefs();
    let theme = parsed?.['theme'];
    let palette = parsed?.['palette'];
    if (appStatePath !== null) {
      // Machine-level values win; the workspace file is only the fallback for
      // a workspace migrated before its theme was copied to app-state.
      const appState = readAppStateSync(appStatePath);
      theme = appState.theme ?? theme;
      palette = appState.palette ?? palette;
    }
    const defaultViewId = parsed?.['defaultViewId'];
    return {
      theme: theme === 'light' || theme === 'dark' ? theme : 'dark',
      palette: palette === 'standard' || palette === 'colorblind' ? palette : 'standard',
      defaultViewId: typeof defaultViewId === 'string' ? defaultViewId : undefined,
      performance: parsePerformance(parsed),
    };
  });

  ipcMain.handle('ui:save-preferences', async (_event, prefs: UIPreferences): Promise<void> => {
    // Serialized merge so saving (e.g.) theme never clobbers the separately-managed
    // `performance` / `telemetry` blocks written through the same file.
    await updatePrefsFile(await uiPrefsPath(), (existing) => ({ ...existing, ...prefs }));
    if (appStatePath !== null) {
      await updatePrefsFile(appStatePath, (existing) => ({ ...existing, theme: prefs.theme, palette: prefs.palette }));
    }
  });

  ipcMain.handle('perf:get-info', async (): Promise<PerformanceInfo> => {
    const current = parsePerformance(await readPrefs()) ?? { memoryLimitGB: null, threads: null, rollupConcurrency: null };
    return {
      defaultMemoryGB: computeDefaultMemoryGB(),
      defaultThreads: computeDefaultThreads(),
      // Clamp the displayed Auto to the real max so "Auto: N · range 1–N" can't
      // contradict itself when the pool cap is below the default.
      defaultRollupConcurrency: resolveRollupConcurrency(null),
      totalMemoryGB: totalMemoryGB(),
      maxThreads: maxThreads(),
      maxRollupConcurrency: maxRollupConcurrency(),
      minMemoryGB: MIN_MEMORY_GB,
      maxMemoryGB: MAX_MEMORY_GB,
      current,
    };
  });

  ipcMain.handle('perf:set', async (_event, perf: PerformanceSettings): Promise<void> => {
    const memoryLimitGB = typeof perf.memoryLimitGB === 'number' ? clampMemoryGB(perf.memoryLimitGB) : null;
    const threads = typeof perf.threads === 'number' ? clampThreads(perf.threads) : null;
    const rollupConcurrency = typeof perf.rollupConcurrency === 'number' ? clampRollupConcurrency(perf.rollupConcurrency) : null;
    await updatePrefsFile(await uiPrefsPath(), (existing) => ({ ...existing, performance: { memoryLimitGB, threads, rollupConcurrency } }));
    // Apply live — memory_limit and threads are instance-global in DuckDB, so a
    // configure on a fresh connection re-tunes the whole instance. Rollup build
    // parallelism takes effect on the next partition-build batch.
    ctx.db.configure({ memoryGB: resolveMemoryGB(memoryLimitGB), threads: resolveThreads(threads) });
    app.rollupStore.setBuildConcurrency(resolveRollupConcurrency(rollupConcurrency));
  });
}
