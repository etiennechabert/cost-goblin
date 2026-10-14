import { ipcMain, shell } from 'electron';
import { writeFile } from 'node:fs/promises';
import { stringify } from 'yaml';
import {
  DEFAULT_COST_SCOPE,
  ConfigValidationError,
  costScopeToYaml,
  dimensionIdSet,
  validateCostScope,
} from '@costgoblin/core';
import type {
  CostScopeConfig,
  CostScopePreviewResult,
  DimensionsConfig,
} from '@costgoblin/core';
import type { AppContext } from './context.js';
import { previewCostScope } from './cost-scope-preview.js';

// Every rule's dimensionId must resolve to a known built-in or tag dimension.
// Dangling references silently become a bogus column reference in SQL, which
// errors *every* query (exclusion clauses are threaded into all of them), so
// catch it at save time rather than letting the whole app fail at query time.
function assertRuleDimensionsExist(config: CostScopeConfig, dimensions: DimensionsConfig): void {
  const knownIds = dimensionIdSet(dimensions);
  for (const rule of config.rules) {
    for (const cond of rule.conditions) {
      const id = String(cond.dimensionId);
      if (!knownIds.has(id)) {
        throw new ConfigValidationError(
          `Rule '${rule.name}' references unknown dimension '${id}'. Available: ${[...knownIds].join(', ')}`,
        );
      }
    }
  }
}

function isEnoent(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  if (!('code' in err)) return false;
  return err.code === 'ENOENT';
}

export function registerCostScopeHandlers(app: AppContext): void {
  const { ctx, getCostScope, invalidateCostScope, getQueryDimensions, getOrgAccountsPath, getQueryProviders, getAccountReverseMap, runQuery } = app;

  ipcMain.handle('cost-scope:get-config', async (): Promise<CostScopeConfig> => {
    try {
      return await getCostScope();
    } catch (err) {
      // Seed the file only when it's missing. Validation / YAML errors bubble
      // up to the UI so the user can fix their hand-edit — silently
      // overwriting would destroy their custom rules.
      if (!isEnoent(err)) throw err;
      await writeFile(ctx.costScopePath, stringify(costScopeToYaml(DEFAULT_COST_SCOPE)));
      invalidateCostScope();
      return DEFAULT_COST_SCOPE;
    }
  });

  ipcMain.handle('cost-scope:save-config', async (_event, raw: unknown): Promise<void> => {
    const dimensions = await getQueryDimensions();
    const validated = validateCostScope(raw, dimensionIdSet(dimensions));
    assertRuleDimensionsExist(validated, dimensions);
    await writeFile(ctx.costScopePath, stringify(costScopeToYaml(validated)));
    invalidateCostScope();
  });

  ipcMain.handle('cost-scope:preview', (_event, payload: unknown): Promise<CostScopePreviewResult> => previewCostScope({
    dataDir: ctx.dataDir, now: ctx.now,
    getQueryDimensions, getQueryProviders, getOrgAccountsPath, getAccountReverseMap, runQuery,
  }, payload));

  ipcMain.handle('cost-scope:reveal-folder', (): void => {
    shell.showItemInFolder(ctx.costScopePath);
  });
}
