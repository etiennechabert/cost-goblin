import { ipcMain } from 'electron';
import { asDimensionId, isStringRecord, logger, parseProviderName } from '@costgoblin/core';
import type {
  CostGoblinConfig,
  Dimension,
  OrgNode,
} from '@costgoblin/core';
import { removeProviderEntry, swapProviderCredentialsProfile } from '../config-upsert.js';
import type { AppContext } from './context.js';

export function registerConfigHandlers(app: AppContext): void {
  const { ctx, getConfig, getDimensions, getOrgTreeConfig, invalidateConfig, clearAllCaches } = app;

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
    const providerSuffix = providerName === undefined ? '' : ` for provider ${providerName}`;
    logger.info(`Updated AWS profile to ${profile}${providerSuffix}`);
  });

  // Removes the provider from the config AND deletes its {dataDir}/{name}/ tree.
  // Deleting the data is deliberate: leaving it orphaned let a later add of the
  // same name silently adopt this source's months and attribute them to a
  // different provider (even a different cloud). The confirmation modal warns
  // the user the download is discarded and must be re-synced if re-added.
  ipcMain.handle('config:remove-provider', async (_event, providerName: string): Promise<void> => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const { stringify, parse: parseYaml } = await import('yaml');
    const raw = await fs.readFile(ctx.configPath, 'utf-8');
    const parsed: unknown = parseYaml(raw);
    if (!isStringRecord(parsed)) throw new Error('Config file is not a YAML object');
    // Compute (don't yet persist) the config without this provider. Throws on an
    // unknown name (so we never delete data for a provider that isn't configured)
    // or on removing the last provider.
    const updated = removeProviderEntry(parsed, providerName);
    // Validate as a path segment before rm -rf — defence in depth on top of the
    // config-entry match above, so a crafted name can never escape the data dir.
    const safeName = parseProviderName(providerName);

    // Delete the on-disk tree BEFORE rewriting the config, and release any
    // DuckDB handles on its parquet first so the delete isn't blocked by an
    // in-flight query. Ordering it before the config write means a delete
    // failure (e.g. a locked file) aborts here with the provider still fully
    // configured — no half-state where the config forgot a provider whose data
    // survives for a same-name re-add to adopt. rm's force only swallows ENOENT,
    // so a real failure still throws and rejects the IPC.
    ctx.db.cancelPendingQueries();
    await fs.rm(path.join(ctx.dataDir, String(safeName)), { recursive: true, force: true });
    await fs.writeFile(ctx.configPath, stringify(updated), 'utf-8');
    // Removal can change which provider is FIRST — and the RollupStore's
    // paths and in-memory manifest are bound to the first provider's tree.
    // A full cache clear invalidates the store and re-warms it against the
    // new first provider instead of serving stale partitions.
    await clearAllCaches();
    logger.info(`Removed provider ${providerName} (config entry and on-disk data deleted)`);
  });
}
