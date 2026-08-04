import { asBucketPath, asDimensionId } from '../types/branded.js';
import type { BucketPath } from '../types/branded.js';
import { isSafeColumnIdentifier } from '../query/identifier-validator.js';
import { parseProviderName } from './provider-name.js';
import { logger } from '../logger/logger.js';
import type {
  ConceptType,
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

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** The sync bucket is interpolated into an `aws s3 sync` source argument
 *  (`s3://<bucket>/<prefix>`), spawned via an argv array (no shell) and always
 *  carrying the `s3://` scheme — so the value can't act as a shell injection or
 *  a leading-dash flag. We therefore reject only genuinely malformed input: an
 *  empty value, a leading dash, `..` traversal, or control characters (which
 *  would corrupt logs / the argument). S3 keys legitimately contain `=`, `+`,
 *  `:`, spaces, etc. (e.g. Hive partition dirs like `billing_period=…`), so
 *  the key charset is intentionally left unrestricted — over-restricting it
 *  would reject valid existing configs on load. */
function validateBucketPath(raw: unknown, context: string): BucketPath {
  assertString(raw, context);
  if (raw.length === 0 || raw.startsWith('-') || raw.includes('..') || hasControlChar(raw)) {
    throw new ConfigValidationError(`${context} is not a valid S3 bucket location`);
  }
  return asBucketPath(raw);
}

function validateSyncTier(raw: unknown, context: string): SyncTierConfig {
  assertObject(raw, context);
  const bucket = validateBucketPath(raw['bucket'], `${context}.bucket`);
  assertNumber(raw['retentionDays'], `${context}.retentionDays`);
  return {
    bucket,
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

/** The AWS credentials profile, from the current flattened field or the
 *  legacy nested `credentials: { profile }` shape (pre-#516 configs and
 *  bundles still on disk) — read both, emit only `credentialsProfile`. */
function resolveCredentialsProfile(raw: Record<string, unknown>, ctx: string): string {
  if (raw['credentialsProfile'] !== undefined) {
    assertString(raw['credentialsProfile'], `${ctx}.credentialsProfile`);
    return raw['credentialsProfile'];
  }
  assertObject(raw['credentials'], `${ctx}.credentialsProfile`);
  const credentials = raw['credentials'];
  assertString(credentials['profile'], `${ctx}.credentials.profile`);
  return credentials['profile'];
}

function validateProvider(raw: unknown, index: number): ProviderConfig {
  const ctx = `providers[${String(index)}]`;
  assertObject(raw, ctx);
  assertString(raw['name'], `${ctx}.name`);
  let name;
  try {
    name = parseProviderName(raw['name']);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ConfigValidationError(`${ctx}.name: ${message}`);
  }
  assertString(raw['type'], `${ctx}.type`);
  if (raw['type'] !== 'aws') {
    throw new ConfigValidationError(`${ctx}.type must be 'aws'`);
  }
  const credentialsProfile = resolveCredentialsProfile(raw, ctx);
  const sync = validateSync(raw['sync']);
  return {
    name,
    type: 'aws',
    credentialsProfile,
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
  // Case-insensitive uniqueness: the name becomes a directory and most
  // desktop filesystems are case-insensitive, so 'Payer-A' and 'payer-a'
  // would collide on disk.
  const seen = new Map<string, string>();
  for (const p of providers) {
    const key = p.name.toLowerCase();
    const existing = seen.get(key);
    if (existing !== undefined) {
      throw new ConfigValidationError(
        `providers: duplicate name "${p.name}" (conflicts with "${existing}" — names are case-insensitive)`,
      );
    }
    seen.set(key, p.name);
  }
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
    // Drop empty entries rather than reject: they're semantic no-ops the UI
    // editor already discards on save, but hand-edited YAML and shared
    // bundles can contain them — and downstream SQL generation must never
    // see an alias entry with no values (invalid `IN ()`).
    if (arr.length === 0) continue;
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

/** Optional string field: undefined when absent, else asserted to a string. */
function optionalString(value: unknown, context: string): string | undefined {
  if (value === undefined) return undefined;
  assertString(value, context);
  return value;
}

/** Optional bare-SQL-column field: undefined when absent, else asserted safe. */
function optionalSafeColumn(value: unknown, context: string): string | undefined {
  if (value === undefined) return undefined;
  assertSafeColumn(value, context);
  return value;
}

/** Optional non-empty string field: undefined when absent or empty. */
function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Optional string-array field: undefined when absent, else validated. */
function optionalStringArray(value: unknown, context: string): string[] | undefined {
  return value === undefined ? undefined : validateStringArray(value, context);
}

function validateBuiltInDimension(dim: unknown, i: number) {
  const ctx = `builtIn[${String(i)}]`;
  assertObject(dim, ctx);
  assertString(dim['name'], `${ctx}.name`);
  assertString(dim['label'], `${ctx}.label`);
  assertSafeColumn(dim['field'], `${ctx}.field`);
  const displayField = optionalSafeColumn(dim['displayField'], `${ctx}.displayField`);
  const enabled = dim['enabled'] === false ? false : undefined;
  const description = optionalString(dim['description'], `${ctx}.description`);
  const useOrgAccounts = dim['useOrgAccounts'] === true ? true : undefined;
  const accountNameFromTag = optionalNonEmptyString(dim['accountNameFromTag']);
  const nameStripPatterns = optionalStringArray(dim['nameStripPatterns'], `${ctx}.nameStripPatterns`);
  const normalize = validateNormalize(dim['normalize'], ctx);
  const aliases = validateAliases(dim['aliases'], ctx);
  const defaultFilterValues = optionalStringArray(dim['defaultFilterValues'], `${ctx}.defaultFilterValues`);
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

function isConceptType(value: string): value is ConceptType {
  return value === 'owner' || value === 'product' || value === 'environment' || value === 'unit';
}

function validateConcept(value: unknown, ctx: string): ConceptType | undefined {
  if (value === undefined) return undefined;
  assertString(value, `${ctx}.concept`);
  if (!isConceptType(value)) {
    throw new ConfigValidationError(`${ctx}.concept must be 'owner', 'product', 'environment', or 'unit'`);
  }
  return value;
}

function validatePathSegment(value: unknown, ctx: string): { separator: string; index: number } | undefined {
  if (value === undefined) return undefined;
  assertObject(value, `${ctx}.pathSegment`);
  assertString(value['separator'], `${ctx}.pathSegment.separator`);
  assertNumber(value['index'], `${ctx}.pathSegment.index`);
  if (value['separator'].length === 0) {
    throw new ConfigValidationError(`${ctx}.pathSegment.separator must be non-empty`);
  }
  if (!Number.isInteger(value['index']) || value['index'] === 0) {
    throw new ConfigValidationError(`${ctx}.pathSegment.index must be a non-zero integer (1-based; -1 = last)`);
  }
  return { separator: value['separator'], index: value['index'] };
}

function validateTagDimension(tag: unknown, i: number) {
  const ctx = `tags[${String(i)}]`;
  assertObject(tag, ctx);
  // tagName is optional — when omitted, the dimension is sourced purely from
  // accountTagFallback (e.g. the OU Path sentinel).
  let tagName = tag['tagName'] === undefined || tag['tagName'] === ''
    ? undefined
    : (assertString(tag['tagName'], `${ctx}.tagName`), tag['tagName']);
  // CUR-era resource_tags keys carried a `user_` prefix and older configs
  // persist it (tag discovery stored the raw key verbatim). FOCUS `Tags` map
  // keys have no prefix, so a prefixed tagName would silently match nothing —
  // migrate it at load time, mirroring the legacy cost-metric migration.
  if (tagName !== undefined && tagName.startsWith('user_')) {
    const stripped = tagName.slice('user_'.length);
    if (stripped.length > 0) {
      logger.warn(`${ctx}.tagName "${tagName}" carries the CUR-era user_ prefix; migrating to "${stripped}"`);
      tagName = stripped;
    }
  }
  assertString(tag['label'], `${ctx}.label`);

  const accountTagFallback = optionalNonEmptyString(tag['accountTagFallback']);

  if (tagName === undefined && accountTagFallback === undefined) {
    throw new ConfigValidationError(`${ctx} must set either tagName or accountTagFallback`);
  }

  const concept = validateConcept(tag['concept'], ctx);
  const normalize = validateNormalize(tag['normalize'], ctx);
  const separator = optionalString(tag['separator'], `${ctx}.separator`);
  const aliases = validateAliases(tag['aliases'], ctx);
  const enabled = tag['enabled'] === false ? false : undefined;
  const pathSegment = validatePathSegment(tag['pathSegment'], ctx);
  const defaultFilterValues = optionalStringArray(tag['defaultFilterValues'], `${ctx}.defaultFilterValues`);

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
