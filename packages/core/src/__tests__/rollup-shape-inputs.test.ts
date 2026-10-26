import { describe, expect, it } from 'vitest';
import { asDimensionId, tagDimColumn, tagSqlColumn } from '../types/branded.js';
import type { DimensionsConfig, TagDimension } from '../types/config.js';
import type { ExclusionRule, MarketplaceAttributionConfig } from '../types/cost-scope.js';
import { computeOrgAccountsDigest, computeShapeSignature, enabledGrainColumns } from '../rollup/shape-signature.js';
import { sha256Hex } from '../rollup/digest.js';

/**
 * Inputs to the rollup shape signature that the main suite does not reach:
 * rules on dimensions the config does not define, account-only tag
 * dimensions, input order, and the malformed org-accounts files the digest
 * must still treat deterministically. A signature that moves for no reason
 * forces a full re-roll; one that fails to move serves stale partitions.
 */

const TEAM: TagDimension = { tagName: 'team', label: 'Team', normalize: 'lowercase' };
const ENV: TagDimension = { tagName: 'env', label: 'Environment' };
const DEPARTMENT: TagDimension = { label: 'Department', accountTagFallback: 'department' };

function dims(tags: readonly TagDimension[] = [TEAM]): DimensionsConfig {
  return {
    builtIn: [
      { name: asDimensionId('account'), label: 'Account', field: 'account_id' },
      { name: asDimensionId('service'), label: 'Service', field: 'service' },
    ],
    tags,
  };
}

function ruleOn(dimensionId: string, values: string[]): ExclusionRule[] {
  return [{ id: 'r1', name: 'r1', enabled: true, builtIn: false, conditions: [{ dimensionId: asDimensionId(dimensionId), values }] }];
}

const sig = (over: Partial<Parameters<typeof computeShapeSignature>[0]> = {}): string =>
  computeShapeSignature({ providerType: 'aws', dimensions: dims(), costMetric: 'effective', rules: [], orgAccountsDigest: 'org', ...over });

describe('computeShapeSignature', () => {
  it('leaves out a rule on an unconfigured dimension, whatever its values', () => {
    // Such a rule matches nothing at build time, so it stores the bytes of
    // no rule; its values select nothing either.
    expect(sig({ rules: ruleOn('ghost', ['A']) })).toBe(sig());
    expect(sig({ rules: ruleOn('ghost', ['A']) })).toBe(sig({ rules: ruleOn('ghost', ['a']) }));
    // A configured dim's normalize rule makes the same two values one value.
    const teamId = tagDimColumn(TEAM);
    expect(sig({ rules: ruleOn(teamId, ['Prod']) })).toBe(sig({ rules: ruleOn(teamId, ['prod']) }));
  });

  it('does not depend on the order of the tag dimensions', () => {
    expect(sig({ dimensions: dims([TEAM, ENV]) })).toBe(sig({ dimensions: dims([ENV, TEAM]) }));
    expect(sig({ dimensions: dims([TEAM, ENV]) })).not.toBe(sig({ dimensions: dims([TEAM]) }));
  });

  it('gives an account-only tag dimension (no tagName) a grain entry of its own', () => {
    const withDept = sig({ dimensions: dims([TEAM, DEPARTMENT]) });
    expect(withDept).not.toBe(sig());
    expect(withDept).toBe(sig({ dimensions: dims([DEPARTMENT, TEAM]) }));
    // Pointing it at another account tag changes what is baked.
    expect(sig({ dimensions: dims([TEAM, { ...DEPARTMENT, accountTagFallback: 'cost_center' }]) })).not.toBe(withDept);
  });

  it('does not depend on the order of the marketplace rules', () => {
    const bedrock = { service: 'Amazon Bedrock', operations: ['InvokeModelInference'] };
    const sagemaker = { service: 'Amazon SageMaker', operations: ['InvokeEndpoint', 'CreateEndpoint'] };
    const both = (rules: MarketplaceAttributionConfig['rules']): MarketplaceAttributionConfig => ({ enabled: true, rules });
    expect(sig({ marketplaceAttribution: both([bedrock, sagemaker]) })).toBe(sig({ marketplaceAttribution: both([sagemaker, bedrock]) }));
    // Unusable rules (no service, or no operations) contribute nothing.
    const unusable = [{ service: '', operations: ['InvokeModelInference'] }, { service: 'Amazon Nova', operations: [] }];
    expect(sig({ marketplaceAttribution: both([bedrock, ...unusable]) })).toBe(sig({ marketplaceAttribution: both([bedrock]) }));
    expect(sig({ marketplaceAttribution: both(unusable) })).toBe(sig());
  });
});

describe('enabledGrainColumns', () => {
  it('leaves disabled tag dimensions out of the grain', () => {
    const columns = enabledGrainColumns(dims([TEAM, { ...ENV, enabled: false }, DEPARTMENT]));
    expect(columns).toContain(tagSqlColumn(TEAM));
    expect(columns).toContain(tagSqlColumn(DEPARTMENT));
    expect(columns).not.toContain(tagSqlColumn(ENV));
  });

  it('lists a column shared by two built-ins once', () => {
    const regionFamily: DimensionsConfig = {
      builtIn: [
        { name: asDimensionId('region'), label: 'Region', field: 'region' },
        { name: asDimensionId('region_country'), label: 'Country', field: 'region' },
        { name: asDimensionId('service'), label: 'Service', field: 'service' },
      ],
      tags: [],
    };
    expect(enabledGrainColumns(regionFamily)).toEqual(['region', 'service']);
  });
});

describe('computeOrgAccountsDigest on malformed files', () => {
  const digest = (value: unknown): string => computeOrgAccountsDigest(JSON.stringify(value));

  it('digests unparseable JSON to one fixed sentinel', () => {
    expect(computeOrgAccountsDigest('{"accounts": [')).toBe(sha256Hex('invalid'));
    expect(computeOrgAccountsDigest('')).toBe(sha256Hex('invalid'));
  });

  it('digests a file without an accounts array to another fixed sentinel', () => {
    for (const raw of ['{}', 'null', '42', '"accounts"', '{"accounts":{}}', '{"accounts":null}']) {
      expect(computeOrgAccountsDigest(raw), raw).toBe(sha256Hex('empty'));
    }
    expect(sha256Hex('empty')).not.toBe(sha256Hex('invalid'));
  });

  it('drops account entries that are not objects', () => {
    const account = { id: '111', ouPath: 'r/ou', tags: { team: 'x' } };
    expect(digest({ accounts: [account, 5, 'acct', null, true] })).toBe(digest({ accounts: [account] }));
  });

  it('reads a missing or non-string id and ouPath as empty', () => {
    const blank = digest({ accounts: [{ id: '', ouPath: '', tags: {} }] });
    expect(digest({ accounts: [{ id: 111, ouPath: ['r'], tags: {} }] })).toBe(blank);
    expect(digest({ accounts: [{ tags: {} }] })).toBe(blank);
    expect(digest({ accounts: [{ id: '111', ouPath: '', tags: {} }] })).not.toBe(blank);
  });

  it('reads missing or non-object tags as none, and keeps only string tag values', () => {
    const noTags = digest({ accounts: [{ id: '1', ouPath: 'p', tags: {} }] });
    for (const tags of [undefined, null, 'team=x', 7]) {
      expect(digest({ accounts: [{ id: '1', ouPath: 'p', tags }] })).toBe(noTags);
    }
    expect(digest({ accounts: [{ id: '1', ouPath: 'p', tags: { team: 'x', cost: 5, owner: null, nested: { a: 'b' } } }] }))
      .toBe(digest({ accounts: [{ id: '1', ouPath: 'p', tags: { team: 'x' } }] }));
    expect(digest({ accounts: [{ id: '1', ouPath: 'p', tags: { team: 'x' } }] })).not.toBe(noTags);
  });
});
