import { ipcMain } from 'electron';
import type { AppContext } from './context.js';
import { queryFilterValues, type FilterValue } from './filter-values.js';
import { originStore } from '../query-log.js';

export function registerFilterHandlers(app: AppContext): void {
  const { ctx, getQueryDimensions, getAccountMap, getAccountReverseMap, getOrgAccountsPath, getCostScope, getQueryProviders, runPreparedQuery, rollupStore } = app;
  const deps = { dataDir: ctx.dataDir, getQueryDimensions, getAccountMap, getAccountReverseMap, getOrgAccountsPath, getCostScope, getQueryProviders, runPreparedQuery, rollupStore };

  ipcMain.handle('query:filter-values', (_event, dimensionId: string, filterEntries: Record<string, readonly string[]>, dateRange?: { start: string; end: string }, opts?: { bypassCostScope?: boolean }, origin?: string): Promise<FilterValue[]> =>
    originStore.run(origin ?? null, () => queryFilterValues(deps, dimensionId, filterEntries, dateRange, opts)));
}
