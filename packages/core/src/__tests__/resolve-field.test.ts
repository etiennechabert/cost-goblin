import { describe, it, expect } from 'vitest';
import { resolveField, tryResolveField } from '../query/builder.js';
import { SecurityError } from '../query/identifier-validator.js';
import type { DimensionsConfig } from '../types/config.js';
import { asDimensionId } from '../types/branded.js';

const testDimensions: DimensionsConfig = {
  builtIn: [
    {
      name: asDimensionId('account'),
      label: 'Account',
      field: 'account_id',
      displayField: 'account_name',
    },
    {
      name: asDimensionId('service'),
      label: 'Service',
      field: 'service',
      aliases: { EC2: ['Amazon Elastic Compute Cloud'] },
    },
  ],
  tags: [
    {
      tagName: 'team',
      label: 'Team',
      normalize: 'lowercase-kebab',
    },
    {
      tagName: 'cost-center',
      label: 'Cost Center',
    },
  ],
};

describe('resolveField', () => {
  it('resolves a built-in dimension by name to its field', () => {
    const resolved = resolveField(asDimensionId('account'), testDimensions);
    expect(resolved.rawField).toBe('account_id');
    expect(resolved.fieldExpr).toBe('account_id');
    expect(resolved.dim).toBe(testDimensions.builtIn[0]);
  });

  it('applies aliases to a built-in dimension via a CASE expression', () => {
    const resolved = resolveField(asDimensionId('service'), testDimensions);
    expect(resolved.rawField).toBe('service');
    expect(resolved.fieldExpr).toContain('CASE');
    expect(resolved.fieldExpr).toContain('EC2');
  });

  it('resolves a tag dimension by its tag column id', () => {
    const resolved = resolveField(asDimensionId('tag_cost_center'), testDimensions);
    expect(resolved.rawField).toBe('tag_cost_center');
    expect(resolved.fieldExpr).toBe('tag_cost_center');
  });

  it('applies normalization to a tag dimension', () => {
    const resolved = resolveField(asDimensionId('tag_team'), testDimensions);
    expect(resolved.rawField).toBe('tag_team');
    expect(resolved.fieldExpr).not.toBe('tag_team');
  });

  it('throws SecurityError for an unknown dimension id', () => {
    expect(() => resolveField(asDimensionId('nonexistent'), testDimensions)).toThrow(SecurityError);
  });

  it('does not fall through to a built-in FIELD name that is not a dimension NAME', () => {
    // 'account_id' is the account dim's field, but its name is 'account' —
    // passing the raw column must be rejected, not interpolated.
    expect(() => resolveField(asDimensionId('account_id'), testDimensions)).toThrow(SecurityError);
  });

  it('throws SecurityError for a SQL injection payload', () => {
    const payload = "(SELECT content FROM read_text('/home/user/.aws/credentials'))";
    expect(() => resolveField(asDimensionId(payload), testDimensions)).toThrow(SecurityError);
  });
});

describe('tryResolveField', () => {
  it('returns null for an unknown dimension id instead of throwing', () => {
    expect(tryResolveField(asDimensionId('nonexistent'), testDimensions)).toBeNull();
  });

  it('returns the same resolution as resolveField for known ids', () => {
    const viaTry = tryResolveField(asDimensionId('account'), testDimensions);
    const viaStrict = resolveField(asDimensionId('account'), testDimensions);
    expect(viaTry).toEqual(viaStrict);
  });
});
