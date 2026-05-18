import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { loadConfig, loadDimensions, loadOrgTree, ConfigValidationError } from '../config/index.js';
import { validateConfig, validateDimensions, validateOrgTree } from '../config/validator.js';

const fixturesDir = join(import.meta.dirname, '..', '__fixtures__', 'config');

describe('loadConfig', () => {
  it('loads and validates costgoblin.yaml', async () => {
    const config = await loadConfig(join(fixturesDir, 'costgoblin.yaml'));
    expect(config.providers).toHaveLength(1);
    expect(config.providers[0]?.type).toBe('aws');
    expect(config.providers[0]?.credentials.profile).toBe('test-profile');
    expect(config.providers[0]?.sync.daily.retentionDays).toBe(365);
    expect(config.providers[0]?.sync.hourly?.retentionDays).toBe(30);
    expect(config.defaults.periodDays).toBe(30);
  });
});

describe('loadDimensions', () => {
  it('loads built-in and tag dimensions', async () => {
    const dims = await loadDimensions(join(fixturesDir, 'dimensions.yaml'));
    expect(dims.builtIn).toHaveLength(4);
    expect(dims.builtIn[0]?.name).toBe('account');
    expect(dims.builtIn[0]?.displayField).toBe('account_name');
    expect(dims.tags).toHaveLength(4);
    expect(dims.tags[0]?.concept).toBe('owner');
    expect(dims.tags[0]?.normalize).toBe('lowercase-kebab');
    expect(dims.tags[0]?.aliases?.['core-banking']).toContain('corebanking');
  });
});

describe('loadOrgTree', () => {
  it('loads org tree with virtual and real nodes', async () => {
    const tree = await loadOrgTree(join(fixturesDir, 'org-tree.yaml'));
    expect(tree.tree).toHaveLength(1);
    const company = tree.tree[0];
    expect(company?.name).toBe('Company');
    expect(company?.virtual).toBe(true);
    expect(company?.children).toHaveLength(3);

    const engineering = company?.children?.[0];
    expect(engineering?.name).toBe('Engineering');
    expect(engineering?.virtual).toBe(true);
    expect(engineering?.children).toHaveLength(4);

    const sre = company?.children?.[2];
    expect(sre?.name).toBe('SRE');
    expect(sre?.virtual).toBe(true);
    expect(sre?.children).toHaveLength(2);
  });
});

describe('validateConfig', () => {
  it('throws on invalid input', () => {
    expect(() => validateConfig(null)).toThrow(ConfigValidationError);
    expect(() => validateConfig({})).toThrow(ConfigValidationError);
    expect(() => validateConfig({ providers: 'not-array' })).toThrow(ConfigValidationError);
  });

  it('throws on missing provider fields', () => {
    expect(() => validateConfig({
      providers: [{ name: 'test' }],
      defaults: { periodDays: 30, costMetric: 'x', lagDays: 1 },
    })).toThrow(ConfigValidationError);
  });
});

describe('validateDimensions', () => {
  it('rejects invalid normalization rule', () => {
    expect(() => validateDimensions({
      builtIn: [],
      tags: [{ tagName: 'x', label: 'X', normalize: 'invalid' }],
    })).toThrow(ConfigValidationError);
  });
});

describe('validateOrgTree', () => {
  it('validates nested structure', () => {
    const { config, migrations } = validateOrgTree({
      tree: [{ name: 'Root', virtual: true, children: [{ name: 'leaf' }] }],
    });
    expect(config.tree[0]?.children?.[0]?.name).toBe('leaf');
    expect(migrations.promotedToVirtual).toEqual([]);
    expect(migrations.wrappedRoots).toBe(false);
    expect(migrations.addedEmptyRoot).toBe(false);
  });

  it('synthesizes a root when the tree is empty', () => {
    const { config, migrations } = validateOrgTree({ tree: [] });
    expect(config.tree).toHaveLength(1);
    expect(config.tree[0]?.name).toBe('Organization');
    expect(config.tree[0]?.virtual).toBe(true);
    expect(migrations.addedEmptyRoot).toBe(true);
  });

  it('wraps multiple roots under a synthetic root', () => {
    const { config, migrations } = validateOrgTree({
      tree: [
        { name: 'Engineering', virtual: true, children: [{ name: 'backend' }] },
        { name: 'Sales', virtual: true, children: [{ name: 'east' }] },
      ],
    });
    expect(config.tree).toHaveLength(1);
    expect(config.tree[0]?.name).toBe('Organization');
    expect(config.tree[0]?.children).toHaveLength(2);
    expect(migrations.wrappedRoots).toBe(true);
  });

  it('wraps a single non-virtual root under the synthetic root', () => {
    const { config, migrations } = validateOrgTree({
      tree: [{ name: 'single-team' }],
    });
    expect(config.tree[0]?.name).toBe('Organization');
    expect(config.tree[0]?.children?.[0]?.name).toBe('single-team');
    expect(migrations.wrappedRoots).toBe(true);
  });

  it('auto-promotes a node that has children but no virtual flag', () => {
    const { config, migrations } = validateOrgTree({
      tree: [{
        name: 'Root',
        virtual: true,
        children: [{ name: 'SRE', children: [{ name: 'sre-emea' }, { name: 'sre-us' }] }],
      }],
    });
    const sre = config.tree[0]?.children?.[0];
    expect(sre?.name).toBe('SRE');
    expect(sre?.virtual).toBe(true);
    expect(migrations.promotedToVirtual).toEqual(['SRE']);
  });
});
