import { ipcMain } from 'electron';
import { asDimensionId, isStringRecord, logger } from '@costgoblin/core';
import type {
  CostGoblinConfig,
  Dimension,
  OrgNode,
} from '@costgoblin/core';
import { swapProviderCredentialsProfile } from '../config-upsert.js';
import type { AppContext } from './context.js';

export function registerConfigHandlers(app: AppContext): void {
  const { ctx, getConfig, getDimensions, getOrgTreeConfig, invalidateConfig } = app;

  ipcMain.handle('config:get', async (): Promise<CostGoblinConfig> => {
    return getConfig();
  });

  ipcMain.handle('config:dimensions', async (): Promise<Dimension[]> => {
    const dimensions = await getDimensions();
    // Disabled dims are hidden from the group-by selectors and filter bar.
    // They remain in the raw DimensionsConfig (loaded by the Dimensions view)
    // so the user can still see and re-enable them.
    const builtIn: Dimension[] = dimensions.builtIn
      .filter(d => d.enabled !== false)
      .map(d => ({
        name: asDimensionId(d.name),
        label: d.label,
        field: d.field,
        ...(d.displayField === undefined ? {} : { displayField: d.displayField }),
        ...(d.defaultFilterValues === undefined || d.defaultFilterValues.length === 0 ? {} : { defaultFilterValues: d.defaultFilterValues }),
      }));
    const tags: Dimension[] = dimensions.tags
      .filter(d => d.enabled !== false)
      .map(d => ({
        // tagName is optional now (account-only dims like OU Path / Unit have
        // none). Omit the key when absent so the renderer's `tagDimColumn`
        // falls back to accountTagFallback to compute the column name.
        ...(d.tagName === undefined || d.tagName.length === 0 ? {} : { tagName: d.tagName }),
        label: d.label,
        ...(d.concept === undefined ? {} : { concept: d.concept }),
        ...(d.normalize === undefined ? {} : { normalize: d.normalize }),
        ...(d.separator === undefined ? {} : { separator: d.separator }),
        ...(d.aliases === undefined ? {} : { aliases: d.aliases }),
        ...(d.accountTagFallback === undefined ? {} : { accountTagFallback: d.accountTagFallback }),
        ...(d.pathSegment === undefined ? {} : { pathSegment: d.pathSegment }),
        ...(d.defaultFilterValues === undefined || d.defaultFilterValues.length === 0 ? {} : { defaultFilterValues: d.defaultFilterValues }),
      }));
    return [...builtIn, ...tags];
  });

  ipcMain.handle('config:org-tree', async (): Promise<OrgNode[]> => {
    const orgTree = await getOrgTreeConfig();
    return [...orgTree.tree];
  });

  // Surgical update: rewrite ONLY the targeted provider's credentialsProfile
  // (exact-name lookup; defaults to the first provider when no name is
  // given), leaving every other YAML field (buckets, retention, defaults,
  // other providers, etc.) untouched. The full setup wizard already covers
  // re-doing buckets too — this is the "I just want to swap to a profile
  // with different IAM perms" shortcut. Drops the legacy nested
  // `credentials` key on the targeted entry only, so the file converges on
  // the current shape.
  ipcMain.handle('config:update-aws-profile', async (_event, profile: string, providerName?: string): Promise<void> => {
    const fs = await import('node:fs/promises');
    const { stringify, parse: parseYaml } = await import('yaml');
    const raw = await fs.readFile(ctx.configPath, 'utf-8');
    const parsed: unknown = parseYaml(raw);
    if (!isStringRecord(parsed)) throw new Error('Config file is not a YAML object');
    const updated = swapProviderCredentialsProfile(parsed, profile, providerName);
    await fs.writeFile(ctx.configPath, stringify(updated), 'utf-8');
    invalidateConfig();
    logger.info(`Updated AWS profile to ${profile}${providerName === undefined ? '' : ` for provider ${providerName}`}`);
  });
}
