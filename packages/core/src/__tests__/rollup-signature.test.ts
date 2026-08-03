import { describe, expect, it } from 'vitest';
import { asDimensionId } from '../types/branded.js';
import type { DimensionsConfig } from '../types/config.js';
import type { ExclusionRule } from '../types/cost-scope.js';
import {
  computeShapeSignature,
  computeOrgAccountsDigest,
  enabledGrainColumns,
  ROLLUP_SCHEMA_VERSION,
} from '../rollup/shape-signature.js';
import { validateManifest, computePartitionEtagHash, type RollupManifest } from '../rollup/manifest.js';

function baseDims(): DimensionsConfig {
  return {
    builtIn: [
      { name: asDimensionId('account'), label: 'Account', field: 'account_id' },
      { name: asDimensionId('service'), label: 'Service', field: 'service' },
      { name: asDimensionId('sku_meter'), label: 'SKU Meter', field: 'sku_meter', enabled: false },
      { name: asDimensionId('region'), label: 'Region', field: 'region', enabled: false },
    ],
    tags: [
      { tagName: 'sb_team', label: 'Owner', normalize: 'lowercase-kebab', aliases: { architects: ['architecture'] } },
    ],
  };
}

function rulesOnService(): ExclusionRule[] {
  return [{ id: 'r1', name: 'Tax', enabled: true, builtIn: true, conditions: [{ dimensionId: asDimensionId('service'), values: ['AWSSupport'] }] }];
}

function dimsWithTeamAliases(aliases: Record<string, string[]>): DimensionsConfig {
  return { builtIn: baseDims().builtIn, tags: [{ tagName: 'sb_team', label: 'Owner', normalize: 'lowercase-kebab', aliases }] };
}

const sig = (over: Partial<Parameters<typeof computeShapeSignature>[0]> = {}) =>
  computeShapeSignature({
    dimensions: baseDims(),
    costMetric: 'list',
    rules: rulesOnService(),
    orgAccountsDigest: 'orgX',
    ...over,
  });

describe('computeShapeSignature', () => {
  it('is stable for equal input and ignores rule-value order', () => {
    expect(sig()).toBe(sig());
    const twoVals = (values: string[]): ExclusionRule[] => [{ id: 'r1', name: 'r', enabled: true, builtIn: true, conditions: [{ dimensionId: asDimensionId('service'), values }] }];
    expect(sig({ rules: twoVals(['a', 'b']) })).toBe(sig({ rules: twoVals(['b', 'a']) }));
  });

  it('CHANGES when a disabled dim (sku_meter) is enabled', () => {
    const d: DimensionsConfig = { ...baseDims(), builtIn: baseDims().builtIn.map(b => b.name === 'sku_meter' ? { ...b, enabled: true } : b) };
    expect(sig({ dimensions: d })).not.toBe(sig());
  });

  it('CHANGES on metric, org-accounts, and added enabled rule', () => {
    expect(sig({ costMetric: 'effective' })).not.toBe(sig());
    expect(sig({ orgAccountsDigest: 'orgY' })).not.toBe(sig());
    expect(sig({ rules: [...rulesOnService(), { id: 'r2', name: 'x', enabled: true, builtIn: false, conditions: [{ dimensionId: asDimensionId('region'), values: ['eu'] }] }] })).not.toBe(sig());
  });

  it('does NOT change when a disabled rule is added (only enabled rules count)', () => {
    expect(sig({ rules: [...rulesOnService(), { id: 'r3', name: 'off', enabled: false, builtIn: false, conditions: [{ dimensionId: asDimensionId('region'), values: ['eu'] }] }] })).toBe(sig());
  });

  it('alias carve-out: alias change on a dim REFERENCED by an enabled rule changes the signature', () => {
    const teamRule: ExclusionRule[] = [{ id: 'rt', name: 't', enabled: true, builtIn: false, conditions: [{ dimensionId: asDimensionId('tag_sb_team'), values: ['architecture'] }] }];
    // 'architecture' is aliased in A but not B → the rule drops different rows.
    expect(sig({ dimensions: dimsWithTeamAliases({ architects: ['architecture'] }), rules: teamRule }))
      .not.toBe(sig({ dimensions: dimsWithTeamAliases({ architects: ['arch'] }), rules: teamRule }));
  });

  it('alias change on a dim NOT referenced by any rule does NOT change the signature', () => {
    // rules are on `service`, not the tag → the tag's aliases never enter the signature
    expect(sig({ dimensions: dimsWithTeamAliases({ architects: ['arch', 'foo'] }) })).toBe(sig());
  });

  describe('marketplace attribution', () => {
    const bedrock = { enabled: true, rules: [{ service: 'Amazon Bedrock', operations: ['InvokeModelInference', 'InvokeModelStreamingInference'] }] };

    it('CHANGES when enabled (rewrites service/cost bytes)', () => {
      expect(sig({ marketplaceAttribution: bedrock })).not.toBe(sig());
    });

    it('disabled hashes identically to absent (no spurious re-roll)', () => {
      expect(sig({ marketplaceAttribution: { enabled: false, rules: bedrock.rules } })).toBe(sig());
      expect(sig({ marketplaceAttribution: { enabled: true, rules: [] } })).toBe(sig());
    });

    it('ignores operation order within a rule', () => {
      const reversed = { enabled: true, rules: [{ service: 'Amazon Bedrock', operations: ['InvokeModelStreamingInference', 'InvokeModelInference'] }] };
      expect(sig({ marketplaceAttribution: bedrock })).toBe(sig({ marketplaceAttribution: reversed }));
    });

    it('CHANGES when the target service differs', () => {
      const other = { enabled: true, rules: [{ service: 'Amazon SageMaker', operations: ['InvokeModelInference', 'InvokeModelStreamingInference'] }] };
      expect(sig({ marketplaceAttribution: bedrock })).not.toBe(sig({ marketplaceAttribution: other }));
    });
  });
});

describe('computeOrgAccountsDigest', () => {
  const a = JSON.stringify({ accounts: [{ id: '2', name: 'B', ouPath: 'p2', tags: { team: 'x' } }, { id: '1', name: 'A', ouPath: 'p1', tags: { team: 'y', env: 'prod' } }] });

  it('is stable across account order, tag-key order, and whitespace', () => {
    const reordered = JSON.stringify({ accounts: [{ id: '1', ouPath: 'p1', tags: { env: 'prod', team: 'y' }, name: 'A' }, { id: '2', tags: { team: 'x' }, name: 'B', ouPath: 'p2' }] }, null, 2);
    expect(computeOrgAccountsDigest(reordered)).toBe(computeOrgAccountsDigest(a));
  });

  it('ignores the account name (display-only) but reacts to tags and ouPath', () => {
    const nameChanged = JSON.stringify({ accounts: [{ id: '2', name: 'B-renamed', ouPath: 'p2', tags: { team: 'x' } }, { id: '1', name: 'A', ouPath: 'p1', tags: { team: 'y', env: 'prod' } }] });
    expect(computeOrgAccountsDigest(nameChanged)).toBe(computeOrgAccountsDigest(a));
    const tagChanged = JSON.stringify({ accounts: [{ id: '2', name: 'B', ouPath: 'p2', tags: { team: 'z' } }, { id: '1', name: 'A', ouPath: 'p1', tags: { team: 'y', env: 'prod' } }] });
    expect(computeOrgAccountsDigest(tagChanged)).not.toBe(computeOrgAccountsDigest(a));
  });
});

describe('enabledGrainColumns', () => {
  it('returns enabled dim columns only, sorted', () => {
    expect(enabledGrainColumns(baseDims())).toEqual(['account_id', 'service', 'tag_sb_team']);
  });
});

describe('validateManifest', () => {
  const etags = { '2026-05': { 'k1': 'h1' }, '2026-06': { 'k2': 'h2' } };
  const manifest = (over: Partial<RollupManifest> = {}): RollupManifest => ({
    schemaVersion: ROLLUP_SCHEMA_VERSION,
    shapeSignature: 'SIG',
    builtAt: '2026-06-23T00:00:00Z',
    grainDimensions: ['account_id', 'service'],
    partitions: {
      '2026-05': { rawEtagHash: computePartitionEtagHash(etags['2026-05']), rows: 10, bytes: 100 },
      '2026-06': { rawEtagHash: computePartitionEtagHash(etags['2026-06']), rows: 20, bytes: 200 },
    },
    ...over,
  });
  const opts = { currentSignature: 'SIG', currentSchemaVersion: ROLLUP_SCHEMA_VERSION, etagsByPeriod: etags };

  it('null manifest is fully invalid', () => {
    expect(validateManifest(null, opts).fullyInvalid).toBe(true);
  });

  it('signature or schema mismatch is fully invalid', () => {
    expect(validateManifest(manifest({ shapeSignature: 'OTHER' }), opts).fullyInvalid).toBe(true);
    expect(validateManifest(manifest({ schemaVersion: 999 }), opts).fullyInvalid).toBe(true);
  });

  it('matching signature: partitions valid; a changed period is stale', () => {
    const v1 = validateManifest(manifest(), opts);
    expect(v1.fullyInvalid).toBe(false);
    expect([...v1.validPeriods].sort()).toEqual(['2026-05', '2026-06']);
    expect(v1.stalePeriods.size).toBe(0);

    const changed = { ...etags, '2026-06': { 'k2': 'h2-NEW' } };
    const v2 = validateManifest(manifest(), { ...opts, etagsByPeriod: changed });
    expect([...v2.validPeriods]).toEqual(['2026-05']);
    expect([...v2.stalePeriods]).toEqual(['2026-06']);
  });
});
