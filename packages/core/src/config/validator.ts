import { asBucketPath, asDimensionId } from '../types/branded.js';
import { isSafeColumnIdentifier } from '../query/identifier-validator.js';
import type {
  CostGoblinConfig,
  DefaultsConfig,
  DimensionsConfig,
  NormalizationRule,
  OrgNode,
  OrgTreeConfig,
  ProviderConfig,
  SyncConfig,
  SyncTierConfig,
} from '../types/config.js';

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

export function assertObject(value: unknown, context: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigValidationError(`${context} must be an object`);
  }
}

export function assertArray(value: unknown, context: string): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new ConfigValidationError(`${context} must be an array`);
  }
}

export function assertString(value: unknown, context: string): asserts value is string {
  if (typeof value !== 'string') {
    throw new ConfigValidationError(`${context} must be a string`);
  }
}

export function assertNumber(value: unknown, context: string): asserts value is number {
  if (typeof value !== 'number') {
    throw new ConfigValidationError(`${context} must be a number`);
  }
}

function isValidNormalizationRule(value: string): value is NormalizationRule {
  return value === 'lowercase' || value === 'uppercase' || value === 'lowercase-kebab' || value === 'lowercase-underscore' || value === 'camelCase';
}

function validateSyncTier(raw: unknown, context: string): SyncTierConfig {
  assertObject(raw, context);
  assertString(raw['bucket'], `${context}.bucket`);
  assertNumber(raw['retentionDays'], `${context}.retentionDays`);
  return {
    bucket: asBucketPath(raw['bucket']),
    retentionDays: raw['retentionDays'],
  };
}

function validateSync(raw: unknown): SyncConfig {
  assertObject(raw, 'sync');
  const daily = validateSyncTier(raw['daily'], 'sync.daily');
  const hourly = raw['hourly'] === undefined ? undefined : validateSyncTier(raw['hourly'], 'sync.hourly');
  const costOptimization = raw['costOptimization'] === undefined ? undefined : validateSyncTier(raw['costOptimization'], 'sync.costOptimization');
  assertNumber(raw['intervalMinutes'], 'sync.intervalMinutes');
  return {
    daily,
    ...(hourly === undefined ? {} : { hourly }),
    ...(costOptimization === undefined ? {} : { costOptimization }),
    intervalMinutes: raw['intervalMinutes'],
  };
}

function validateProvider(raw: unknown, index: number): ProviderConfig {
  const ctx = `providers[${String(index)}]`;
  assertObject(raw, ctx);
  assertString(raw['name'], `${ctx}.name`);
  assertString(raw['type'], `${ctx}.type`);
  if (raw['type'] !== 'aws') {
    throw new ConfigValidationError(`${ctx}.type must be 'aws'`);
  }
  assertObject(raw['credentials'], `${ctx}.credentials`);
  const credentials = raw['credentials'];
  assertString(credentials['profile'], `${ctx}.credentials.profile`);
  const sync = validateSync(raw['sync']);
  return {
    name: raw['name'],
    type: 'aws',
    credentials: { profile: credentials['profile'] },
    sync,
  };
}

function validateDefaults(raw: unknown): DefaultsConfig {
  assertObject(raw, 'defaults');
  assertNumber(raw['periodDays'], 'defaults.periodDays');
  assertString(raw['costMetric'], 'defaults.costMetric');
  assertNumber(raw['lagDays'], 'defaults.lagDays');
  return {
    periodDays: raw['periodDays'],
    costMetric: raw['costMetric'],
    lagDays: raw['lagDays'],
  };
}

export function validateConfig(raw: unknown): CostGoblinConfig {
  assertObject(raw, 'config');
  assertArray(raw['providers'], 'providers');
  const providers = raw['providers'].map((p, i) => validateProvider(p, i));
  const defaults = validateDefaults(raw['defaults']);
  return { providers, defaults };
}

function validateNormalize(value: unknown, ctx: string): NormalizationRule | undefined {
  if (value === undefined) return undefined;
  assertString(value, `${ctx}.normalize`);
  if (!isValidNormalizationRule(value)) {
    throw new ConfigValidationError(`${ctx}.normalize must be 'lowercase', 'uppercase', 'lowercase-kebab', 'lowercase-underscore', or 'camelCase'`);
  }
  return value;
}

function validateAliases(value: unknown, ctx: string): Record<string, string[]> | undefined {
  if (value === undefined) return undefined;
  assertObject(value, `${ctx}.aliases`);
  const result: Record<string, string[]> = {};
  for (const [key, arr] of Object.entries(value)) {
    assertArray(arr, `${ctx}.aliases.${key}`);
    result[key] = arr.map((v, j) => {
      assertString(v, `${ctx}.aliases.${key}[${String(j)}]`);
      return v;
    });
  }
  return result;
}

function validateStringArray(value: unknown, ctx: string): string[] {
  assertArray(value, ctx);
  return value.map((v, j) => {
    assertString(v, `${ctx}[${String(j)}]`);
    return v;
  });
}

/** Like `assertString`, but also rejects anything that is not a bare SQL
 *  column identifier — `field`/`displayField` are interpolated into SQL, so a
 *  shared/imported config must not be able to smuggle injection through them. */
function assertSafeColumn(value: unknown, context: string): asserts value is string {
  assertString(value, context);
  if (!isSafeColumnIdentifier(value)) {
    throw new ConfigValidationError(
      `${context} "${value}" is not a valid column identifier — only letters, digits, and underscores are allowed. ` +
      `This prevents SQL injection via shared or imported configs.`,
    );
  }
}

function validateBuiltInDimension(dim: unknown, i: number) {
  const ctx = `builtIn[${String(i)}]`;
  assertObject(dim, ctx);
  assertString(dim['name'], `${ctx}.name`);
  assertString(dim['label'], `${ctx}.label`);
  assertSafeColumn(dim['field'], `${ctx}.field`);
  const displayField = dim['displayField'] === undefined ? undefined : (assertSafeColumn(dim['displayField'], `${ctx}.displayField`), dim['displayField']);
  const enabled = dim['enabled'] === false ? false : undefined;
  const description = dim['description'] === undefined ? undefined : (assertString(dim['description'], `${ctx}.description`), dim['description']);
  const useOrgAccounts = dim['useOrgAccounts'] === true ? true : undefined;
  const accountNameFromTag = typeof dim['accountNameFromTag'] === 'string' && dim['accountNameFromTag'].length > 0
    ? dim['accountNameFromTag']
    : undefined;
  const nameStripPatterns = dim['nameStripPatterns'] === undefined
    ? undefined
    : validateStringArray(dim['nameStripPatterns'], `${ctx}.nameStripPatterns`);
  const normalize = validateNormalize(dim['normalize'], ctx);
  const aliases = validateAliases(dim['aliases'], ctx);
  const defaultFilterValues = dim['defaultFilterValues'] === undefined
    ? undefined
    : validateStringArray(dim['defaultFilterValues'], `${ctx}.defaultFilterValues`);
  return {
    name: asDimensionId(dim['name']),
    label: dim['label'],
    field: dim['field'],
    ...(displayField === undefined ? {} : { displayField }),
    ...(enabled === false ? { enabled } : {}),
    ...(description === undefined ? {} : { description }),
    ...(normalize === undefined ? {} : { normalize }),
    ...(aliases === undefined ? {} : { aliases }),
    ...(useOrgAccounts === true ? { useOrgAccounts } : {}),
    ...(accountNameFromTag === undefined ? {} : { accountNameFromTag }),
    ...(nameStripPatterns === undefined || nameStripPatterns.length === 0 ? {} : { nameStripPatterns }),
    ...(defaultFilterValues === undefined || defaultFilterValues.length === 0 ? {} : { defaultFilterValues }),
  };
}

function validateTagDimension(tag: unknown, i: number) {
  const ctx = `tags[${String(i)}]`;
  assertObject(tag, ctx);
  // tagName is optional — when omitted, the dimension is sourced purely from
  // accountTagFallback (e.g. the OU Path sentinel).
  const tagName = tag['tagName'] === undefined || tag['tagName'] === ''
    ? undefined
    : (assertString(tag['tagName'], `${ctx}.tagName`), tag['tagName']);
  assertString(tag['label'], `${ctx}.label`);

  const accountTagFallback = typeof tag['accountTagFallback'] === 'string' && tag['accountTagFallback'].length > 0
    ? tag['accountTagFallback']
    : undefined;

  if (tagName === undefined && accountTagFallback === undefined) {
    throw new ConfigValidationError(`${ctx} must set either tagName or accountTagFallback`);
  }

  const concept = tag['concept'] === undefined ? undefined : (() => {
    assertString(tag['concept'], `${ctx}.concept`);
    const validConcepts = new Set(['owner', 'product', 'environment', 'unit']);
    if (!validConcepts.has(tag['concept'])) {
      throw new ConfigValidationError(`${ctx}.concept must be 'owner', 'product', 'environment', or 'unit'`);
    }
    return tag['concept'] as 'owner' | 'product' | 'environment' | 'unit';
  })();
  const normalize = validateNormalize(tag['normalize'], ctx);
  const separator = tag['separator'] === undefined ? undefined : (assertString(tag['separator'], `${ctx}.separator`), tag['separator']);
  const aliases = validateAliases(tag['aliases'], ctx);
  const enabled = tag['enabled'] === false ? false : undefined;

  let pathSegment: { separator: string; index: number } | undefined;
  if (tag['pathSegment'] !== undefined) {
    const raw = tag['pathSegment'];
    assertObject(raw, `${ctx}.pathSegment`);
    assertString(raw['separator'], `${ctx}.pathSegment.separator`);
    assertNumber(raw['index'], `${ctx}.pathSegment.index`);
    if (raw['separator'].length === 0) {
      throw new ConfigValidationError(`${ctx}.pathSegment.separator must be non-empty`);
    }
    if (!Number.isInteger(raw['index']) || raw['index'] === 0) {
      throw new ConfigValidationError(`${ctx}.pathSegment.index must be a non-zero integer (1-based; -1 = last)`);
    }
    pathSegment = { separator: raw['separator'], index: raw['index'] };
  }

  const defaultFilterValues = tag['defaultFilterValues'] === undefined
    ? undefined
    : validateStringArray(tag['defaultFilterValues'], `${ctx}.defaultFilterValues`);

  return {
    ...(tagName === undefined ? {} : { tagName }),
    label: tag['label'],
    ...(concept === undefined ? {} : { concept }),
    ...(normalize === undefined ? {} : { normalize }),
    ...(separator === undefined ? {} : { separator }),
    ...(aliases === undefined ? {} : { aliases }),
    ...(accountTagFallback === undefined ? {} : { accountTagFallback }),
    ...(typeof tag['missingValueTemplate'] === 'string' ? { missingValueTemplate: tag['missingValueTemplate'] } : {}),
    ...(pathSegment === undefined ? {} : { pathSegment }),
    ...(enabled === false ? { enabled } : {}),
    ...(defaultFilterValues === undefined || defaultFilterValues.length === 0 ? {} : { defaultFilterValues }),
  };
}

export function validateDimensions(raw: unknown): DimensionsConfig {
  assertObject(raw, 'dimensions');
  assertArray(raw['builtIn'], 'builtIn');
  assertArray(raw['tags'], 'tags');

  const builtIn = raw['builtIn'].map((dim, i) => validateBuiltInDimension(dim, i));
  const tags = raw['tags'].map((tag, i) => validateTagDimension(tag, i));

  let order: string[] | undefined;
  if (raw['order'] !== undefined) {
    order = validateStringArray(raw['order'], 'order');
  }

  return { builtIn, tags, ...(order === undefined ? {} : { order }) };
}

function validateOrgNode(raw: unknown, path: string): OrgNode {
  assertObject(raw, path);
  assertString(raw['name'], `${path}.name`);

  const virtual = raw['virtual'] === true || undefined;
  let children: OrgNode[] | undefined;
  if (raw['children'] !== undefined) {
    assertArray(raw['children'], `${path}.children`);
    children = raw['children'].map((c, i) => validateOrgNode(c, `${path}.children[${String(i)}]`));
  }

  return {
    name: raw['name'],
    ...(virtual === undefined ? {} : { virtual }),
    ...(children === undefined ? {} : { children }),
  };
}

export function validateOrgTree(raw: unknown): OrgTreeConfig {
  assertObject(raw, 'orgTree');
  assertArray(raw['tree'], 'tree');
  const tree = raw['tree'].map((node, i) => validateOrgNode(node, `tree[${String(i)}]`));
  return { tree };
}
