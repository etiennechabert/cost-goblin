import { ipcMain } from 'electron';
import { parseJsonObject, isStringRecord } from '@costgoblin/core';
import type { UIPreferences, PerformanceInfo, PerformanceSettings } from '@costgoblin/core';
import { type AppContext, prefsPath } from './context.js';
import {
  MAX_MEMORY_GB,
  MIN_MEMORY_GB,
  clampMemoryGB,
  clampThreads,
  computeDefaultMemoryGB,
  computeDefaultThreads,
  maxThreads,
  resolveMemoryGB,
  resolveThreads,
  totalMemoryGB,
} from '../duckdb-tuning.js';

function parsePerformance(parsed: Record<string, unknown> | null): PerformanceSettings | undefined {
  const perf = parsed?.['performance'];
  if (!isStringRecord(perf)) return undefined;
  const mem = perf['memoryLimitGB'];
  const threads = perf['threads'];
  return {
    memoryLimitGB: typeof mem === 'number' ? mem : null,
    threads: typeof threads === 'number' ? threads : null,
  };
}

export function registerUIHandlers(app: AppContext): void {
  const { ctx } = app;

  const uiPrefsPath = () => prefsPath(ctx.dataDir, 'ui-preferences');

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
    const theme = parsed?.['theme'];
    const palette = parsed?.['palette'];
    const defaultViewId = parsed?.['defaultViewId'];
    return {
      theme: theme === 'light' || theme === 'dark' ? theme : 'dark',
      palette: palette === 'standard' || palette === 'colorblind' ? palette : 'standard',
      defaultViewId: typeof defaultViewId === 'string' ? defaultViewId : undefined,
      performance: parsePerformance(parsed),
    };
  });

  ipcMain.handle('ui:save-preferences', async (_event, prefs: UIPreferences): Promise<void> => {
    const fs = await import('node:fs/promises');
    // Merge into the existing file so saving (e.g.) theme never clobbers the
    // separately-managed `performance` block, and vice versa.
    const existing = (await readPrefs()) ?? {};
    const merged = { ...existing, ...prefs };
    await fs.writeFile(await uiPrefsPath(), JSON.stringify(merged, null, 2));
  });

  ipcMain.handle('perf:get-info', async (): Promise<PerformanceInfo> => {
    const current = parsePerformance(await readPrefs()) ?? { memoryLimitGB: null, threads: null };
    return {
      defaultMemoryGB: computeDefaultMemoryGB(),
      defaultThreads: computeDefaultThreads(),
      totalMemoryGB: totalMemoryGB(),
      maxThreads: maxThreads(),
      minMemoryGB: MIN_MEMORY_GB,
      maxMemoryGB: MAX_MEMORY_GB,
      current,
    };
  });

  ipcMain.handle('perf:set', async (_event, perf: PerformanceSettings): Promise<void> => {
    const fs = await import('node:fs/promises');
    const memoryLimitGB = typeof perf.memoryLimitGB === 'number' ? clampMemoryGB(perf.memoryLimitGB) : null;
    const threads = typeof perf.threads === 'number' ? clampThreads(perf.threads) : null;
    const existing = (await readPrefs()) ?? {};
    const merged = { ...existing, performance: { memoryLimitGB, threads } };
    await fs.writeFile(await uiPrefsPath(), JSON.stringify(merged, null, 2));
    // Apply live — memory_limit and threads are instance-global in DuckDB, so a
    // configure on a fresh connection re-tunes the whole instance.
    ctx.db.configure({ memoryGB: resolveMemoryGB(memoryLimitGB), threads: resolveThreads(threads) });
  });
}
