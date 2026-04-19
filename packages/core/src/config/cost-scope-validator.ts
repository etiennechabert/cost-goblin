import { assertArray, assertObject, assertString, ConfigValidationError } from './validator.js';
import { asDimensionId } from '../types/branded.js';
import type {
  CostMetric,
  CostPerspective,
  CostScopeConfig,
  ExclusionCondition,
  ExclusionRule,
} from '../types/cost-scope.js';
import { COST_METRICS, COST_PERSPECTIVES } from '../types/cost-scope.js';

function isCostMetric(v: string): v is CostMetric {
  return (COST_METRICS as readonly string[]).includes(v);
}

function isCostPerspective(v: string): v is CostPerspective {
  return (COST_PERSPECTIVES as readonly string[]).includes(v);
}

function validateCondition(raw: unknown, ctx: string): ExclusionCondition {
  assertObject(raw, ctx);
  assertString(raw['dimensionId'], `${ctx}.dimensionId`);
  assertArray(raw['values'], `${ctx}.values`);
  const values = raw['values'].map((v, i) => {
    assertString(v, `${ctx}.values[${String(i)}]`);
    return v;
  });
  if (values.length === 0) {
    throw new ConfigValidationError(`${ctx}.values must have at least one entry`);
  }
  return { dimensionId: asDimensionId(raw['dimensionId']), values };
}

function validateRule(raw: unknown, ctx: string): ExclusionRule {
  assertObject(raw, ctx);
  assertString(raw['id'], `${ctx}.id`);
  assertString(raw['name'], `${ctx}.name`);
  assertArray(raw['conditions'], `${ctx}.conditions`);
  if (raw['conditions'].length === 0) {
    throw new ConfigValidationError(`${ctx}.conditions must have at least one entry`);
  }
  const conditions = raw['conditions'].map((c, i) =>
    validateCondition(c, `${ctx}.conditions[${String(i)}]`),
  );
  const description =
    raw['description'] !== undefined
      ? (assertString(raw['description'], `${ctx}.description`), raw['description'])
      : undefined;
  const enabled = raw['enabled'] === true;
  const builtIn = raw['builtIn'] === true;
  return {
    id: raw['id'],
    name: raw['name'],
    ...(description !== undefined ? { description } : {}),
    enabled,
    builtIn,
    conditions,
  };
}

export function validateCostScope(raw: unknown): CostScopeConfig {
  assertObject(raw, 'costScope');
  assertString(raw['costMetric'], 'costScope.costMetric');
  if (!isCostMetric(raw['costMetric'])) {
    throw new ConfigValidationError(
      `costScope.costMetric must be one of: ${COST_METRICS.join(', ')}`,
    );
  }
  // costPerspective is optional — missing key defaults to 'gross' so older
  // on-disk configs keep working unchanged.
  let costPerspective: CostPerspective | undefined;
  if (raw['costPerspective'] !== undefined) {
    assertString(raw['costPerspective'], 'costScope.costPerspective');
    if (!isCostPerspective(raw['costPerspective'])) {
      throw new ConfigValidationError(
        `costScope.costPerspective must be one of: ${COST_PERSPECTIVES.join(', ')}`,
      );
    }
    costPerspective = raw['costPerspective'];
  }
  assertArray(raw['rules'], 'costScope.rules');
  const rules = raw['rules'].map((r, i) => validateRule(r, `costScope.rules[${String(i)}]`));
  return {
    costMetric: raw['costMetric'],
    ...(costPerspective !== undefined ? { costPerspective } : {}),
    rules,
  };
}
