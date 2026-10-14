import { OU_PATH_SOURCE_KEY } from './config.js';

type Brand<T, B extends string> = T & { readonly __brand: B };

export type DimensionId = Brand<string, 'DimensionId'>;
export type EntityRef = Brand<string, 'EntityRef'>;
export type TagValue = Brand<string, 'TagValue'>;
export type BucketPath = Brand<string, 'BucketPath'>;
export type Dollars = Brand<number, 'Dollars'>;
export type DateString = Brand<string, 'DateString'>;
export type HourString = Brand<string, 'HourString'>;
export type WorkspaceName = Brand<string, 'WorkspaceName'>;
/** A provider instance's name. Doubles as the on-disk directory segment
 *  (`{dataDir}/{providerName}/raw|rollup|meta`) and appears inside
 *  single-quoted SQL glob paths — always construct via `parseProviderName`
 *  (config/provider-name.ts) so the charset stays path- and SQL-safe. */
export type ProviderName = Brand<string, 'ProviderName'>;

export function asDimensionId(value: string): DimensionId {
  return value as DimensionId;
}

export function asEntityRef(value: string): EntityRef {
  return value as EntityRef;
}

export function asTagValue(value: string): TagValue {
  return value as TagValue;
}

export function asBucketPath(value: string): BucketPath {
  return value as BucketPath;
}

export function asDollars(value: number): Dollars {
  return value as Dollars;
}

export function asDateString(value: string): DateString {
  return value as DateString;
}

export function asHourString(value: string): HourString {
  return value as HourString;
}

export function asWorkspaceName(value: string): WorkspaceName {
  return value as WorkspaceName;
}

export function asProviderName(value: string): ProviderName {
  return value as ProviderName;
}

export function tagColumnName(tagName: string): string {
  return `tag_${tagName.replaceAll(/[^a-zA-Z0-9]/g, '_')}`;
}

interface TagColumnSource {
  readonly tagName?: string | undefined;
  readonly accountTagFallback?: string | undefined;
}

/** The key a tag dimension's id and SQL column derive from: the resource
 *  `tagName`, or for an account-only dimension its account-level source
 *  (`ou_path` for the OU Path sentinel, else `accountTagFallback`). */
export function tagSourceKey(t: TagColumnSource): string {
  if (t.tagName !== undefined && t.tagName.length > 0) return t.tagName;
  const fallback = t.accountTagFallback;
  if (fallback === OU_PATH_SOURCE_KEY) return 'ou_path';
  if (fallback !== undefined && fallback.length > 0) return fallback;
  return 'unknown';
}

/** Returns the dimension id of a tag dimension (`tag_<key>`, case kept). It is
 *  persisted in saved views, baselines, cost scopes, explorer preferences and
 *  sharing bundles, so it never changes shape. It is NOT the SQL column: use
 *  `tagSqlColumn` for anything DuckDB reads. */
export function tagDimColumn(t: TagColumnSource): string {
  return tagColumnName(tagSourceKey(t));
}

/** Returns the SQL column a tag dimension is materialized under, in the query
 *  source, the rollup Parquet and every query reading them. DuckDB matches
 *  identifiers case-insensitively, even quoted, so the case-preserving id
 *  can't double as the column: `STAGE` and `stage` tags made `tag_STAGE` and
 *  `tag_stage`, one column to DuckDB, and every query read whichever tag was
 *  declared first. Lowercasing the slug takes case out of play; the hash of
 *  the exact key keeps distinct keys (`STAGE`/`stage`, `cost-center`/
 *  `cost_center`) distinct. */
export function tagSqlColumn(t: TagColumnSource): string {
  const key = tagSourceKey(t);
  return `tag_${key.toLowerCase().replaceAll(/[^a-z0-9]/g, '_')}_${fnv1a32Hex(key)}`;
}

/** Tag dimension id → SQL column, in config order: how a consumer that speaks
 *  ids (the renderer, MCP clients) finds the column DuckDB reads. A repeated
 *  id keeps its first tag, as resolveField does. */
export function tagSqlColumnsById(tags: readonly TagColumnSource[]): ReadonlyMap<string, string> {
  const columns = new Map<string, string>();
  for (const t of tags) {
    const id = tagDimColumn(t);
    if (!columns.has(id)) columns.set(id, tagSqlColumn(t));
  }
  return columns;
}

/** A tag dimension whose id an earlier tag already has. Keys that differ only
 *  by punctuation (`cost-center`/`cost_center`), a resource tag named `ou_path`
 *  next to the OU Path dimension, or a resource tag next to an account-only
 *  dimension with the same key all produce one id. */
export interface TagIdCollision {
  readonly id: string;
  /** The first tag with this id: the one every id lookup (resolveField,
   *  tagSqlColumnsById, ...) resolves to. */
  readonly ownerIndex: number;
  /** A later tag with the same id, which no id lookup can reach: picked in a
   *  widget, it would show the owner's data. */
  readonly index: number;
}

/** Whether a tag dimension has a key to derive its id from: a resource tag or
 *  an account source. An editor draft may not have one yet (a saved config
 *  always does); its `tag_unknown` id is a placeholder, not a real id. */
export function hasTagSource(t: TagColumnSource): boolean {
  return (t.tagName !== undefined && t.tagName.length > 0)
    || (t.accountTagFallback !== undefined && t.accountTagFallback.length > 0);
}

/** Every tag whose id an earlier tag already has, in config order. Tags with
 *  no source yet are skipped: they have no id to share. */
export function findTagIdCollisions(tags: readonly TagColumnSource[]): TagIdCollision[] {
  const owners = new Map<string, number>();
  const collisions: TagIdCollision[] = [];
  tags.forEach((t, index) => {
    if (!hasTagSource(t)) return;
    const id = tagDimColumn(t);
    const ownerIndex = owners.get(id);
    if (ownerIndex === undefined) owners.set(id, index);
    else collisions.push({ id, ownerIndex, index });
  });
  return collisions;
}

/** Names the key a tag dimension's id derives from, for messages:
 *  `tag "cost-center"`, `account tag "CostCenter"` or `OU Path`. */
export function describeTagSource(t: TagColumnSource): string {
  if (t.tagName !== undefined && t.tagName.length > 0) return `tag "${t.tagName}"`;
  if (t.accountTagFallback === OU_PATH_SOURCE_KEY) return 'OU Path';
  return `account tag "${t.accountTagFallback ?? ''}"`;
}

/** FNV-1a (32-bit) over the code points, as 8 hex digits. Not cryptographic: it
 *  only has to tell tag keys apart, and it runs in the renderer bundle too, so
 *  no node:crypto. */
function fnv1a32Hex(value: string): string {
  let hash = 0x811c9dc5;
  for (const ch of value) {
    hash ^= ch.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
