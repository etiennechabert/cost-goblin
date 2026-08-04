import { describe, expect, it } from 'vitest';
import { validateBaselines } from '../config/baselines-validator.js';
import { BUILTIN_EXCLUSION_RULES } from '../config/cost-scope-seed.js';
import { asDimensionId } from '../types/branded.js';
import type { DimensionsConfig } from '../types/config.js';

const dimensions: DimensionsConfig = {
  builtIn: [
    { name: asDimensionId('service'), label: 'Service', field: 'service' },
    { name: asDimensionId('service_code'), label: 'Service Code', field: 'service_code' },
    { name: asDimensionId('charge_category'), label: 'Charge Category', field: 'charge_category' },
    { name: asDimensionId('account'), label: 'Account', field: 'account_id' },
  ],
  tags: [{ tagName: 'user:CostCenter', label: 'Cost Center' }],
};

function rawSpec(basis: unknown): unknown {
  return {
    baselines: [{
      id: 'bl-1',
      source: 'discovered',
      scope: { kind: 'filter', filters: { service: ['Amazon Relational Database Service'] } },
      basis,
      basisSnapshotAt: '2026-06-01T00:00:00.000Z',
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
    }],
  };
}

// Baselines shipped before the FOCUS migration, so persisted bases carry
// CUR-era rule snapshots verbatim. The basis is evaluated directly (it never
// passes through the live scope's getCostScope merge), so validateBasis must
// apply the same built-in repair — otherwise a legacy premium-support basis
// emits `service IN ('AWSSupportEnterprise', ...)` against FOCUS ServiceName
// display names, matches nothing, and baseline totals silently re-include
// support fees the discovered band was learned without.
describe('validateBaselines: CUR-era basis repair', () => {
  it('repairs the untouched CUR-era premium-support seed conditions in a persisted basis', () => {
    const [spec] = validateBaselines(rawSpec({
      costMetric: 'effective',
      rules: [{
        id: 'builtin:aws-premium-support', name: 'AWS Premium Support', enabled: true, builtIn: true,
        conditions: [{
          dimensionId: 'service',
          values: ['AWSSupportEnterprise', 'AWSSupportBusiness', 'AWSSupportDeveloper'],
        }],
      }],
    }), dimensions);
    const rule = spec?.basis.rules.find(r => r.id === 'builtin:aws-premium-support');
    expect(rule?.enabled).toBe(true);
    expect(rule?.conditions).toEqual(
      BUILTIN_EXCLUSION_RULES.find(r => r.id === 'builtin:aws-premium-support')?.conditions,
    );
    expect(rule?.conditions[0]?.dimensionId).toBe('service_code');
  });

  it('preserves user-edited built-in conditions in a basis (only the exact legacy seed shape is repaired)', () => {
    const edited = [{ dimensionId: 'service', values: ['AWSSupportEnterprise'] }];
    const [spec] = validateBaselines(rawSpec({
      costMetric: 'effective',
      rules: [{
        id: 'builtin:aws-premium-support', name: 'AWS Premium Support', enabled: true, builtIn: true,
        conditions: edited,
      }],
    }), dimensions);
    const rule = spec?.basis.rules.find(r => r.id === 'builtin:aws-premium-support');
    expect(rule?.conditions).toEqual(edited);
  });

  it('drops retired rules from a basis and rewrites the metric when ri-sp-purchases was enabled', () => {
    const [spec] = validateBaselines(rawSpec({
      costMetric: 'amortized',
      rules: [{
        id: 'builtin:ri-sp-purchases', name: 'RI/SP purchases', enabled: true, builtIn: true,
        conditions: [{ dimensionId: 'line_item_type', values: ['RIFee', 'SavingsPlanRecurringFee'] }],
      }],
    }), dimensions);
    expect(spec?.basis.rules.some(r => r.id === 'builtin:ri-sp-purchases')).toBe(false);
    expect(spec?.basis.costMetric).toBe('list');
  });

  it('backfills built-in rules missing from a basis (disabled, so query results are unchanged)', () => {
    const [spec] = validateBaselines(rawSpec({ costMetric: 'billed', rules: [] }), dimensions);
    expect(spec?.basis.rules.map(r => r.id).sort()).toEqual(
      [...BUILTIN_EXCLUSION_RULES.map(r => r.id)].sort(),
    );
    expect(spec?.basis.rules.every(r => !r.enabled)).toBe(true);
  });

  it('is idempotent: re-validating an already-repaired basis changes nothing', () => {
    const first = validateBaselines(rawSpec({
      costMetric: 'effective',
      rules: [{
        id: 'builtin:aws-premium-support', name: 'AWS Premium Support', enabled: true, builtIn: true,
        conditions: [{
          dimensionId: 'service',
          values: ['AWSSupportEnterprise', 'AWSSupportBusiness', 'AWSSupportDeveloper'],
        }],
      }],
    }), dimensions);
    const again = validateBaselines(rawSpec(first[0]?.basis), dimensions);
    expect(again[0]?.basis).toEqual(first[0]?.basis);
  });

  it('exempts a live tag_user_* shaped basis rule dimension from the CUR-era rename', () => {
    // dimensions carries tag key `user:CostCenter` → live id tag_user_CostCenter.
    const [spec] = validateBaselines(rawSpec({
      costMetric: 'effective',
      rules: [{
        id: 'user:cc', name: 'Cost center scope', enabled: true,
        conditions: [{ dimensionId: 'tag_user_CostCenter', values: ['123'] }],
      }],
    }), dimensions);
    const rule = spec?.basis.rules.find(r => r.id === 'user:cc');
    expect(rule?.conditions[0]?.dimensionId).toBe('tag_user_CostCenter');
  });
});
