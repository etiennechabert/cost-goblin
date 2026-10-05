import { ipcMain } from 'electron';
import { originStore } from '../query-log.js';
import { dimensionIdSet } from '@costgoblin/core';
import type {
  AggregatedTableResult,
  ExplorerFilterValue,
  ExplorerOverviewResult,
  ExplorerPreferences,
  ExplorerPreferencesUpdate,
  ExplorerRowsResult,
} from '@costgoblin/core';
import { type AppContext, prefsPath } from './context.js';
import { readExplorerPreferences, writeExplorerPreferences } from './explorer-prefs.js';
import {
  parseAggregatedTableParams,
  parseExplorerFilterValuesParams,
  parseExplorerOverviewParams,
  parseExplorerRowsParams,
} from './explorer-params.js';
import {
  queryAggregatedTable,
  queryExplorerFilterValues,
  queryExplorerOverview,
  queryExplorerRows,
  type ExplorerDeps,
} from './explorer-queries.js';

/** Parse a renderer payload, then run the handler under its debug origin.
 *  Async so a malformed payload rejects the invoke like any other failure. */
async function runParsed<P extends { readonly origin?: string | undefined }, R>(
  parse: (payload: unknown) => P,
  payload: unknown,
  run: (params: P) => Promise<R>,
): Promise<R> {
  const params = parse(payload);
  return originStore.run(params.origin ?? null, () => run(params));
}

export function registerExplorerHandlers(app: AppContext): void {
  const { ctx, getCostScope, getOrgAccountsPath, getQueryDimensions, getAccountMap, getQueryProviders, getAccountReverseMap, runPreparedQuery, rollupStore } = app;
  const deps: ExplorerDeps = {
    dataDir: ctx.dataDir, now: ctx.now,
    getCostScope, getOrgAccountsPath, getQueryDimensions, getAccountMap, getQueryProviders, getAccountReverseMap, runPreparedQuery, rollupStore,
  };

  const explorerPrefsPath = () => prefsPath(ctx.stateDir, 'explorer-preferences');

  ipcMain.handle('explorer:get-preferences', async (): Promise<ExplorerPreferences> =>
    readExplorerPreferences(
      await explorerPrefsPath(),
      () => getQueryDimensions().then(dimensionIdSet, () => undefined),
    ));

  ipcMain.handle('explorer:save-preferences', async (_event, prefs: ExplorerPreferencesUpdate): Promise<void> => {
    await writeExplorerPreferences(await explorerPrefsPath(), prefs);
  });

  // Histogram + totals. Depends on filters/range/granularity/scope/metric/
  // perspective — NOT on sort. Kept separate from the rows query so that
  // clicking a column header doesn't wipe the histogram.
  ipcMain.handle('explorer:query-overview', (_event, payload: unknown): Promise<ExplorerOverviewResult> => runParsed(parseExplorerOverviewParams, payload, (params) => queryExplorerOverview(deps, params)));

  // Sample rows. Depends on everything the overview does PLUS sort + rowLimit.
  ipcMain.handle('explorer:query-rows', (_event, payload: unknown): Promise<ExplorerRowsResult> => runParsed(parseExplorerRowsParams, payload, (params) => queryExplorerRows(deps, params)));

  ipcMain.handle('explorer:query-aggregated-table', (_event, payload: unknown): Promise<AggregatedTableResult> => runParsed(parseAggregatedTableParams, payload, (params) => queryAggregatedTable(deps, params)));

  ipcMain.handle('explorer:filter-values', (_event, payload: unknown): Promise<ExplorerFilterValue[]> => runParsed(parseExplorerFilterValuesParams, payload, (params) => queryExplorerFilterValues(deps, params)));
}
