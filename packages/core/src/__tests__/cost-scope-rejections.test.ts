import { describe, expect, it } from 'vitest';
import { validateCostScope } from '../config/cost-scope-validator.js';
import { ConfigValidationError } from '../config/validator.js';

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

const condition = { dimensionId: 'service', values: ['Amazon EC2'] };
const rule = { id: 'user:ec2', name: 'EC2', enabled: true, conditions: [condition] };

function scopeWith(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return { costMetric: 'effective', rules: [], ...fields };
}

function withRule(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return scopeWith({ rules: [{ ...rule, ...fields }] });
}

function withCondition(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return withRule({ conditions: [{ ...condition, ...fields }] });
}

function withMarketplaceRule(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return scopeWith({ marketplaceAttribution: { enabled: true, rules: [{ service: 'Amazon Bedrock', operations: ['InvokeModelInference'], ...fields }] } });
}

describe('validateCostScope: lag days', () => {
  it.each([['negative', -1], ['fractional', 1.5]])('rejects %s lag days', (_label, lagDays) => {
    expect(configError(() => validateCostScope(scopeWith({ lagDays })))).toBe('costScope.lagDays must be a non-negative integer');
  });

  it('rejects non-numeric lag days', () => {
    expect(configError(() => validateCostScope(scopeWith({ lagDays: '2' })))).toBe('costScope.lagDays must be a number');
  });

  it('accepts 0 lag days (include today)', () => {
    expect(validateCostScope(scopeWith({ lagDays: 0 })).lagDays).toBe(0);
  });
});

describe('validateCostScope: exclusion rules', () => {
  it('rejects a rule with no conditions', () => {
    expect(configError(() => validateCostScope(withRule({ conditions: [] }))))
      .toBe('costScope.rules[0].conditions must have at least one entry');
  });

  it.each([
    ['is not an object', scopeWith({ rules: ['user:ec2'] }), 'costScope.rules[0] must be an object'],
    ['has no id', withRule({ id: undefined }), 'costScope.rules[0].id must be a string'],
    ['has no name', withRule({ name: 3 }), 'costScope.rules[0].name must be a string'],
    ['has no condition list', withRule({ conditions: condition }), 'costScope.rules[0].conditions must be an array'],
    ['has a non-string description', withRule({ description: ['why'] }), 'costScope.rules[0].description must be a string'],
    ['has a condition that is not an object', withRule({ conditions: ['service'] }), 'costScope.rules[0].conditions[0] must be an object'],
    ['has a condition without a dimension', withCondition({ dimensionId: undefined }), 'costScope.rules[0].conditions[0].dimensionId must be a string'],
    ['has a condition without a value list', withCondition({ values: 'Amazon EC2' }), 'costScope.rules[0].conditions[0].values must be an array'],
    ['has a non-string condition value', withCondition({ values: ['Amazon EC2', 7] }), 'costScope.rules[0].conditions[0].values[1] must be a string'],
    [
      'has a condition matching nothing',
      withCondition({ values: [] }),
      'costScope.rules[0].conditions[0].values must have at least one entry unless matchMissing is true',
    ],
  ])('rejects a rule that %s', (_label, raw, message) => {
    expect(configError(() => validateCostScope(raw))).toBe(message);
  });

  it('names the index of the broken rule and condition', () => {
    const raw = scopeWith({ rules: [rule, { ...rule, id: 'user:two', conditions: [condition, { dimensionId: 'region' }] }] });
    expect(configError(() => validateCostScope(raw))).toBe('costScope.rules[1].conditions[1].values must be an array');
  });
});

describe('validateCostScope: the cost scope itself', () => {
  it.each([
    ['is not an object', 'effective', 'costScope must be an object'],
    ['has no cost metric', { rules: [] }, 'costScope.costMetric must be a string'],
    ['has an unknown cost metric', scopeWith({ costMetric: 'net' }), 'costScope.costMetric must be one of: billed, effective, list, contracted'],
    ['has no rule list', { costMetric: 'billed' }, 'costScope.rules must be an array'],
  ])('rejects a scope that %s', (_label, raw, message) => {
    expect(configError(() => validateCostScope(raw))).toBe(message);
  });
});

describe('validateCostScope: marketplace attribution', () => {
  it.each([
    ['is not an object', scopeWith({ marketplaceAttribution: true }), 'costScope.marketplaceAttribution must be an object'],
    ['has no rule list', scopeWith({ marketplaceAttribution: { enabled: true } }), 'costScope.marketplaceAttribution.rules must be an array'],
    ['has a rule that is not an object', scopeWith({ marketplaceAttribution: { enabled: true, rules: ['Amazon Bedrock'] } }), 'costScope.marketplaceAttribution.rules[0] must be an object'],
    ['has a rule without a service', withMarketplaceRule({ service: 1 }), 'costScope.marketplaceAttribution.rules[0].service must be a string'],
    ['has a rule with an empty service', withMarketplaceRule({ service: '' }), 'costScope.marketplaceAttribution.rules[0].service must be a non-empty service code'],
    ['has a rule without an operation list', withMarketplaceRule({ operations: 'InvokeModelInference' }), 'costScope.marketplaceAttribution.rules[0].operations must be an array'],
    ['has a non-string operation', withMarketplaceRule({ operations: ['InvokeModelInference', null] }), 'costScope.marketplaceAttribution.rules[0].operations[1] must be a string'],
    ['has a rule with no operations', withMarketplaceRule({ operations: [] }), 'costScope.marketplaceAttribution.rules[0].operations must have at least one entry'],
  ])('rejects a block that %s', (_label, raw, message) => {
    expect(configError(() => validateCostScope(raw))).toBe(message);
  });
});
