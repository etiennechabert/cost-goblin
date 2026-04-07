import { asBucketPath, asDimensionId } from '../types/branded.js';
import type {
  CacheConfig,
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

function assertObject(value: unknown, context: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigValidationError(`${context} must be an object`);
  }
}

function assertArray(value: unknown, context: string): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new ConfigValidationError(`${context} must be an array`);
  }
}

function assertString(value: unknown, context: string): asserts value is string {
  if (typeof value !== 'string') {
    throw new ConfigValidationError(`${context} must be a string`);
  }
}

function assertNumber(value: unknown, context: string): asserts value is number {
  if (typeof value !== 'number') {
    throw new ConfigValidationError(`${context} must be a number`);
  }
}

function isValidNormalizationRule(value: string): value is NormalizationRule {
  return value === 'lowercase' || value === 'uppercase' || value === 'lowercase-kebab';
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
  const hourly = raw['hourly'] !== undefined ? validateSyncTier(raw['hourly'], 'sync.hourly') : undefined;
  assertNumber(raw['intervalMinutes'], 'sync.intervalMinutes');
  return {
    daily,
    ...(hourly !== undefined ? { hourly } : {}),
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

function validateCache(raw: unknown): CacheConfig {
  assertObject(raw, 'cache');
  assertNumber(raw['ttlMinutes'], 'cache.ttlMinutes');
  return { ttlMinutes: raw['ttlMinutes'] };
}

export function validateConfig(raw: unknown): CostGoblinConfig {
  assertObject(raw, 'config');
  assertArray(raw['providers'], 'providers');
  const providers = raw['providers'].map((p, i) => validateProvider(p, i));
  const defaults = validateDefaults(raw['defaults']);
  const cache = validateCache(raw['cache']);
  return { providers, defaults, cache };
}

export function validateDimensions(raw: unknown): DimensionsConfig {
  assertObject(raw, 'dimensions');
  assertArray(raw['builtIn'], 'builtIn');
  assertArray(raw['tags'], 'tags');

  const builtIn = raw['builtIn'].map((dim, i) => {
    const ctx = `builtIn[${String(i)}]`;
    assertObject(dim, ctx);
    assertString(dim['name'], `${ctx}.name`);
    assertString(dim['label'], `${ctx}.label`);
    assertString(dim['field'], `${ctx}.field`);
    const displayField = dim['displayField'] !== undefined ? (assertString(dim['displayField'], `${ctx}.displayField`), dim['displayField']) : undefined;
    return {
      name: asDimensionId(dim['name']),
      label: dim['label'],
      field: dim['field'],
      ...(displayField !== undefined ? { displayField } : {}),
    };
  });

  const tags = raw['tags'].map((tag, i) => {
    const ctx = `tags[${String(i)}]`;
    assertObject(tag, ctx);
    assertString(tag['tagName'], `${ctx}.tagName`);
    assertString(tag['label'], `${ctx}.label`);

    const concept = tag['concept'] !== undefined ? (assertString(tag['concept'], `${ctx}.concept`), tag['concept'] as 'owner' | 'product' | 'environment') : undefined;
    const normalize = tag['normalize'] !== undefined ? (() => {
      assertString(tag['normalize'], `${ctx}.normalize`);
      if (!isValidNormalizationRule(tag['normalize'])) {
        throw new ConfigValidationError(`${ctx}.normalize must be 'lowercase', 'uppercase', or 'lowercase-kebab'`);
      }
      return tag['normalize'];
    })() : undefined;
    const separator = tag['separator'] !== undefined ? (assertString(tag['separator'], `${ctx}.separator`), tag['separator']) : undefined;

    let aliases: Record<string, string[]> | undefined;
    if (tag['aliases'] !== undefined) {
      assertObject(tag['aliases'], `${ctx}.aliases`);
      const aliasObj = tag['aliases'];
      aliases = {};
      for (const [key, value] of Object.entries(aliasObj)) {
        assertArray(value, `${ctx}.aliases.${key}`);
        const arr = value;
        aliases[key] = arr.map((v, j) => {
          assertString(v, `${ctx}.aliases.${key}[${String(j)}]`);
          return v;
        });
      }
    }

    return {
      tagName: tag['tagName'],
      label: tag['label'],
      ...(concept !== undefined ? { concept } : {}),
      ...(normalize !== undefined ? { normalize } : {}),
      ...(separator !== undefined ? { separator } : {}),
      ...(aliases !== undefined ? { aliases } : {}),
    };
  });

  return { builtIn, tags };
}

function validateOrgNode(raw: unknown, path: string): OrgNode {
  assertObject(raw, path);
  assertString(raw['name'], `${path}.name`);

  const virtual = raw['virtual'] === true ? true : undefined;
  let children: OrgNode[] | undefined;
  if (raw['children'] !== undefined) {
    assertArray(raw['children'], `${path}.children`);
    children = raw['children'].map((c, i) => validateOrgNode(c, `${path}.children[${String(i)}]`));
  }

  return {
    name: raw['name'],
    ...(virtual !== undefined ? { virtual } : {}),
    ...(children !== undefined ? { children } : {}),
  };
}

export function validateOrgTree(raw: unknown): OrgTreeConfig {
  assertObject(raw, 'orgTree');
  assertArray(raw['tree'], 'tree');
  const tree = raw['tree'].map((node, i) => validateOrgNode(node, `tree[${String(i)}]`));
  return { tree };
}
