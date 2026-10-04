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
  pathExists,
  readTextIfExists,
  validateConfig,
  viewsConfigToYaml,
  writeFileAtomic,
} from '@costgoblin/core';
import type { BundleSectionId, ConfigBundle, ConfigBundleSections, ProviderConfig } from '@costgoblin/core';
import type { AppContext } from './context.js';

/** The five YAML config file paths of one workspace. `IpcContext` satisfies
 *  this structurally for the active workspace; workspace creation builds one
 *  for the target workspace's config dir. */
export interface ConfigFilePaths {
  readonly configPath: string;
  readonly dimensionsPath: string;
  readonly orgTreePath: string;
  readonly viewsPath: string;
  readonly costScopePath: string;
}

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
export async function backupExistingConfig(ctx: ConfigFilePaths): Promise<string | null> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const configDir = path.dirname(ctx.configPath);
  const candidates = [ctx.configPath, ctx.dimensionsPath, ctx.orgTreePath, ctx.costScopePath, ctx.viewsPath];
  const existing: string[] = [];
  for (const file of candidates) {
    // Only a missing file has nothing to back up: one that merely can't be
    // checked throws (pathExists), failing the import before it overwrites
    // a file with no copy made.
    if (await pathExists(file)) existing.push(file);
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
/** The providers currently on disk, or none when there is no config yet (a
 *  first-run import). A config too broken to parse or validate reads as none
 *  too: it must not block the import that is probably meant to replace it
 *  (and it has just been backed up). One that can't be READ throws — transient
 *  errors are retried first — rather than drop the credentials of providers
 *  that are intact on disk. */
async function readExistingProviders(ctx: ConfigFilePaths): Promise<readonly ProviderConfig[]> {
  const text = await readTextIfExists(ctx.configPath);
  if (text === null) return [];
  const { parse } = await import('yaml');
  try {
    return validateConfig(parse(text)).providers;
  } catch {
    return [];
  }
}

export async function applyBundleSectionsToDisk(ctx: ConfigFilePaths, content: string, profile: string): Promise<AppliedBundle> {
  const parsed = parseConfigBundle(content);
  const { sections } = parsed.bundle;

  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const { stringify } = await import('yaml');
  await fs.mkdir(path.dirname(ctx.configPath), { recursive: true });
  const backupDir = await backupExistingConfig(ctx);

  // Read the current providers first: applying a bundle rewrites
  // costgoblin.yaml, and a bundle carries no credentials, so a GCP provider's
  // keyFile / impersonateServiceAccount have to be carried across by name.
  const existingProviders = await readExistingProviders(ctx);
  const config = bundleConfigWithProfile(sections.config, profile, existingProviders);
  await writeFileAtomic(ctx.configPath, stringify(costGoblinConfigToYaml(config)));
  await writeFileAtomic(ctx.dimensionsPath, stringify(dimensionsConfigToYaml(sections.dimensions)));
  if (sections.orgTree !== undefined) {
    await writeFileAtomic(ctx.orgTreePath, stringify(orgTreeToYaml(sections.orgTree)));
  }
  if (sections.costScope !== undefined) {
    await writeFileAtomic(ctx.costScopePath, stringify(costScopeToYaml(sections.costScope)));
  }
  if (sections.views !== undefined) {
    await writeFileAtomic(ctx.viewsPath, stringify(viewsConfigToYaml(sections.views)));
  }

  return { sections, sectionIds: bundleSectionIds(sections), backupDir };
}
