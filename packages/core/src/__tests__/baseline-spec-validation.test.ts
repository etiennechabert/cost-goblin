import { describe, expect, it } from 'vitest';
import { validateBaselines } from '../config/baselines-validator.js';
import { DEFAULT_MARKETPLACE_ATTRIBUTION } from '../config/cost-scope-seed.js';
import { ConfigValidationError } from '../config/validator.js';
import { asDimensionId } from '../types/branded.js';
import type { BaselineSpec } from '../types/baseline.js';
import type { DimensionsConfig } from '../types/config.js';

const dimensions: DimensionsConfig = {
  builtIn: [
    { name: asDimensionId('service'), label: 'Service', field: 'service' },
    { name: asDimensionId('region'), label: 'Region', field: 'region' },
  ],
  tags: [{ tagName: 'team', label: 'Team' }],
};

/** A valid persisted baseline; each test overrides only the field it is about. */
function rawSpec(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'bl-1',
    source: 'manual',
    scope: { kind: 'filter', filters: { service: ['Amazon EC2'] } },
    basis: { costMetric: 'effective', rules: [] },
    basisSnapshotAt: '2026-06-01T00:00:00.000Z',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-02T00:00:00.000Z',
    ...overrides,
  };
}

function validateOne(spec: unknown): BaselineSpec {
  const [validated] = validateBaselines({ baselines: [spec] }, dimensions);
  if (validated === undefined) throw new Error('expected one validated baseline');
  return validated;
}

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

describe('validateBaselines: view scopes', () => {
  it('accepts a scope that references a saved view, keeping only the view id', () => {
    const spec = validateOne(rawSpec({ scope: { kind: 'view', viewId: 'overview', filters: { service: ['x'] } } }));
    expect(spec.scope).toStrictEqual({ kind: 'view', viewId: 'overview' });
  });

  it('rejects a view scope without a string view id', () => {
    expect(configError(() => validateOne(rawSpec({ scope: { kind: 'view' } }))))
      .toBe('baselines[0].scope.viewId must be a string');
    expect(configError(() => validateOne(rawSpec({ scope: { kind: 'view', viewId: 7 } }))))
      .toBe('baselines[0].scope.viewId must be a string');
  });
});

describe('validateBaselines: scope kinds and filters', () => {
  it.each([
    ['an unknown kind', { kind: 'tag', filters: {} }],
    ['no kind at all', { filters: { service: ['Amazon EC2'] } }],
  ])('rejects a scope with %s', (_label, scope) => {
    expect(configError(() => validateOne(rawSpec({ scope }))))
      .toBe("baselines[0].scope.kind must be 'filter' or 'view'");
  });

  it('rejects a scope that is not an object', () => {
    expect(configError(() => validateOne(rawSpec({ scope: 'service' }))))
      .toBe('baselines[0].scope must be an object');
  });

  it('rejects a filter keyed by a tag dimension, explaining why', () => {
    expect(configError(() => validateOne(rawSpec({ scope: { kind: 'filter', filters: { team: ['core'] } } }))))
      .toBe(
        'baselines[0].scope.filters: "team" is not a built-in dimension. ' +
        'Baseline scopes may only use built-in (non-tag) dimensions — tag values churn and would report false drift.',
      );
  });

  it('rejects filter values that are not an array of strings', () => {
    expect(configError(() => validateOne(rawSpec({ scope: { kind: 'filter', filters: { service: 'Amazon EC2' } } }))))
      .toBe('baselines[0].scope.filters.service must be an array');
    expect(configError(() => validateOne(rawSpec({ scope: { kind: 'filter', filters: { region: ['eu-west-1', 3] } } }))))
      .toBe('baselines[0].scope.filters.region[1] must be a string');
  });

  it('accepts several built-in filters', () => {
    const spec = validateOne(rawSpec({ scope: { kind: 'filter', filters: { service: ['Amazon EC2'], region: ['eu-west-1', 'us-east-1'] } } }));
    expect(spec.scope).toStrictEqual({ kind: 'filter', filters: { service: ['Amazon EC2'], region: ['eu-west-1', 'us-east-1'] } });
  });
});

describe('validateBaselines: manual band overrides', () => {
  it('keeps both edges of an absolute band', () => {
    const spec = validateOne(rawSpec({ manualBand: { mode: 'absolute', lower: 10, upper: 25.5 } }));
    expect(spec.manualBand).toStrictEqual({ mode: 'absolute', lower: 10, upper: 25.5 });
  });

  it('keeps a percentile band that overrides only the upper edge', () => {
    const spec = validateOne(rawSpec({ manualBand: { mode: 'percentile', upper: 90 } }));
    expect(spec.manualBand).toStrictEqual({ mode: 'percentile', upper: 90 });
  });

  it('keeps a lower edge of 0 (an explicit zero is not an unset edge)', () => {
    const spec = validateOne(rawSpec({ manualBand: { mode: 'absolute', lower: 0 } }));
    expect(spec.manualBand).toStrictEqual({ mode: 'absolute', lower: 0 });
  });

  it('keeps a band that sets a mode but no edge', () => {
    expect(validateOne(rawSpec({ manualBand: { mode: 'percentile' } })).manualBand).toStrictEqual({ mode: 'percentile' });
  });

  it('omits the manualBand key when the baseline has none', () => {
    expect(validateOne(rawSpec())).not.toHaveProperty('manualBand');
  });

  it.each([
    ['is not an object', 'absolute', 'baselines[0].manualBand must be an object'],
    ['has no mode', { lower: 1 }, 'baselines[0].manualBand.mode must be a string'],
    ['has an unknown mode', { mode: 'relative' }, "baselines[0].manualBand.mode must be 'absolute' or 'percentile'"],
    ['has a non-numeric lower edge', { mode: 'absolute', lower: '10' }, 'baselines[0].manualBand.lower must be a number'],
    ['has a null upper edge', { mode: 'percentile', upper: null }, 'baselines[0].manualBand.upper must be a number'],
  ])('rejects a band that %s', (_label, manualBand, message) => {
    expect(configError(() => validateOne(rawSpec({ manualBand })))).toBe(message);
  });
});

describe('validateBaselines: basis fields', () => {
  it('keeps the basis lag days, including 0', () => {
    const spec = validateOne(rawSpec({ basis: { costMetric: 'billed', lagDays: 0, rules: [] } }));
    expect(spec.basis.lagDays).toBe(0);
    expect(spec.basis.costMetric).toBe('billed');
  });

  it('omits lag days when the basis has none', () => {
    expect(validateOne(rawSpec()).basis).not.toHaveProperty('lagDays');
  });

  it('keeps an explicit marketplace attribution opt-out', () => {
    const spec = validateOne(rawSpec({ basis: { costMetric: 'effective', rules: [], marketplaceAttribution: { enabled: false, rules: [] } } }));
    expect(spec.basis.marketplaceAttribution).toStrictEqual({ enabled: false, rules: [] });
  });

  it('gives a basis without marketplace attribution the shipped default', () => {
    expect(validateOne(rawSpec()).basis.marketplaceAttribution).toStrictEqual(DEFAULT_MARKETPLACE_ATTRIBUTION);
  });
});

describe('validateBaselines: spec fields', () => {
  it('reads any source other than manual as discovered', () => {
    expect(validateOne(rawSpec({ source: 'manual' })).source).toBe('manual');
    expect(validateOne(rawSpec({ source: 'imported' })).source).toBe('discovered');
  });

  it.each([
    ['id', { id: 42 }, 'baselines[0].id must be a string'],
    ['name', { name: 7 }, 'baselines[0].name must be a string'],
    ['source', { source: undefined }, 'baselines[0].source must be a string'],
    ['basisSnapshotAt', { basisSnapshotAt: undefined }, 'baselines[0].basisSnapshotAt must be a string'],
    ['createdAt', { createdAt: 1 }, 'baselines[0].createdAt must be a string'],
    ['updatedAt', { updatedAt: null }, 'baselines[0].updatedAt must be a string'],
  ])('rejects a spec whose %s is not a string', (_field, overrides, message) => {
    expect(configError(() => validateOne(rawSpec(overrides)))).toBe(message);
  });

  it('names the index of the broken spec', () => {
    expect(configError(() => validateBaselines({ baselines: [rawSpec(), rawSpec({ id: undefined })] }, dimensions)))
      .toBe('baselines[1].id must be a string');
  });

  it('rejects a payload that is not a { baselines: [...] } object', () => {
    expect(configError(() => validateBaselines([], dimensions))).toBe('baselines must be an object');
    expect(configError(() => validateBaselines({ baselines: {} }, dimensions))).toBe('baselines.baselines must be an array');
    expect(configError(() => validateBaselines({ baselines: ['bl-1'] }, dimensions))).toBe('baselines[0] must be an object');
  });

  it('returns an empty list for an empty baselines block', () => {
    expect(validateBaselines({ baselines: [] }, dimensions)).toStrictEqual([]);
  });
});
