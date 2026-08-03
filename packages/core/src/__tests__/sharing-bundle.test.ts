import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  ConfigValidationError,
  buildConfigBundle,
  bundleConfigWithProfile,
  costGoblinConfigToYaml,
  loadConfig,
  loadCostScope,
  loadDimensions,
  loadOrgTree,
  loadViews,
  parseConfigBundle,
  serializeConfigBundle,
  summarizeConfigBundle,
  validateConfig,
} from '../config/index.js';
import type { AwsProviderConfig, ConfigBundle, ProviderConfig, SharedCostGoblinConfig } from '../types/index.js';
import { CONFIG_BUNDLE_KIND, CONFIG_BUNDLE_SCHEMA_VERSION } from '../types/index.js';
import { asBucketPath } from '../types/branded.js';
import { parseProviderName } from '../config/provider-name.js';

const fixturesDir = join(import.meta.dirname, '..', '__fixtures__', 'config');

/** `credentialsProfile` lives only on the `aws` arm — narrow before asserting
 *  on it, rather than optional-chaining a property the union doesn't have. */
function awsArm(p: ProviderConfig | undefined): AwsProviderConfig {
  if (p?.type !== 'aws') throw new Error(`expected an 'aws' provider, got ${String(p?.type)}`);
  return p;
}

async function buildFixtureBundle(): Promise<ConfigBundle> {
  const [config, dimensions, orgTree, costScope, views] = await Promise.all([
    loadConfig(join(fixturesDir, 'costgoblin.yaml')),
    loadDimensions(join(fixturesDir, 'dimensions.yaml')),
    loadOrgTree(join(fixturesDir, 'org-tree.yaml')),
    loadCostScope(join(fixturesDir, 'cost-scope.yaml')),
    loadViews(join(fixturesDir, 'views.yaml')),
  ]);
  return buildConfigBundle({
    config,
    dimensions,
    orgTree,
    costScope,
    views,
    appVersion: '0.0.0-test',
    exportedAt: '2026-06-11T00:00:00.000Z',
  });
}

describe('buildConfigBundle', () => {
  it('strips credentials — the serialized bundle never mentions the AWS profile', async () => {
    const bundle = await buildFixtureBundle();
    const serialized = serializeConfigBundle(bundle);
    expect(serialized).not.toContain('test-profile');
    expect(serialized).not.toContain('credentials:');
    expect(bundle.sections.config.providers[0]).not.toHaveProperty('credentials');
  });

  it('keeps org-level provider settings (buckets, retention, defaults)', async () => {
    const bundle = await buildFixtureBundle();
    const provider = bundle.sections.config.providers[0];
    expect(provider?.name).toBe('aws-main');
    expect(String(provider?.sync.daily.bucket)).toBe('s3://test-cur-bucket/daily/');
    expect(provider?.sync.daily.retentionDays).toBe(365);
    expect(bundle.sections.config.defaults.periodDays).toBe(30);
  });

  it('omits empty optional sections', async () => {
    const config = await loadConfig(join(fixturesDir, 'costgoblin.yaml'));
    const dimensions = await loadDimensions(join(fixturesDir, 'dimensions.yaml'));
    const bundle = buildConfigBundle({ config, dimensions, orgTree: { tree: [] }, appVersion: '0.0.0-test' });
    expect(bundle.sections.orgTree).toBeUndefined();
    expect(bundle.sections.costScope).toBeUndefined();
    expect(bundle.sections.views).toBeUndefined();
  });
});

describe('serializeConfigBundle / parseConfigBundle', () => {
  it('round-trips every section losslessly', async () => {
    const bundle = await buildFixtureBundle();
    const parsed = parseConfigBundle(serializeConfigBundle(bundle));
    expect(parsed.fingerprintValid).toBe(true);
    expect(parsed.bundle.schemaVersion).toBe(CONFIG_BUNDLE_SCHEMA_VERSION);
    expect(parsed.bundle.appVersion).toBe('0.0.0-test');
    expect(parsed.bundle.sections.config).toEqual(bundle.sections.config);
    expect(parsed.bundle.sections.dimensions).toEqual(bundle.sections.dimensions);
    expect(parsed.bundle.sections.orgTree).toEqual(bundle.sections.orgTree);
    expect(parsed.bundle.sections.costScope).toEqual(bundle.sections.costScope);
    expect(parsed.bundle.sections.views).toEqual(bundle.sections.views);
  });

  it('flags a bundle edited after export via the fingerprint', async () => {
    const bundle = await buildFixtureBundle();
    const tampered = serializeConfigBundle(bundle).replace('s3://test-cur-bucket/daily/', 's3://evil-bucket/daily/');
    const parsed = parseConfigBundle(tampered);
    expect(parsed.fingerprintValid).toBe(false);
    expect(String(parsed.bundle.sections.config.providers[0]?.sync.daily.bucket)).toBe('s3://evil-bucket/daily/');
  });

  it('parses a bundle without optional sections', async () => {
    const config = await loadConfig(join(fixturesDir, 'costgoblin.yaml'));
    const dimensions = await loadDimensions(join(fixturesDir, 'dimensions.yaml'));
    const bundle = buildConfigBundle({ config, dimensions, appVersion: '0.0.0-test' });
    const parsed = parseConfigBundle(serializeConfigBundle(bundle));
    expect(parsed.fingerprintValid).toBe(true);
    expect(parsed.bundle.sections.orgTree).toBeUndefined();
    expect(parsed.bundle.sections.costScope).toBeUndefined();
    expect(parsed.bundle.sections.views).toBeUndefined();
  });

  it('rejects non-YAML content', () => {
    expect(() => parseConfigBundle('{not: yaml: at: all:')).toThrow(ConfigValidationError);
  });

  it('rejects YAML that is not a bundle', () => {
    expect(() => parseConfigBundle('providers: []\ndefaults: {}\n')).toThrow(/not a costgoblin configuration bundle/i);
  });

  it('rejects bundles from a newer schema version', async () => {
    const bundle = await buildFixtureBundle();
    const newer = serializeConfigBundle(bundle).replace(
      `schemaVersion: ${String(CONFIG_BUNDLE_SCHEMA_VERSION)}`,
      `schemaVersion: ${String(CONFIG_BUNDLE_SCHEMA_VERSION + 1)}`,
    );
    expect(() => parseConfigBundle(newer)).toThrow(/update costgoblin/i);
  });

  it('rejects a bundle with an invalid dimensions section', async () => {
    const bundle = await buildFixtureBundle();
    const broken = serializeConfigBundle(bundle).replace('tagName: team', 'wrongKey: team');
    expect(() => parseConfigBundle(broken)).toThrow(ConfigValidationError);
  });

  it('discards credentials smuggled into a hand-crafted bundle', async () => {
    const bundle = await buildFixtureBundle();
    const serialized = serializeConfigBundle(bundle);
    const doc: unknown = parse(serialized);
    if (typeof doc !== 'object' || doc === null) throw new Error('expected object');
    const record: Record<string, unknown> = Object.fromEntries(Object.entries(doc));
    const sections = record['sections'];
    if (typeof sections !== 'object' || sections === null) throw new Error('expected sections');
    const sectionsRecord: Record<string, unknown> = Object.fromEntries(Object.entries(sections));
    const configSection = sectionsRecord['config'];
    if (typeof configSection !== 'object' || configSection === null) throw new Error('expected config');
    const configRecord: Record<string, unknown> = Object.fromEntries(Object.entries(configSection));
    const providers = configRecord['providers'];
    if (!Array.isArray(providers)) throw new Error('expected providers');
    const provider = providers[0];
    if (typeof provider !== 'object' || provider === null) throw new Error('expected provider');
    const smuggled = {
      ...record,
      sections: {
        ...sectionsRecord,
        config: {
          ...configRecord,
          providers: [{ ...provider, credentials: { profile: 'leaked-profile' } }],
        },
      },
    };
    const { stringify } = await import('yaml');
    const parsed = parseConfigBundle(stringify(smuggled));
    expect(parsed.bundle.sections.config.providers[0]).not.toHaveProperty('credentials');
    expect(serializeConfigBundle(parsed.bundle)).not.toContain('leaked-profile');
  });
});

describe('summarizeConfigBundle', () => {
  it('counts every section for the import preview', async () => {
    const bundle = await buildFixtureBundle();
    const summary = summarizeConfigBundle({ bundle, fingerprintValid: true });
    expect(summary.sections).toEqual(['config', 'dimensions', 'orgTree', 'costScope', 'views']);
    expect(summary.providers).toEqual([{ name: 'aws-main', dailyBucket: 's3://test-cur-bucket/daily/' }]);
    expect(summary.builtInDimensionCount).toBe(13);
    expect(summary.tagDimensionCount).toBe(4);
    expect(summary.orgTreeNodeCount).toBe(12);
    expect(summary.exclusionRuleCount).toBeGreaterThan(0);
    expect(summary.viewCount).toBeGreaterThan(0);
    expect(summary.fingerprintValid).toBe(true);
    expect(summary.exportedAt).toBe('2026-06-11T00:00:00.000Z');
  });
});

describe('bundleConfigWithProfile', () => {
  it('injects the locally-chosen profile into every provider', async () => {
    const bundle = await buildFixtureBundle();
    const config = bundleConfigWithProfile(bundle.sections.config, 'my-local-profile');
    expect(config.providers).toHaveLength(1);
    expect(awsArm(config.providers[0]).credentialsProfile).toBe('my-local-profile');
    expect(String(config.providers[0]?.sync.daily.bucket)).toBe('s3://test-cur-bucket/daily/');
    // The on-disk YAML form passes the standard config validator.
    const revalidated = validateConfig(costGoblinConfigToYaml(config));
    expect(awsArm(revalidated.providers[0]).credentialsProfile).toBe('my-local-profile');
  });

  it('leaves a gcp provider on Application Default Credentials rather than stamping the profile', () => {
    const shared: SharedCostGoblinConfig = {
      providers: [
        { name: parseProviderName('payer-a'), type: 'aws', sync: { daily: { bucket: asBucketPath('s3://b/d'), retentionDays: 30 }, intervalMinutes: 60 } },
        { name: parseProviderName('gcp-main'), type: 'gcp', sync: { daily: { bucket: asBucketPath('gs://b/focus'), retentionDays: 365 }, intervalMinutes: 60 } },
      ],
      defaults: { periodDays: 30, costMetric: 'effective', lagDays: 1 },
    };
    const config = bundleConfigWithProfile(shared, 'my-local-profile');
    expect(awsArm(config.providers[0]).credentialsProfile).toBe('my-local-profile');
    const gcp = config.providers[1];
    if (gcp?.type !== 'gcp') throw new Error('expected the second provider to be the gcp arm');
    expect('keyFile' in gcp).toBe(false);
    // Round-trips through the on-disk YAML form without acquiring a
    // credentialsProfile key it has no field for.
    const yaml = costGoblinConfigToYaml(config);
    const revalidated = validateConfig(yaml);
    expect(revalidated.providers[1]?.type).toBe('gcp');
  });
});

describe('bundle kind constant', () => {
  it('appears verbatim in serialized output', async () => {
    const bundle = await buildFixtureBundle();
    expect(serializeConfigBundle(bundle)).toContain(`kind: ${CONFIG_BUNDLE_KIND}`);
  });
});
