import { describe, expect, it } from 'vitest';
import { baselineSpecToYaml, baselinesToYaml } from '../config/baselines-serialize.js';
import { validateBaselines } from '../config/baselines-validator.js';
import { BUILTIN_EXCLUSION_RULES, DEFAULT_MARKETPLACE_ATTRIBUTION } from '../config/cost-scope-seed.js';
import { asDimensionId, asTagValue } from '../types/branded.js';
import type { BaselineSpec } from '../types/baseline.js';
import type { DimensionsConfig } from '../types/config.js';
import type { ExclusionRule } from '../types/cost-scope.js';

const dimensions: DimensionsConfig = {
  builtIn: [
    { name: asDimensionId('service'), label: 'Service', field: 'service' },
    { name: asDimensionId('region'), label: 'Region', field: 'region' },
    { name: asDimensionId('charge_category'), label: 'Charge Category', field: 'charge_category' },
  ],
  tags: [],
};

const taxRule: ExclusionRule = {
  id: 'user:tax',
  name: 'Tax',
  enabled: true,
  builtIn: false,
  conditions: [{ dimensionId: asDimensionId('charge_category'), values: ['Tax'] }],
};

const stamps = {
  basisSnapshotAt: '2026-06-01T00:00:00.000Z',
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-02T00:00:00.000Z',
};

/** Every optional field set. */
const fullSpec: BaselineSpec = {
  id: 'bl-full',
  name: 'EC2 in Europe',
  source: 'manual',
  scope: {
    kind: 'filter',
    filters: {
      [asDimensionId('service')]: [asTagValue('Amazon EC2')],
      [asDimensionId('region')]: [asTagValue('eu-west-1'), asTagValue('eu-central-1')],
    },
  },
  basis: { costMetric: 'billed', rules: [taxRule], marketplaceAttribution: { enabled: false, rules: [] }, lagDays: 0 },
  manualBand: { mode: 'absolute', lower: 10, upper: 25 },
  ...stamps,
};

/** Every optional field left out. */
const minimalSpec: BaselineSpec = {
  id: 'bl-min',
  source: 'discovered',
  scope: { kind: 'view', viewId: 'overview' },
  basis: { costMetric: 'effective', rules: [] },
  ...stamps,
};

describe('baselineSpecToYaml', () => {
  it('writes every optional field of a fully-specified baseline', () => {
    expect(baselineSpecToYaml(fullSpec)).toStrictEqual({
      id: 'bl-full',
      name: 'EC2 in Europe',
      source: 'manual',
      scope: { kind: 'filter', filters: { service: ['Amazon EC2'], region: ['eu-west-1', 'eu-central-1'] } },
      basis: {
        costMetric: 'billed',
        lagDays: 0,
        rules: [{ id: 'user:tax', name: 'Tax', enabled: true, builtIn: false, conditions: [{ dimensionId: 'charge_category', values: ['Tax'] }] }],
        marketplaceAttribution: { enabled: false, rules: [] },
      },
      basisSnapshotAt: '2026-06-01T00:00:00.000Z',
      manualBand: { mode: 'absolute', lower: 10, upper: 25 },
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-02T00:00:00.000Z',
    });
  });

  it('writes keys in a stable order, so shared bundles do not produce noisy diffs', () => {
    expect(Object.keys(baselineSpecToYaml(fullSpec))).toEqual([
      'id', 'name', 'source', 'scope', 'basis', 'basisSnapshotAt', 'manualBand', 'createdAt', 'updatedAt',
    ]);
  });

  it('leaves out every optional key of a minimal view-scoped baseline', () => {
    expect(baselineSpecToYaml(minimalSpec)).toStrictEqual({
      id: 'bl-min',
      source: 'discovered',
      scope: { kind: 'view', viewId: 'overview' },
      basis: { costMetric: 'effective', rules: [] },
      basisSnapshotAt: '2026-06-01T00:00:00.000Z',
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-02T00:00:00.000Z',
    });
  });

  it('writes only the band edges that are set', () => {
    expect(baselineSpecToYaml({ ...minimalSpec, manualBand: { mode: 'percentile', upper: 95 } })['manualBand'])
      .toStrictEqual({ mode: 'percentile', upper: 95 });
    expect(baselineSpecToYaml({ ...minimalSpec, manualBand: { mode: 'absolute', lower: 0 } })['manualBand'])
      .toStrictEqual({ mode: 'absolute', lower: 0 });
    expect(baselineSpecToYaml({ ...minimalSpec, manualBand: { mode: 'percentile' } })['manualBand'])
      .toStrictEqual({ mode: 'percentile' });
  });

  it('drops a filter dimension that holds no value list', () => {
    const spec: BaselineSpec = {
      ...minimalSpec,
      scope: { kind: 'filter', filters: { [asDimensionId('service')]: [asTagValue('Amazon S3')], [asDimensionId('region')]: undefined } },
    };
    expect(baselineSpecToYaml(spec)['scope']).toStrictEqual({ kind: 'filter', filters: { service: ['Amazon S3'] } });
  });

  it('omits the default lag days (2) from the basis, like cost-scope.yaml', () => {
    const spec: BaselineSpec = { ...minimalSpec, basis: { costMetric: 'effective', rules: [], lagDays: 2 } };
    expect(baselineSpecToYaml(spec)['basis']).toStrictEqual({ costMetric: 'effective', rules: [] });
  });
});

describe('baselinesToYaml', () => {
  it('wraps the specs in a { baselines } block, in order', () => {
    expect(baselinesToYaml([fullSpec, minimalSpec])).toStrictEqual({
      baselines: [baselineSpecToYaml(fullSpec), baselineSpecToYaml(minimalSpec)],
    });
    expect(baselinesToYaml([])).toStrictEqual({ baselines: [] });
  });

  it('round-trips through validateBaselines unchanged', () => {
    // A persisted basis is re-merged with the built-in rules and given the
    // marketplace default on load, so the specs carry both, as real ones do.
    const specs: readonly BaselineSpec[] = [
      { ...fullSpec, basis: { ...fullSpec.basis, rules: BUILTIN_EXCLUSION_RULES } },
      {
        ...minimalSpec,
        basis: { costMetric: 'effective', rules: BUILTIN_EXCLUSION_RULES, marketplaceAttribution: DEFAULT_MARKETPLACE_ATTRIBUTION },
        manualBand: { mode: 'percentile', upper: 95 },
      },
    ];
    expect(validateBaselines(baselinesToYaml(specs), dimensions)).toStrictEqual(specs);
  });
});
