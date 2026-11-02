import { assertArray, assertNumber, assertObject, assertString, ConfigValidationError } from './validator.js';
import { asDimensionId } from '../types/branded.js';
import { logger } from '../logger/logger.js';
import type {
  CostMetric,
  CostScopeConfig,
  ExclusionCondition,
  ExclusionRule,
  MarketplaceAttributionConfig,
  MarketplaceAttributionRule,
} from '../types/cost-scope.js';
import { COST_METRICS } from '../types/cost-scope.js';
import { DEFAULT_MARKETPLACE_ATTRIBUTION } from './cost-scope-seed.js';
import { migrateLegacyDimensionId } from './legacy-renames.js';

function isCostMetric(v: string): v is CostMetric {
  return (COST_METRICS as readonly string[]).includes(v);
}

/** CUR-era metric names → FOCUS metric names. Configs written before the
 *  FOCUS 1.2 migration carry these on disk (cost-scope.yaml, and every
 *  persisted baseline basis routed through validateCostScope). `blended`
 *  predates even the CUR-era set. */
const LEGACY_METRIC_MIGRATIONS: Readonly<Record<string, CostMetric>> = {
  unblended: 'billed',
  amortized: 'effective',
  blended: 'effective',
};

export interface ValidateCostScopeOptions {
  /** The editor's preview, which shows the draft being edited: an enabled
   *  rule may hold a draft condition too (no values, no matchMissing). The
   *  query layer skips one (buildRuleMatchExpr), so the rule previews as it
   *  was before the condition was added. A save never passes it: an enabled
   *  rule saved that way would exclude more than its conditions say. */
  readonly preview?: boolean | undefined;
}

function validateCondition(
  raw: unknown,
  ctx: string,
  liveDimensionIds: ReadonlySet<string> | undefined,
  draftAllowed: boolean,
): ExclusionCondition {
  assertObject(raw, ctx);
  assertString(raw['dimensionId'], `${ctx}.dimensionId`);
  assertArray(raw['values'], `${ctx}.values`);
  const values = raw['values'].map((v, i) => {
    assertString(v, `${ctx}.values[${String(i)}]`);
    return v;
  });
  const matchMissing = raw['matchMissing'] === true;
  if (values.length === 0 && !matchMissing && !draftAllowed) {
    throw new ConfigValidationError(
      `${ctx}.values must have at least one entry unless matchMissing is true or the rule is disabled`,
    );
  }
  // Persisted rules (cost-scope.yaml and every baseline basis routed through
  // validateCostScope) may reference retired dimension ids. Without the
  // rename, the condition names a dimension the config no longer has, and
  // the whole rule matches nothing at query time (buildRuleMatchExpr): it
  // silently stops excluding.
  return {
    dimensionId: asDimensionId(migrateLegacyDimensionId(raw['dimensionId'], liveDimensionIds)),
    values,
    // Key only when set, so a condition without it stays shape-equal to the
    // seed and legacy conditions that mergeBuiltInExclusionRules compares.
    ...(matchMissing ? { matchMissing } : {}),
  };
}

function validateRule(
  raw: unknown,
  ctx: string,
  liveDimensionIds: ReadonlySet<string> | undefined,
  options: ValidateCostScopeOptions,
): ExclusionRule {
  assertObject(raw, ctx);
  assertString(raw['id'], `${ctx}.id`);
  assertString(raw['name'], `${ctx}.name`);
  assertArray(raw['conditions'], `${ctx}.conditions`);
  if (raw['conditions'].length === 0) {
    throw new ConfigValidationError(`${ctx}.conditions must have at least one entry`);
  }
  const enabled = raw['enabled'] === true;
  // A disabled rule excludes nothing, so it may keep a condition still being
  // written: the editor adds every condition with no values, and saves a
  // disabled rule as it stands.
  const draftAllowed = !enabled || options.preview === true;
  const conditions = raw['conditions'].map((c, i) =>
    validateCondition(c, `${ctx}.conditions[${String(i)}]`, liveDimensionIds, draftAllowed),
  );
  const description =
    raw['description'] === undefined
      ? undefined
      : (assertString(raw['description'], `${ctx}.description`), raw['description']);
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

/** CUR-era marketplace re-attribution targets → FOCUS ServiceName values.
 *  The `service` column now carries display names, so the old shipped
 *  default 'AmazonBedrock' (a service code, round-tripped into every
 *  persisted cost-scope.yaml by the serializer) would bucket re-attributed
 *  rows separately from first-party 'Amazon Bedrock' rows. */
const LEGACY_MARKETPLACE_SERVICE_MIGRATIONS: Readonly<Record<string, string>> = {
  AmazonBedrock: 'Amazon Bedrock',
};

function validateMarketplaceRule(raw: unknown, ctx: string): MarketplaceAttributionRule {
  assertObject(raw, ctx);
  assertString(raw['service'], `${ctx}.service`);
  if (raw['service'].length === 0) {
    throw new ConfigValidationError(`${ctx}.service must be a non-empty service code`);
  }
  let service: string = raw['service'];
  // Own-property guard: `service` comes from git-shareable config, so a key
  // like "constructor" must not surface Object.prototype members (a Function
  // here would crash sqlEscapeString in every query build).
  const migratedService = Object.hasOwn(LEGACY_MARKETPLACE_SERVICE_MIGRATIONS, service)
    ? LEGACY_MARKETPLACE_SERVICE_MIGRATIONS[service]
    : undefined;
  if (migratedService !== undefined) {
    logger.warn(`${ctx}.service was "${service}" (CUR-era service code); migrating to "${migratedService}"`);
    service = migratedService;
  }
  assertArray(raw['operations'], `${ctx}.operations`);
  const operations = raw['operations'].map((o, i) => {
    assertString(o, `${ctx}.operations[${String(i)}]`);
    return o;
  });
  if (operations.length === 0) {
    throw new ConfigValidationError(`${ctx}.operations must have at least one entry`);
  }
  return { service, operations };
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

/** `liveDimensionIds` (when the caller has the current dimensions config in
 *  scope — save handlers, sharing bundles, baselines) exempts current
 *  dimension ids from the CUR-era renames; see migrateLegacyDimensionId. */
export function validateCostScope(
  raw: unknown,
  liveDimensionIds?: ReadonlySet<string>,
  options: ValidateCostScopeOptions = {},
): CostScopeConfig {
  assertObject(raw, 'costScope');
  assertString(raw['costMetric'], 'costScope.costMetric');
  let costMetricRaw: string = raw['costMetric'];
  const migrated = Object.hasOwn(LEGACY_METRIC_MIGRATIONS, costMetricRaw)
    ? LEGACY_METRIC_MIGRATIONS[costMetricRaw]
    : undefined;
  if (migrated !== undefined) {
    logger.warn(`costScope.costMetric was "${costMetricRaw}" (CUR-era, removed); migrating to "${migrated}"`);
    costMetricRaw = migrated;
  }
  if (!isCostMetric(costMetricRaw)) {
    throw new ConfigValidationError(
      `costScope.costMetric must be one of: ${COST_METRICS.join(', ')}`,
    );
  }
  // The CUR-era `costPerspective` axis (gross/net) is gone — FOCUS has no
  // net cost columns. Tolerate and drop the key from older configs.
  if (raw['costPerspective'] !== undefined) {
    logger.warn('costScope.costPerspective is no longer supported (FOCUS has no net columns); ignoring');
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
  const rules = raw['rules'].map((r, i) => validateRule(r, `costScope.rules[${String(i)}]`, liveDimensionIds, options));
  const marketplaceAttribution = validateMarketplaceAttribution(raw['marketplaceAttribution']);
  return {
    costMetric: costMetricRaw,
    ...(lagDays === undefined ? {} : { lagDays }),
    rules,
    marketplaceAttribution,
  };
}
