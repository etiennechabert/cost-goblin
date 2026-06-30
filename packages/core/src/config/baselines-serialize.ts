import type { BaselineScope, BaselineSpec, ManualBand } from '../types/baseline.js';
import type { CostScopeConfig } from '../types/cost-scope.js';
import { costScopeToYaml } from './cost-scope-serialize.js';

function manualBandToYaml(m: ManualBand): Record<string, unknown> {
  return {
    mode: m.mode,
    ...(m.lower === undefined ? {} : { lower: m.lower }),
    ...(m.upper === undefined ? {} : { upper: m.upper }),
  };
}

function scopeToYaml(scope: BaselineScope): Record<string, unknown> {
  if (scope.kind === 'view') return { kind: 'view', viewId: scope.viewId };
  const filters: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(scope.filters)) {
    if (v !== undefined) filters[k] = v.map(String);
  }
  return { kind: 'filter', filters };
}

/** YAML-ready shape for a baseline spec. Only the user-authored fields — the
 *  computed stats, current, savings and daily history are deliberately left
 *  out so a shared bundle carries definitions, not a machine's measurements. */
export function baselineSpecToYaml(spec: BaselineSpec): Record<string, unknown> {
  const basis: CostScopeConfig = {
    costMetric: spec.basis.costMetric,
    costPerspective: spec.basis.costPerspective,
    rules: spec.basis.rules,
    ...(spec.basis.marketplaceAttribution === undefined ? {} : { marketplaceAttribution: spec.basis.marketplaceAttribution }),
    ...(spec.basis.lagDays === undefined ? {} : { lagDays: spec.basis.lagDays }),
  };
  return {
    id: spec.id,
    ...(spec.name === undefined ? {} : { name: spec.name }),
    source: spec.source,
    scope: scopeToYaml(spec.scope),
    basis: costScopeToYaml(basis),
    basisSnapshotAt: spec.basisSnapshotAt,
    ...(spec.manualBand === undefined ? {} : { manualBand: manualBandToYaml(spec.manualBand) }),
    createdAt: spec.createdAt,
    updatedAt: spec.updatedAt,
  };
}

export function baselinesToYaml(specs: readonly BaselineSpec[]): { baselines: unknown[] } {
  return { baselines: specs.map(baselineSpecToYaml) };
}
