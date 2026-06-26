import { app as electronApp } from 'electron';
import {
  buildConfigBundle,
  bundleConfigWithProfile,
  bundleSectionIds,
  costGoblinConfigToYaml,
  costScopeToYaml,
  dimensionsConfigToYaml,
  orgTreeToYaml,
  parseConfigBundle,
  viewsConfigToYaml,
} from '@costgoblin/core';
import type { BundleSectionId, ConfigBundle, ConfigBundleSections } from '@costgoblin/core';
import type { AppContext, IpcContext } from './context.js';

/** Assemble a bundle from whatever org config exists locally. Config and
 *  dimensions are mandatory; the optional files are skipped when missing or
 *  unreadable instead of failing the whole export. */
export async function buildCurrentBundle(app: AppContext): Promise<ConfigBundle> {
  const config = await app.getConfig();
  const dimensions = await app.getDimensions();
  const orgTree = await app.getOrgTreeConfig().catch(() => undefined);
  const costScope = await app.getCostScope().catch(() => undefined);
  const views = await app.getViews().catch(() => undefined);
  return buildConfigBundle({ config, dimensions, orgTree, costScope, views, appVersion: electronApp.getVersion() });
}

/** Copy whichever org config files exist into config/backups/<timestamp>/ so
 *  an import is always one folder-copy away from being undone. */
export async function backupExistingConfig(ctx: IpcContext): Promise<string | null> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const configDir = path.dirname(ctx.configPath);
  const candidates = [ctx.configPath, ctx.dimensionsPath, ctx.orgTreePath, ctx.costScopePath, ctx.viewsPath];
  const existing: string[] = [];
  for (const file of candidates) {
    try {
      await fs.access(file);
      existing.push(file);
    } catch {
      // not present — nothing to back up
    }
  }
  if (existing.length === 0) return null;
  const stamp = new Date().toISOString().replaceAll(':', '-');
  const backupDir = path.join(configDir, 'backups', stamp);
  await fs.mkdir(backupDir, { recursive: true });
  for (const file of existing) {
    await fs.copyFile(file, path.join(backupDir, path.basename(file)));
  }
  return backupDir;
}

export interface AppliedBundle {
  readonly sections: ConfigBundleSections;
  readonly sectionIds: readonly BundleSectionId[];
  readonly backupDir: string | null;
}

/** Re-parse + re-validate a bundle (never trust an earlier preview) and write
 *  its sections to the config directory, backing up existing files first. The
 *  chosen AWS profile is injected into every provider. Does NOT clear caches —
 *  the caller decides when. */
export async function applyBundleSectionsToDisk(ctx: IpcContext, content: string, profile: string): Promise<AppliedBundle> {
  const parsed = parseConfigBundle(content);
  const { sections } = parsed.bundle;

  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const { stringify } = await import('yaml');
  await fs.mkdir(path.dirname(ctx.configPath), { recursive: true });
  const backupDir = await backupExistingConfig(ctx);

  const config = bundleConfigWithProfile(sections.config, profile);
  await fs.writeFile(ctx.configPath, stringify(costGoblinConfigToYaml(config)), 'utf-8');
  await fs.writeFile(ctx.dimensionsPath, stringify(dimensionsConfigToYaml(sections.dimensions)), 'utf-8');
  if (sections.orgTree !== undefined) {
    await fs.writeFile(ctx.orgTreePath, stringify(orgTreeToYaml(sections.orgTree)), 'utf-8');
  }
  if (sections.costScope !== undefined) {
    await fs.writeFile(ctx.costScopePath, stringify(costScopeToYaml(sections.costScope)), 'utf-8');
  }
  if (sections.views !== undefined) {
    await fs.writeFile(ctx.viewsPath, stringify(viewsConfigToYaml(sections.views)), 'utf-8');
  }

  return { sections, sectionIds: bundleSectionIds(sections), backupDir };
}
