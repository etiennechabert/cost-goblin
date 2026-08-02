import { createHash } from 'node:crypto';
import { parse, stringify } from 'yaml';
import type {
  CostGoblinConfig,
  DimensionsConfig,
  OrgNode,
  OrgTreeConfig,
  ProviderConfig,
  SyncConfig,
} from '../types/config.js';
import type { BaselineSpec } from '../types/baseline.js';
import type { CostScopeConfig } from '../types/cost-scope.js';
import type {
  BundleSectionId,
  ConfigBundle,
  ConfigBundleSections,
  ConfigBundleSummary,
  SharedCostGoblinConfig,
  SharedProviderConfig,
} from '../types/sharing.js';
import { CONFIG_BUNDLE_KIND, CONFIG_BUNDLE_SCHEMA_VERSION } from '../types/sharing.js';
import type { ViewsConfig } from '../types/views.js';
import { costScopeToYaml } from './cost-scope-serialize.js';
import { dimensionsConfigToYaml } from './dimensions-serialize.js';
import {
  ConfigValidationError,
  assertNumber,
  assertObject,
  assertString,
  validateConfig,
  validateDimensions,
  validateOrgTree,
} from './validator.js';
import { validateCostScope } from './cost-scope-validator.js';
import { validateViews } from './views-validator.js';
import { viewsConfigToYaml } from './views-serialize.js';
import { validateBaselines } from './baselines-validator.js';
import { baselinesToYaml } from './baselines-serialize.js';

// ---------------------------------------------------------------------------
// YAML-object serialization — stable key order so fingerprints are
// deterministic and round-tripped files don't produce noisy diffs.
// ---------------------------------------------------------------------------

function syncToYaml(sync: SyncConfig): Record<string, unknown> {
  return {
    daily: { bucket: String(sync.daily.bucket), retentionDays: sync.daily.retentionDays },
    ...(sync.hourly === undefined ? {} : { hourly: { bucket: String(sync.hourly.bucket), retentionDays: sync.hourly.retentionDays } }),
    ...(sync.costOptimization === undefined ? {} : { costOptimization: { bucket: String(sync.costOptimization.bucket), retentionDays: sync.costOptimization.retentionDays } }),
    intervalMinutes: sync.intervalMinutes,
  };
}

/** Shared (credential-less) YAML shape for one provider. Single `aws` arm
 *  today — when `SharedProviderConfig` grows arms (#517), the per-type
 *  fields stop type-checking here and force a per-type dispatch. */
function sharedProviderToYaml(p: SharedProviderConfig): Record<string, unknown> {
  return { name: String(p.name), type: p.type, sync: syncToYaml(p.sync) };
}

function sharedConfigToYaml(config: SharedCostGoblinConfig): Record<string, unknown> {
  return {
    providers: config.providers.map(sharedProviderToYaml),
    defaults: {
      periodDays: config.defaults.periodDays,
      costMetric: config.defaults.costMetric,
      lagDays: config.defaults.lagDays,
    },
  };
}

/** On-disk YAML shape for one provider, credentials included. Single `aws`
 *  arm today — `credentialsProfile` is arm-specific, so a new provider type
 *  breaks the build here until it gets its own serialization. */
function providerToYaml(p: ProviderConfig): Record<string, unknown> {
  return {
    name: String(p.name),
    type: p.type,
    credentialsProfile: p.credentialsProfile,
    sync: syncToYaml(p.sync),
  };
}

/** YAML-ready shape for costgoblin.yaml — the on-disk form, credentials
 *  included. Used when an imported bundle is materialized to disk. */
export function costGoblinConfigToYaml(config: CostGoblinConfig): Record<string, unknown> {
  return {
    providers: config.providers.map(providerToYaml),
    defaults: {
      periodDays: config.defaults.periodDays,
      costMetric: config.defaults.costMetric,
      lagDays: config.defaults.lagDays,
    },
  };
}

function orgNodeToYaml(node: OrgNode): Record<string, unknown> {
  return {
    name: node.name,
    ...(node.virtual === true ? { virtual: true } : {}),
    ...(node.children === undefined ? {} : { children: node.children.map(orgNodeToYaml) }),
  };
}

/** YAML-ready shape for org-tree.yaml. */
export function orgTreeToYaml(config: OrgTreeConfig): Record<string, unknown> {
  return { tree: config.tree.map(orgNodeToYaml) };
}

function sectionsToYamlObjects(sections: ConfigBundleSections): Record<string, unknown> {
  return {
    config: sharedConfigToYaml(sections.config),
    dimensions: dimensionsConfigToYaml(sections.dimensions),
    ...(sections.orgTree === undefined ? {} : { orgTree: orgTreeToYaml(sections.orgTree) }),
    ...(sections.costScope === undefined ? {} : { costScope: costScopeToYaml(sections.costScope) }),
    ...(sections.views === undefined ? {} : { views: viewsConfigToYaml(sections.views) }),
    ...(sections.baselines === undefined ? {} : { baselines: baselinesToYaml(sections.baselines) }),
  };
}

/** SHA-256 over the canonical JSON form of the sections. Both export and
 *  import compute it from validator-produced objects, so key order — and
 *  therefore the hash — is deterministic across machines. */
function computeFingerprint(sections: ConfigBundleSections): string {
  return createHash('sha256').update(JSON.stringify(sectionsToYamlObjects(sections))).digest('hex');
}

// ---------------------------------------------------------------------------
// Build + serialize (export side)
// ---------------------------------------------------------------------------

export interface BuildConfigBundleInput {
  readonly config: CostGoblinConfig;
  readonly dimensions: DimensionsConfig;
  readonly orgTree?: OrgTreeConfig | undefined;
  readonly costScope?: CostScopeConfig | undefined;
  readonly views?: ViewsConfig | undefined;
  readonly baselines?: readonly BaselineSpec[] | undefined;
  readonly appVersion: string;
  /** Injectable for tests. Defaults to now. */
  readonly exportedAt?: string | undefined;
}

/** The credential-less form of a provider for embedding in a bundle. Each
 *  provider arm decides which of its fields are shareable — credentials can
 *  never leak by construction. Single `aws` arm today; new arms (#517) stop
 *  type-checking here until they get their own mapping. */
function toSharedProvider(p: ProviderConfig): SharedProviderConfig {
  return { name: p.name, type: p.type, sync: p.sync };
}

/** Assemble a shareable bundle from the local configuration. The AWS
 *  profile name is dropped here — `SharedProviderConfig` has no
 *  credentials field, so a bundle cannot leak it by construction. */
export function buildConfigBundle(input: BuildConfigBundleInput): ConfigBundle {
  const sections: ConfigBundleSections = {
    config: {
      providers: input.config.providers.map(toSharedProvider),
      defaults: input.config.defaults,
    },
    dimensions: input.dimensions,
    ...(input.orgTree === undefined || input.orgTree.tree.length === 0 ? {} : { orgTree: input.orgTree }),
    ...(input.costScope === undefined ? {} : { costScope: input.costScope }),
    ...(input.views === undefined || input.views.views.length === 0 ? {} : { views: input.views }),
    ...(input.baselines === undefined || input.baselines.length === 0 ? {} : { baselines: input.baselines }),
  };
  return {
    schemaVersion: CONFIG_BUNDLE_SCHEMA_VERSION,
    appVersion: input.appVersion,
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    fingerprint: computeFingerprint(sections),
    sections,
  };
}

const BUNDLE_HEADER = `# CostGoblin configuration bundle
# Share this file with teammates: they import it from the setup wizard or
# the options menu. It contains NO credentials — receivers pick their own
# AWS profile on import.
`;

export function serializeConfigBundle(bundle: ConfigBundle): string {
  return BUNDLE_HEADER + stringify({
    kind: CONFIG_BUNDLE_KIND,
    schemaVersion: bundle.schemaVersion,
    appVersion: bundle.appVersion,
    exportedAt: bundle.exportedAt,
    fingerprint: bundle.fingerprint,
    sections: sectionsToYamlObjects(bundle.sections),
  });
}

// ---------------------------------------------------------------------------
// Parse + validate (import side)
// ---------------------------------------------------------------------------

/** The bundle's config section run through the standard provider
 *  validator. Any `credentials` key a hand-crafted bundle might carry is
 *  discarded — only known shareable fields survive. */
function validateSharedConfig(raw: unknown): SharedCostGoblinConfig {
  assertObject(raw, 'sections.config');
  const providersRaw = raw['providers'];
  if (!Array.isArray(providersRaw)) {
    throw new ConfigValidationError('sections.config.providers must be an array');
  }
  const withPlaceholderCredentials = providersRaw.map((p, i) => {
    assertObject(p, `sections.config.providers[${String(i)}]`);
    return {
      name: p['name'],
      type: p['type'],
      sync: p['sync'],
      credentialsProfile: 'placeholder',
    };
  });
  const validated = validateConfig({ providers: withPlaceholderCredentials, defaults: raw['defaults'] });
  return {
    providers: validated.providers.map(toSharedProvider),
    defaults: validated.defaults,
  };
}

export interface ParsedConfigBundle {
  readonly bundle: ConfigBundle;
  /** False when the sections no longer hash to the embedded fingerprint
   *  (file edited after export). Surfaced as a warning — the content
   *  itself still passed full validation. */
  readonly fingerprintValid: boolean;
}

/** Parse and fully validate a bundle file. Every section goes through the
 *  same validators as the on-disk config files — a bundle is untrusted
 *  input (it may arrive via chat, email, or a shared bucket). Throws
 *  `ConfigValidationError` with a user-presentable message. */
export function parseConfigBundle(content: string): ParsedConfigBundle {
  let raw: unknown;
  try {
    raw = parse(content);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ConfigValidationError(`Not valid YAML: ${message}`);
  }
  assertObject(raw, 'bundle');
  if (raw['kind'] !== CONFIG_BUNDLE_KIND) {
    throw new ConfigValidationError('Not a CostGoblin configuration bundle (missing or wrong "kind" field)');
  }
  assertNumber(raw['schemaVersion'], 'schemaVersion');
  if (raw['schemaVersion'] > CONFIG_BUNDLE_SCHEMA_VERSION) {
    throw new ConfigValidationError(
      `Bundle schema version ${String(raw['schemaVersion'])} is newer than this app supports (${String(CONFIG_BUNDLE_SCHEMA_VERSION)}). Update CostGoblin and retry.`,
    );
  }
  if (raw['schemaVersion'] < 1) {
    throw new ConfigValidationError('schemaVersion must be >= 1');
  }
  assertString(raw['appVersion'], 'appVersion');
  assertString(raw['exportedAt'], 'exportedAt');
  assertString(raw['fingerprint'], 'fingerprint');
  assertObject(raw['sections'], 'sections');
  const rawSections = raw['sections'];

  const config = validateSharedConfig(rawSections['config']);
  const dimensions: DimensionsConfig = validateDimensions(rawSections['dimensions']);
  const orgTree: OrgTreeConfig | undefined = rawSections['orgTree'] === undefined ? undefined : validateOrgTree(rawSections['orgTree']);
  const costScope: CostScopeConfig | undefined = rawSections['costScope'] === undefined ? undefined : validateCostScope(rawSections['costScope']);
  const views: ViewsConfig | undefined = rawSections['views'] === undefined ? undefined : validateViews(rawSections['views']);
  const baselines: readonly BaselineSpec[] | undefined = rawSections['baselines'] === undefined ? undefined : validateBaselines(rawSections['baselines'], dimensions);

  const sections: ConfigBundleSections = {
    config,
    dimensions,
    ...(orgTree === undefined ? {} : { orgTree }),
    ...(costScope === undefined ? {} : { costScope }),
    ...(views === undefined ? {} : { views }),
    ...(baselines === undefined ? {} : { baselines }),
  };
  return {
    bundle: {
      schemaVersion: raw['schemaVersion'],
      appVersion: raw['appVersion'],
      exportedAt: raw['exportedAt'],
      fingerprint: raw['fingerprint'],
      sections,
    },
    fingerprintValid: computeFingerprint(sections) === raw['fingerprint'],
  };
}

// ---------------------------------------------------------------------------
// Summary + import helpers
// ---------------------------------------------------------------------------

function countOrgNodes(nodes: readonly OrgNode[]): number {
  return nodes.reduce((sum, n) => sum + 1 + countOrgNodes(n.children ?? []), 0);
}

export function bundleSectionIds(sections: ConfigBundleSections): readonly BundleSectionId[] {
  const ids: BundleSectionId[] = ['config', 'dimensions'];
  if (sections.orgTree !== undefined) ids.push('orgTree');
  if (sections.costScope !== undefined) ids.push('costScope');
  if (sections.views !== undefined) ids.push('views');
  if (sections.baselines !== undefined) ids.push('baselines');
  return ids;
}

export function summarizeConfigBundle(parsed: ParsedConfigBundle): ConfigBundleSummary {
  const { bundle, fingerprintValid } = parsed;
  const { sections } = bundle;
  return {
    schemaVersion: bundle.schemaVersion,
    appVersion: bundle.appVersion,
    exportedAt: bundle.exportedAt,
    fingerprint: bundle.fingerprint,
    fingerprintValid,
    sections: bundleSectionIds(sections),
    providers: sections.config.providers.map(p => ({ name: p.name, dailyBucket: String(p.sync.daily.bucket) })),
    builtInDimensionCount: sections.dimensions.builtIn.length,
    tagDimensionCount: sections.dimensions.tags.length,
    orgTreeNodeCount: countOrgNodes(sections.orgTree?.tree ?? []),
    exclusionRuleCount: sections.costScope?.rules.length ?? 0,
    viewCount: sections.views?.views.length ?? 0,
    baselineCount: sections.baselines?.length ?? 0,
  };
}

/** Recombine a bundle's shared config with a locally-chosen AWS
 *  credentials profile. The same profile is applied to every provider —
 *  multi-provider bundles with distinct credentials per provider can
 *  adjust afterwards in the app. */
export function bundleConfigWithProfile(shared: SharedCostGoblinConfig, credentialsProfile: string): CostGoblinConfig {
  return {
    providers: shared.providers.map((p): ProviderConfig => ({ name: p.name, type: p.type, credentialsProfile, sync: p.sync })),
    defaults: shared.defaults,
  };
}
