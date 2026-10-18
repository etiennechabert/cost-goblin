import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { DEFAULT_COST_SCOPE } from '../config/cost-scope-seed.js';
import { parseProviderName } from '../config/provider-name.js';
import {
  buildConfigBundle,
  bundleConfigWithProfile,
  bundleSectionIds,
  costGoblinConfigToYaml,
  parseConfigBundle,
  summarizeConfigBundle,
} from '../config/sharing-bundle.js';
import { ConfigValidationError, validateConfig } from '../config/validator.js';
import { asBucketPath, asDimensionId, asTagValue } from '../types/branded.js';
import type { BaselineSpec } from '../types/baseline.js';
import type { CostGoblinConfig, DimensionsConfig, ProviderConfig } from '../types/config.js';
import type { SharedCostGoblinConfig } from '../types/sharing.js';
import { CONFIG_BUNDLE_KIND, CONFIG_BUNDLE_SCHEMA_VERSION } from '../types/sharing.js';

/** The message of the ConfigValidationError `fn` throws; anything else fails the test. */
function configError(fn: () => unknown): string {
  try {
    fn();
  } catch (err: unknown) {
    if (err instanceof ConfigValidationError) return err.message;
    throw err;
  }
  throw new Error('expected a ConfigValidationError, but nothing was thrown');
}

const defaults = { periodDays: 30, costMetric: 'effective', lagDays: 2 };

const awsSync = { daily: { bucket: asBucketPath('s3://billing/daily'), retentionDays: 365 }, intervalMinutes: 60 };
const gcpSync = { daily: { bucket: asBucketPath('gs://billing-bkt/focus/daily'), retentionDays: 400 }, intervalMinutes: 120 };

const awsProvider: ProviderConfig = { name: parseProviderName('payer-a'), type: 'aws', credentialsProfile: 'finance', sync: awsSync };
const gcpWithKeyFile: ProviderConfig = { name: parseProviderName('gcp-main'), type: 'gcp', keyFile: '/Users/me/keys/reader.json', sync: gcpSync };
const gcpOnAdc: ProviderConfig = { name: parseProviderName('gcp-adc'), type: 'gcp', sync: gcpSync };

const dimensions: DimensionsConfig = {
  builtIn: [{ name: asDimensionId('service'), label: 'Service', field: 'service' }],
  tags: [{ tagName: 'team', label: 'Team' }],
};

describe('costGoblinConfigToYaml: gcp credentials', () => {
  const config: CostGoblinConfig = { providers: [gcpWithKeyFile, gcpOnAdc], defaults };

  it('writes a gcp key file, and no credential key for a gcp provider on default credentials', () => {
    expect(costGoblinConfigToYaml(config)).toStrictEqual({
      providers: [
        { name: 'gcp-main', type: 'gcp', keyFile: '/Users/me/keys/reader.json', sync: { daily: { bucket: 'gs://billing-bkt/focus/daily', retentionDays: 400 }, intervalMinutes: 120 } },
        { name: 'gcp-adc', type: 'gcp', sync: { daily: { bucket: 'gs://billing-bkt/focus/daily', retentionDays: 400 }, intervalMinutes: 120 } },
      ],
      defaults: { periodDays: 30, costMetric: 'effective', lagDays: 2 },
    });
  });

  it('round-trips through validateConfig with the key file intact', () => {
    expect(validateConfig(costGoblinConfigToYaml(config))).toStrictEqual(config);
  });
});

describe('bundleConfigWithProfile: gcp key files', () => {
  it('carries a local gcp provider\'s key file across a bundle import by name', () => {
    const shared: SharedCostGoblinConfig = {
      providers: [
        { name: parseProviderName('payer-a'), type: 'aws', sync: awsSync },
        { name: parseProviderName('gcp-main'), type: 'gcp', sync: gcpSync },
      ],
      defaults,
    };
    const existing: readonly ProviderConfig[] = [
      { ...gcpWithKeyFile, sync: { ...gcpSync, intervalMinutes: 5 } },
      { ...awsProvider, credentialsProfile: 'stale-profile' },
    ];
    expect(bundleConfigWithProfile(shared, 'picked-profile', existing)).toStrictEqual({
      providers: [
        { name: 'payer-a', type: 'aws', credentialsProfile: 'picked-profile', sync: awsSync },
        // The key file comes from the local provider; the sync settings from the bundle.
        { name: 'gcp-main', type: 'gcp', keyFile: '/Users/me/keys/reader.json', sync: gcpSync },
      ],
      defaults,
    });
  });
});

/** Plain-data bundle sections that pass validation. */
const rawSections = {
  config: {
    providers: [{ name: 'payer-a', type: 'aws', sync: { daily: { bucket: 's3://billing/daily', retentionDays: 365 }, intervalMinutes: 60 } }],
    defaults,
  },
  dimensions: { builtIn: [{ name: 'service', label: 'Service', field: 'service' }], tags: [{ tagName: 'team', label: 'Team' }] },
};

function bundleYaml(fields: Readonly<Record<string, unknown>>): string {
  return stringify({
    kind: CONFIG_BUNDLE_KIND,
    schemaVersion: CONFIG_BUNDLE_SCHEMA_VERSION,
    appVersion: '1.2.3',
    exportedAt: '2026-10-01T00:00:00.000Z',
    fingerprint: 'not-the-real-hash',
    sections: rawSections,
    ...fields,
  });
}

function withConfig(config: unknown): string {
  return bundleYaml({ sections: { ...rawSections, config } });
}

describe('parseConfigBundle: envelope errors', () => {
  it('parses the minimal hand-written bundle the error cases start from', () => {
    const parsed = parseConfigBundle(bundleYaml({}));
    expect(parsed.fingerprintValid).toBe(false);
    expect(bundleSectionIds(parsed.bundle.sections)).toEqual(['config', 'dimensions']);
    expect(parsed.bundle.sections.config.providers).toStrictEqual([{ name: 'payer-a', type: 'aws', sync: awsSync }]);
  });

  it.each([
    ['schema version 0', { schemaVersion: 0 }, 'schemaVersion must be >= 1'],
    ['a negative schema version', { schemaVersion: -1 }, 'schemaVersion must be >= 1'],
    ['a string schema version', { schemaVersion: '1' }, 'schemaVersion must be a number'],
    [
      'a newer schema version',
      { schemaVersion: CONFIG_BUNDLE_SCHEMA_VERSION + 1 },
      `Bundle schema version ${String(CONFIG_BUNDLE_SCHEMA_VERSION + 1)} is newer than this app supports (${String(CONFIG_BUNDLE_SCHEMA_VERSION)}). Update CostGoblin and retry.`,
    ],
    ['the wrong kind', { kind: 'costgoblin-views' }, 'Not a CostGoblin configuration bundle (missing or wrong "kind" field)'],
    ['no app version', { appVersion: undefined }, 'appVersion must be a string'],
    ['no export timestamp', { exportedAt: 1 }, 'exportedAt must be a string'],
    ['no fingerprint', { fingerprint: null }, 'fingerprint must be a string'],
    ['no sections', { sections: undefined }, 'sections must be an object'],
  ])('rejects a bundle with %s', (_label, fields, message) => {
    expect(configError(() => parseConfigBundle(bundleYaml(fields)))).toBe(message);
  });

  it('rejects YAML whose top level is not a mapping', () => {
    expect(configError(() => parseConfigBundle('- a\n- b\n'))).toBe('bundle must be an object');
  });

  it('prefixes a YAML syntax error with "Not valid YAML"', () => {
    expect(configError(() => parseConfigBundle('{not: yaml: at: all:'))).toMatch(/^Not valid YAML: \S/);
  });
});

describe('parseConfigBundle: config section errors', () => {
  it.each([
    ['providers that are not a list', { providers: 'payer-a', defaults }, 'sections.config.providers must be an array'],
    ['no providers key', { defaults }, 'sections.config.providers must be an array'],
    ['a provider that is not a mapping', { providers: ['payer-a'], defaults }, 'sections.config.providers[0] must be an object'],
    ['a config that is not a mapping', ['payer-a'], 'sections.config must be an object'],
  ])('rejects %s', (_label, config, message) => {
    expect(configError(() => parseConfigBundle(withConfig(config)))).toBe(message);
  });
});

describe('bundleSectionIds / summarizeConfigBundle', () => {
  const config: CostGoblinConfig = { providers: [awsProvider], defaults };

  it('lists only the mandatory sections, and zero counts, for a bundle without optional sections', () => {
    const bundle = buildConfigBundle({ config, dimensions, appVersion: '1.2.3', exportedAt: '2026-10-01T00:00:00.000Z' });
    expect(bundleSectionIds(bundle.sections)).toEqual(['config', 'dimensions']);
    expect(summarizeConfigBundle({ bundle, fingerprintValid: false })).toStrictEqual({
      schemaVersion: CONFIG_BUNDLE_SCHEMA_VERSION,
      appVersion: '1.2.3',
      exportedAt: '2026-10-01T00:00:00.000Z',
      fingerprint: bundle.fingerprint,
      fingerprintValid: false,
      sections: ['config', 'dimensions'],
      providers: [{ name: 'payer-a', dailyBucket: 's3://billing/daily' }],
      builtInDimensionCount: 1,
      tagDimensionCount: 1,
      orgTreeNodeCount: 0,
      exclusionRuleCount: 0,
      viewCount: 0,
      baselineCount: 0,
    });
  });

  it('lists every section, and counts nested org-tree nodes, for a full bundle', () => {
    const baseline: BaselineSpec = {
      id: 'bl-1',
      source: 'manual',
      scope: { kind: 'filter', filters: { [asDimensionId('service')]: [asTagValue('Amazon EC2')] } },
      basis: { costMetric: 'effective', rules: DEFAULT_COST_SCOPE.rules },
      basisSnapshotAt: '2026-06-01T00:00:00.000Z',
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
    };
    const bundle = buildConfigBundle({
      config,
      dimensions,
      orgTree: {
        tree: [
          { name: 'Engineering', children: [{ name: 'Platform' }, { name: 'Data', virtual: true, children: [{ name: 'Analytics' }] }] },
          { name: 'Finance' },
        ],
      },
      costScope: DEFAULT_COST_SCOPE,
      views: { views: [{ id: 'a', name: 'A', rows: [] }, { id: 'b', name: 'B', rows: [] }] },
      baselines: [baseline],
      appVersion: '1.2.3',
    });
    expect(bundleSectionIds(bundle.sections)).toEqual(['config', 'dimensions', 'orgTree', 'costScope', 'views', 'baselines']);
    expect(summarizeConfigBundle({ bundle, fingerprintValid: true })).toMatchObject({
      sections: ['config', 'dimensions', 'orgTree', 'costScope', 'views', 'baselines'],
      orgTreeNodeCount: 5,
      exclusionRuleCount: DEFAULT_COST_SCOPE.rules.length,
      viewCount: 2,
      baselineCount: 1,
    });
  });
});
