import { ipcMain } from 'electron';
import { asDimensionId, isStringRecord, loadOrgTreeNormalized, logger } from '@costgoblin/core';
import type {
  CostGoblinConfig,
  Dimension,
  OrgTreeWithMigrations,
} from '@costgoblin/core';
import type { AppContext } from './context.js';

export function registerConfigHandlers(app: AppContext): void {
  const { ctx, getConfig, getDimensions, invalidateConfig } = app;

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
      }));
    const tags: Dimension[] = dimensions.tags
      .filter(d => d.enabled !== false)
      .map(d => ({
        tagName: d.tagName,
        label: d.label,
        ...(d.concept === undefined ? {} : { concept: d.concept }),
        ...(d.normalize === undefined ? {} : { normalize: d.normalize }),
        ...(d.separator === undefined ? {} : { separator: d.separator }),
        ...(d.aliases === undefined ? {} : { aliases: d.aliases }),
      }));
    return [...builtIn, ...tags];
  });

  ipcMain.handle('config:org-tree', async (): Promise<OrgTreeWithMigrations> => {
    // Re-validate the YAML on every editor open so migration flags (auto-promoted
    // nodes, wrapped roots, synthetic empty root) reflect the on-disk state and
    // the editor's banner stays in sync. The cached `getOrgTreeConfig` returns
    // only the normalized tree without migration info, so we go to the raw file
    // here instead.
    const { config, migrations } = await loadOrgTreeNormalized(ctx.orgTreePath);
    return { tree: [...config.tree], migrations };
  });

  // Surgical update: rewrite ONLY the first provider's credentials.profile,
  // leaving every other YAML field (buckets, retention, defaults, etc.)
  // untouched. The full setup wizard already covers re-doing buckets too —
  // this is the "I just want to swap to a profile with different IAM perms"
  // shortcut.
  ipcMain.handle('config:update-aws-profile', async (_event, profile: string): Promise<void> => {
    const fs = await import('node:fs/promises');
    const { stringify, parse: parseYaml } = await import('yaml');
    const raw = await fs.readFile(ctx.configPath, 'utf-8');
    const parsed: unknown = parseYaml(raw);
    if (!isStringRecord(parsed)) throw new Error('Config file is not a YAML object');
    const providersRaw: unknown = parsed['providers'];
    if (!Array.isArray(providersRaw) || providersRaw.length === 0) throw new Error('No providers configured');
    const providers: unknown[] = providersRaw;
    const first = providers[0];
    if (!isStringRecord(first)) throw new Error('First provider entry is not an object');
    const credentials = isStringRecord(first['credentials']) ? first['credentials'] : {};
    const updated = { ...parsed, providers: [{ ...first, credentials: { ...credentials, profile } }, ...providers.slice(1)] };
    await fs.writeFile(ctx.configPath, stringify(updated), 'utf-8');
    invalidateConfig();
    logger.info(`Updated AWS profile to ${profile}`);
  });
}
