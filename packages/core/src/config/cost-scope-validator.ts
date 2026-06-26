import { assertArray, assertNumber, assertObject, assertString, ConfigValidationError } from './validator.js';
import { asDimensionId } from '../types/branded.js';
import { logger } from '../logger/logger.js';
import type {
  CostMetric,
  CostPerspective,
  CostScopeConfig,
  ExclusionCondition,
  ExclusionRule,
  MarketplaceAttributionConfig,
  MarketplaceAttributionRule,
} from '../types/cost-scope.js';
import { COST_METRICS, COST_PERSPECTIVES } from '../types/cost-scope.js';
import { DEFAULT_MARKETPLACE_ATTRIBUTION } from './cost-scope-seed.js';

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
    raw['description'] === undefined
      ? undefined
      : (assertString(raw['description'], `${ctx}.description`), raw['description']);
  const enabled = raw['enabled'] === true;
  const builtIn = raw['builtIn'] === true;
  return {
    id: raw['id'],
    name: raw['name'],
    ...(description === undefined ? {} : { description }),
    enabled,
    builtIn,
    conditions,
  };
}

function validateMarketplaceRule(raw: unknown, ctx: string): MarketplaceAttributionRule {
  assertObject(raw, ctx);
  assertString(raw['service'], `${ctx}.service`);
  if (raw['service'].length === 0) {
    throw new ConfigValidationError(`${ctx}.service must be a non-empty service code`);
  }
  assertArray(raw['operations'], `${ctx}.operations`);
  const operations = raw['operations'].map((o, i) => {
    assertString(o, `${ctx}.operations[${String(i)}]`);
    return o;
  });
  if (operations.length === 0) {
    throw new ConfigValidationError(`${ctx}.operations must have at least one entry`);
  }
  return { service: raw['service'], operations };
}

/** Parse the optional `marketplaceAttribution` block. Absent → the shipped
 *  default (enabled), so existing on-disk configs adopt the fix automatically;
 *  pass an explicit `{ enabled: false }` to opt out. */
function validateMarketplaceAttribution(raw: unknown): MarketplaceAttributionConfig {
  if (raw === undefined) return DEFAULT_MARKETPLACE_ATTRIBUTION;
  assertObject(raw, 'costScope.marketplaceAttribution');
  const enabled = raw['enabled'] === true;
  assertArray(raw['rules'], 'costScope.marketplaceAttribution.rules');
  const rules = raw['rules'].map((r, i) =>
    validateMarketplaceRule(r, `costScope.marketplaceAttribution.rules[${String(i)}]`),
  );
  return { enabled, rules };
}

export function validateCostScope(raw: unknown): CostScopeConfig {
  assertObject(raw, 'costScope');
  assertString(raw['costMetric'], 'costScope.costMetric');
  // 'blended' was removed: AWS never extended blended math to Savings Plans,
  // so on SP-based fleets it barely differs from unblended and provides none
  // of the chargeback fairness it was originally designed for. Silently
  // migrate legacy configs to 'amortized' (the recommended chargeback metric).
  let costMetricRaw: string = raw['costMetric'];
  if (costMetricRaw === 'blended') {
    logger.warn('costScope.costMetric was "blended" (removed); migrating to "amortized"');
    costMetricRaw = 'amortized';
  }
  if (!isCostMetric(costMetricRaw)) {
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
  let lagDays: number | undefined;
  if (raw['lagDays'] !== undefined) {
    assertNumber(raw['lagDays'], 'costScope.lagDays');
    if (raw['lagDays'] < 0 || !Number.isInteger(raw['lagDays'])) {
      throw new ConfigValidationError('costScope.lagDays must be a non-negative integer');
    }
    lagDays = raw['lagDays'];
  }

  assertArray(raw['rules'], 'costScope.rules');
  const rules = raw['rules'].map((r, i) => validateRule(r, `costScope.rules[${String(i)}]`));
  const marketplaceAttribution = validateMarketplaceAttribution(raw['marketplaceAttribution']);
  return {
    costMetric: costMetricRaw,
    ...(costPerspective === undefined ? {} : { costPerspective }),
    ...(lagDays === undefined ? {} : { lagDays }),
    rules,
    marketplaceAttribution,
  };
}
