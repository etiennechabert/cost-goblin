import { describe, expect, it, vi } from 'vitest';
import { validateBaselines } from '../config/baselines-validator.js';
import { BUILTIN_EXCLUSION_RULES } from '../config/cost-scope-seed.js';
import { asDimensionId } from '../types/branded.js';
import type { DimensionsConfig } from '../types/config.js';
import type { CostScopeConfig } from '../types/cost-scope.js';

// validateCostScope always fills in the marketplace-attribution default, so a
// basis can only lack the block if the cost-scope validator stops doing that.
// The stub runs the real validator and drops the block, to check the basis
// mirrors the scope it was given instead of inventing a block of its own.
vi.mock('../config/cost-scope-validator.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/cost-scope-validator.js')>();
  return {
    ...actual,
    validateCostScope: (raw: unknown, liveDimensionIds?: ReadonlySet<string>): CostScopeConfig => {
      const scope = actual.validateCostScope(raw, liveDimensionIds);
      return { costMetric: scope.costMetric, rules: scope.rules, ...(scope.lagDays === undefined ? {} : { lagDays: scope.lagDays }) };
    },
  };
});

const dimensions: DimensionsConfig = {
  builtIn: [{ name: asDimensionId('service'), label: 'Service', field: 'service' }],
  tags: [],
};

function basisOf(basis: unknown): unknown {
  const [spec] = validateBaselines({
    baselines: [{
      id: 'bl-1',
      source: 'discovered',
      scope: { kind: 'filter', filters: { service: ['Amazon EC2'] } },
      basis,
      basisSnapshotAt: '2026-06-01T00:00:00.000Z',
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
    }],
  }, dimensions);
  return spec?.basis;
}

describe('validateBaselines: a cost scope without marketplace attribution', () => {
  it('leaves the marketplaceAttribution key out of the basis', () => {
    expect(basisOf({ costMetric: 'billed', rules: [] })).toStrictEqual({ costMetric: 'billed', rules: [...BUILTIN_EXCLUSION_RULES] });
  });

  it('still carries the lag days', () => {
    expect(basisOf({ costMetric: 'billed', rules: [], lagDays: 4 })).toStrictEqual({ costMetric: 'billed', rules: [...BUILTIN_EXCLUSION_RULES], lagDays: 4 });
  });
});
