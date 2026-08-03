import { asDimensionId, asTagValue } from '../types/branded.js';
import type { DimensionId, TagValue } from '../types/branded.js';
import type { BaselineCostBasis, BaselineScope, BaselineSource, BaselineSpec, ManualBand } from '../types/baseline.js';
import type { DimensionsConfig } from '../types/config.js';
import { assertArray, assertNumber, assertObject, assertString, ConfigValidationError } from './validator.js';
import { validateCostScope } from './cost-scope-validator.js';
import { migrateLegacyDimensionId } from './legacy-renames.js';

function validateScope(raw: unknown, builtInIds: ReadonlySet<string>, ctx: string): BaselineScope {
  assertObject(raw, ctx);
  if (raw['kind'] === 'view') {
    assertString(raw['viewId'], `${ctx}.viewId`);
    return { kind: 'view', viewId: raw['viewId'] };
  }
  if (raw['kind'] !== 'filter') {
    throw new ConfigValidationError(`${ctx}.kind must be 'filter' or 'view'`);
  }
  assertObject(raw['filters'], `${ctx}.filters`);
  const filters: Partial<Record<DimensionId, readonly TagValue[]>> = {};
  for (const [rawKey, arr] of Object.entries(raw['filters'])) {
    // Persisted baselines may reference CUR-era dimension ids (#515).
    const key = migrateLegacyDimensionId(rawKey);
    if (!builtInIds.has(key)) {
      throw new ConfigValidationError(
        `${ctx}.filters: "${key}" is not a built-in dimension. ` +
        `Baseline scopes may only use built-in (non-tag) dimensions — tag values churn and would report false drift.`,
      );
    }
    assertArray(arr, `${ctx}.filters.${key}`);
    const values: TagValue[] = arr.map((v, i) => {
      assertString(v, `${ctx}.filters.${key}[${String(i)}]`);
      return asTagValue(v);
    });
    filters[asDimensionId(key)] = values;
  }
  return { kind: 'filter', filters };
}

function validateManualBand(raw: unknown, ctx: string): ManualBand {
  assertObject(raw, ctx);
  assertString(raw['mode'], `${ctx}.mode`);
  if (raw['mode'] !== 'absolute' && raw['mode'] !== 'percentile') {
    throw new ConfigValidationError(`${ctx}.mode must be 'absolute' or 'percentile'`);
  }
  const lower = raw['lower'] === undefined ? undefined : (assertNumber(raw['lower'], `${ctx}.lower`), raw['lower']);
  const upper = raw['upper'] === undefined ? undefined : (assertNumber(raw['upper'], `${ctx}.upper`), raw['upper']);
  return {
    mode: raw['mode'],
    ...(lower === undefined ? {} : { lower }),
    ...(upper === undefined ? {} : { upper }),
  };
}

function validateBasis(raw: unknown): BaselineCostBasis {
  // Routed through validateCostScope so persisted bases pick up the same
  // CUR-era migrations as cost-scope.yaml (legacy metric names remapped,
  // the removed costPerspective key dropped).
  const cs = validateCostScope(raw);
  return {
    costMetric: cs.costMetric,
    rules: cs.rules,
    ...(cs.marketplaceAttribution === undefined ? {} : { marketplaceAttribution: cs.marketplaceAttribution }),
    ...(cs.lagDays === undefined ? {} : { lagDays: cs.lagDays }),
  };
}

function validateSpec(raw: unknown, builtInIds: ReadonlySet<string>, ctx: string): BaselineSpec {
  assertObject(raw, ctx);
  assertString(raw['id'], `${ctx}.id`);
  const name = raw['name'] === undefined ? undefined : (assertString(raw['name'], `${ctx}.name`), raw['name']);
  assertString(raw['source'], `${ctx}.source`);
  const source: BaselineSource = raw['source'] === 'manual' ? 'manual' : 'discovered';
  const scope = validateScope(raw['scope'], builtInIds, `${ctx}.scope`);
  const basis = validateBasis(raw['basis']);
  assertString(raw['basisSnapshotAt'], `${ctx}.basisSnapshotAt`);
  assertString(raw['createdAt'], `${ctx}.createdAt`);
  assertString(raw['updatedAt'], `${ctx}.updatedAt`);
  const manualBand = raw['manualBand'] === undefined ? undefined : validateManualBand(raw['manualBand'], `${ctx}.manualBand`);
  return {
    id: raw['id'],
    ...(name === undefined ? {} : { name }),
    source,
    scope,
    basis,
    basisSnapshotAt: raw['basisSnapshotAt'],
    ...(manualBand === undefined ? {} : { manualBand }),
    createdAt: raw['createdAt'],
    updatedAt: raw['updatedAt'],
  };
}

/** Validate a `{ baselines: [...] }` block. The `dimensions` config supplies the
 *  built-in allow-list: a scope filter keyed by a tag dimension is rejected. */
export function validateBaselines(raw: unknown, dimensions: DimensionsConfig): readonly BaselineSpec[] {
  assertObject(raw, 'baselines');
  assertArray(raw['baselines'], 'baselines.baselines');
  const builtInIds = new Set<string>(dimensions.builtIn.map((d) => String(d.name)));
  return raw['baselines'].map((b, i) => validateSpec(b, builtInIds, `baselines[${String(i)}]`));
}
