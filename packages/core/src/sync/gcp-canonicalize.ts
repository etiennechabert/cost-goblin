import { mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { logger } from '../logger/logger.js';
import { isSafeColumnIdentifier } from '../query/identifier-validator.js';
import { REQUIRED_FOCUS_COLUMNS } from './focus-contract.js';

/** BigQuery physically cannot emit the Parquet `MAP` that the query layer's
 *  `element_at(Tags, '<key>')` extraction needs, and the export carries none
 *  of the AWS extension columns the contract lists. So a GCP period is
 *  rewritten locally, once, on the way into `raw/daily-YYYY-MM/`.
 *
 *  The rewrite is schema-adaptive rather than a fixed projection: the FOCUS
 *  BigQuery export is in Preview and its column set is still moving, and the
 *  export recipe deliberately ships `SELECT *` so users never maintain
 *  mapping SQL. Every column the export carries is passed through unchanged;
 *  only the columns the contract constrains are normalized.
 *
 *  What it guarantees about its output:
 *    - all `REQUIRED_FOCUS_COLUMNS` are physically present (`union_by_name`
 *      NULL-fills a column missing from *some* file in a glob, but a column
 *      missing from *every* file is still a binder error at query time)
 *    - `Tags` is `MAP(VARCHAR, VARCHAR)`
 *    - the four cost columns and `ConsumedQuantity` are `DOUBLE`
 *    - `ChargePeriodStart` is a naive UTC `TIMESTAMP` */

export class GcpCanonicalizeError extends Error {
  readonly missingColumns: readonly string[];

  constructor(message: string, missingColumns: readonly string[] = []) {
    super(message);
    this.name = 'GcpCanonicalizeError';
    this.missingColumns = missingColumns;
  }
}

/** Source columns with no defensible synthesis. Everything else the contract
 *  asks for is either derivable (`x_ServiceCode` from `x_ServiceId`) or
 *  honestly NULL (`x_Operation`, which is an AWS concept). A period missing
 *  one of these is not a FOCUS export and must fail loudly rather than
 *  produce a file that queries as all-zero. */
const REQUIRED_SOURCE_COLUMNS: readonly string[] = [
  'ChargePeriodStart',
  'SubAccountId',
  'BilledCost',
  'EffectiveCost',
  'ServiceName',
  'ChargeCategory',
];

/** Contract columns whose values must be numeric for the cost expressions
 *  and the cross-provider union. BigQuery emits NUMERIC (Parquet DECIMAL);
 *  DOUBLE matches what the AWS export delivers and what `buildSource`
 *  aggregates. */
const DOUBLE_COLUMNS: readonly string[] = [
  'BilledCost', 'EffectiveCost', 'ListCost', 'ContractedCost', 'ConsumedQuantity',
];

/** Contract columns the query layer treats as strings. Cast explicitly: a
 *  column that is entirely NULL in one month's export can come back with a
 *  non-VARCHAR physical type, which would then fight the other months in a
 *  `union_by_name` read. */
const VARCHAR_COLUMNS: readonly string[] = [
  'SubAccountId', 'SubAccountName', 'ServiceName', 'ServiceCategory', 'RegionId',
  'ResourceId', 'ChargeCategory', 'PricingCategory', 'CommitmentDiscountStatus',
  'ChargeDescription',
];

/** Repeated `STRUCT<Key, Value, …>` fields that hold tags/labels, in
 *  precedence order: on a key collision the earlier source wins, so the list
 *  runs most-specific to broadest.
 *
 *  The GCP export calls its resource tags **`x_Tags`**, not the FOCUS-standard
 *  `Tags` — verified against a live export's schema, which has 55 columns and
 *  no `Tags` at all. Reading only `Tags` silently produced an empty tag map
 *  for every resource tag, with no error anywhere: exactly the failure this
 *  whole canonicalization step exists to prevent. `Tags` stays in the list for
 *  the day the export adopts the standard name; absent columns are skipped, so
 *  carrying both costs nothing.
 *
 *  `x_SystemLabels` is deliberately NOT here. Those are GCP-generated (machine
 *  spec, instance metadata), not cost-allocation tags, and merging them would
 *  bury the user's own keys in the dimension picker. */
const TAG_SOURCE_COLUMNS: readonly string[] = ['x_Tags', 'Tags', 'x_Labels', 'x_ProjectLabels'];

/** Source-only columns consumed to synthesize contract columns. They are not
 *  passed through — carrying both `x_ServiceId` and the `x_ServiceCode`
 *  derived from it would just be two names for one value. */
const CONSUMED_SOURCE_COLUMNS: ReadonlySet<string> = new Set([...TAG_SOURCE_COLUMNS, 'x_ServiceId', 'SkuId']);

// ---------------------------------------------------------------------------
// DuckDB surface — the narrowest slice this module uses, so tests can hand in
// a live connection and the module never depends on the driver's full types.
// ---------------------------------------------------------------------------

export interface CanonicalizeChunk {
  readonly rowCount: number;
  getColumnVector(index: number): { getItem(row: number): unknown };
}

export interface CanonicalizeResultSet {
  readonly columnCount: number;
  fetchChunk(): Promise<CanonicalizeChunk | null>;
}

export interface CanonicalizeConnection {
  run(sql: string): Promise<CanonicalizeResultSet>;
}

export interface CanonicalizeOptions {
  /** Directory holding the period's raw export shards (`*.parquet`). */
  readonly stagingDir: string;
  /** File to write. Its parent directory is created if needed. */
  readonly outputPath: string;
  /** Reuse an open connection instead of creating an instance. Tests pass one;
   *  the sync path lets the module manage its own. */
  readonly connection?: CanonicalizeConnection | undefined;
  /** Instance memory cap. The sync worker's instance coexists with the query
   *  worker's, and DuckDB's default sizes for being the only one on the box. */
  readonly memoryGB?: number | undefined;
  readonly threads?: number | undefined;
}

export interface CanonicalizeResult {
  readonly rows: number;
  /** Contract columns that were not in the source and had to be synthesized
   *  or NULL-filled. Surfaced for the sync log — on a real export this should
   *  be exactly the AWS extension columns. */
  readonly synthesizedColumns: readonly string[];
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Read back the column names and types DuckDB sees across every shard.
 *  `union_by_name` makes this the union of all shards' columns, so a
 *  header-only shard (a zero-row export still writes one file) contributes
 *  its schema without contributing rows. */
async function describeSource(conn: CanonicalizeConnection, sourceExpr: string): Promise<Map<string, string>> {
  const result = await conn.run(`DESCRIBE SELECT * FROM ${sourceExpr}`);
  const columns = new Map<string, string>();
  for (;;) {
    const chunk = await result.fetchChunk();
    if (chunk === null || chunk.rowCount === 0) break;
    const names = chunk.getColumnVector(0);
    const types = chunk.getColumnVector(1);
    for (let row = 0; row < chunk.rowCount; row++) {
      const name = names.getItem(row);
      const type = types.getItem(row);
      if (typeof name === 'string') {
        columns.set(name, typeof type === 'string' ? type : '');
      }
    }
  }
  return columns;
}

async function readSingleNumber(conn: CanonicalizeConnection, sql: string): Promise<number> {
  const result = await conn.run(sql);
  const chunk = await result.fetchChunk();
  if (chunk === null || chunk.rowCount === 0) return 0;
  const value = chunk.getColumnVector(0).getItem(0);
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return 0;
}

/** Normalize `ChargePeriodStart` to a naive UTC `TIMESTAMP`.
 *
 *  This is load-bearing, not cosmetic. BigQuery writes TIMESTAMP with
 *  `isAdjustedToUTC=1`, which DuckDB reads back as `TIMESTAMP WITH TIME
 *  ZONE`; `::DATE` on that resolves in the *session* timezone, so a
 *  `2026-01-31 23:30 UTC` row becomes `2026-02-01` for anyone east of
 *  Greenwich — silently moving spend across a month boundary in both
 *  `usage_date` and the period-directory layout.
 *
 *  The conversion must be chosen from the observed type: applying
 *  `AT TIME ZONE 'UTC'` to an *already naive* TIMESTAMP shifts it the other
 *  way by the session offset, introducing the very bug it prevents. */
function timestampExpr(column: string, sourceType: string): string {
  const ident = quoteIdent(column);
  return sourceType.toUpperCase().includes('WITH TIME ZONE')
    ? `CAST(${ident} AT TIME ZONE 'UTC' AS TIMESTAMP)`
    : `CAST(${ident} AS TIMESTAMP)`;
}

/** One flat `STRUCT(k, v)[]` merging every tag/label field the export
 *  carries, in `TAG_SOURCE_COLUMNS` precedence order. Each field is
 *  normalized to the same struct shape before concatenation — the GCP label
 *  fields need not have identical struct members to `Tags`. A NULL list
 *  becomes an empty one so a row with no tags still yields an empty MAP
 *  rather than a NULL. */
function tagEntriesExpr(present: readonly string[]): string {
  const parts = present.map(col =>
    `COALESCE(list_transform(${quoteIdent(col)}, t -> struct_pack(k := t."Key", v := t."Value")), CAST([] AS STRUCT(k VARCHAR, v VARCHAR)[]))`,
  );
  if (parts.length === 0) return `CAST([] AS STRUCT(k VARCHAR, v VARCHAR)[])`;
  if (parts.length === 1) return parts[0] ?? `CAST([] AS STRUCT(k VARCHAR, v VARCHAR)[])`;
  return `list_concat(${parts.join(', ')})`;
}

/** Google reserves the `goog-` label prefix for keys it generates itself.
 *
 *  Excluding `x_SystemLabels` wholesale is not enough: a live export puts
 *  `goog-resource-type` in **`x_Labels`**, the same column that carries the
 *  user's own labels — 20 of 60 rows in the first real export observed, next
 *  to a genuine `purpose` label on 9. Without this filter every GCP workspace
 *  gets a Google-generated key sitting in the dimension picker above the
 *  user's own, which is the outcome the `x_SystemLabels` exclusion already
 *  exists to prevent. */
const RESERVED_TAG_PREFIX = 'goog-';

/** Fold the merged entry list into a `MAP(VARCHAR, VARCHAR)`.
 *
 *  `map_from_entries` throws `Invalid Input Error` — failing the whole
 *  period's COPY — on a duplicate or NULL key, and real exports produce
 *  both: the same name can appear as a resource tag and a project label, and
 *  a malformed label can carry a NULL key. So keys are de-duplicated and
 *  NULL-filtered first, and each surviving key takes the value of its first
 *  occurrence, which is what makes `TAG_SOURCE_COLUMNS` order a precedence
 *  rule. Quadratic in tags-per-row, which is fine at the handful of tags a
 *  billing row actually carries. */
const TAGS_EXPR = `map_from_entries(list_transform(
      list_distinct(list_transform(list_filter(__tag_entries, e -> e.k IS NOT NULL AND NOT starts_with(e.k, ${quoteLiteral(RESERVED_TAG_PREFIX)})), e -> e.k)),
      k -> struct_pack(k := k, v := list_filter(__tag_entries, e -> e.k = k)[1].v)))`;

interface Projection {
  readonly selectList: readonly string[];
  readonly synthesized: readonly string[];
}

function buildProjection(source: ReadonlyMap<string, string>): Projection {
  const has = (col: string): boolean => source.has(col);
  const selects: string[] = [];
  const synthesized: string[] = [];
  const emitted = new Set<string>();

  const emit = (name: string, expr: string): void => {
    selects.push(`${expr} AS ${quoteIdent(name)}`);
    emitted.add(name);
  };

  // --- contract columns, normalized -------------------------------------
  const chargePeriodType = source.get('ChargePeriodStart') ?? '';
  emit('ChargePeriodStart', timestampExpr('ChargePeriodStart', chargePeriodType));

  for (const col of VARCHAR_COLUMNS) {
    if (has(col)) {
      emit(col, `CAST(${quoteIdent(col)} AS VARCHAR)`);
    } else {
      synthesized.push(col);
      // SubAccountName is the one string column with a better answer than
      // NULL: the id is always present and reads far better in a group-by.
      emit(col, col === 'SubAccountName' && has('SubAccountId')
        ? `CAST("SubAccountId" AS VARCHAR)`
        : `CAST(NULL AS VARCHAR)`);
    }
  }

  for (const col of DOUBLE_COLUMNS) {
    if (has(col)) {
      emit(col, `CAST(${quoteIdent(col)} AS DOUBLE)`);
    } else {
      synthesized.push(col);
      emit(col, `CAST(NULL AS DOUBLE)`);
    }
  }

  // --- contract columns with no GCP source -------------------------------
  // `x_ServiceCode` is the AWS service code the marketplace re-attribution
  // and the service dimension key off; the GCP service id plays the same
  // role, with the display name as a last resort.
  synthesized.push('x_ServiceCode');
  emit('x_ServiceCode', has('x_ServiceId')
    ? `CAST(COALESCE("x_ServiceId", "ServiceName") AS VARCHAR)`
    : `CAST("ServiceName" AS VARCHAR)`);

  // Purely an AWS concept (the CUR operation). Materialized as NULL rather
  // than omitted: a column absent from every file in a provider's glob is a
  // binder error, not a NULL fill.
  synthesized.push('x_Operation');
  emit('x_Operation', `CAST(NULL AS VARCHAR)`);

  if (has('SkuMeter')) {
    emit('SkuMeter', has('SkuId')
      ? `CAST(COALESCE("SkuMeter", "SkuId") AS VARCHAR)`
      : `CAST("SkuMeter" AS VARCHAR)`);
  } else {
    synthesized.push('SkuMeter');
    emit('SkuMeter', has('SkuId') ? `CAST("SkuId" AS VARCHAR)` : `CAST(NULL AS VARCHAR)`);
  }

  const tagSources = TAG_SOURCE_COLUMNS.filter(has);
  if (tagSources.length === 0) synthesized.push('Tags');
  emit('Tags', TAGS_EXPR);

  // --- everything else the export carries, passed through ----------------
  // Keeps the recipe's `SELECT *` honest: preview-era schema additions reach
  // the local archive even though nothing queries them yet.
  for (const [name] of source) {
    if (emitted.has(name) || CONSUMED_SOURCE_COLUMNS.has(name)) continue;
    if (!isSafeColumnIdentifier(name)) {
      logger.warn(`Dropping GCP export column with an unsafe name: ${name}`);
      continue;
    }
    selects.push(quoteIdent(name));
  }

  return { selectList: selects, synthesized };
}

/**
 * Rewrite one period's raw BigQuery-export shards into a single
 * contract-valid FOCUS 1.2 Parquet file.
 *
 * Throws `GcpCanonicalizeError` when the source can't be a FOCUS export
 * (no shards, or a required column missing from all of them) — the caller
 * turns that into a classified sync failure and leaves `raw/` untouched.
 */
export async function canonicalizeGcpPeriod(options: CanonicalizeOptions): Promise<CanonicalizeResult> {
  // A caller-supplied connection belongs to the caller; one we create is ours
  // to close. A DuckDB instance is a native engine with its own buffer pool,
  // and a first sync of two years calls this once per period — leaving each
  // one open grows the sync worker's native memory monotonically.
  if (options.connection !== undefined) {
    return canonicalizeWithConnection(options.connection, options);
  }
  const owned = await createOwnConnection(options);
  try {
    return await canonicalizeWithConnection(owned.connection, options);
  } finally {
    owned.close();
  }
}

async function canonicalizeWithConnection(
  conn: CanonicalizeConnection,
  options: CanonicalizeOptions,
): Promise<CanonicalizeResult> {
  // An EXPLICIT file list, never a `dir/*.parquet` glob. DuckDB reads `[`,
  // `]`, `?` and `*` in a path as glob syntax, and this path is built from the
  // user's data directory — a folder called `CostGoblin [beta]` made `[beta]`
  // a character class, so the read matched nothing and every period failed
  // with "Could not read the downloaded export" AFTER its bytes had been
  // downloaded. Backslash escaping does not help; listing the files does, and
  // it also makes the empty-directory case an explicit error rather than an
  // opaque IO one.
  const shards = (await readdir(options.stagingDir).catch(() => [] as string[]))
    .filter(f => f.endsWith('.parquet'))
    .sort((a, b) => a.localeCompare(b))
    .map(f => join(options.stagingDir, f));
  if (shards.length === 0) {
    throw new GcpCanonicalizeError('Could not read the downloaded export for this period: no .parquet shards were downloaded');
  }
  const sourceExpr = `read_parquet([${shards.map(quoteLiteral).join(', ')}], union_by_name=true)`;

  let source: ReadonlyMap<string, string>;
  try {
    source = await describeSource(conn, sourceExpr);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new GcpCanonicalizeError(`Could not read the downloaded export for this period: ${message}`);
  }

  const missing = REQUIRED_SOURCE_COLUMNS.filter(col => !source.has(col));
  if (missing.length > 0) {
    throw new GcpCanonicalizeError(
      `The downloaded export is missing FOCUS column(s) ${missing.join(', ')} — check that the bucket holds the FOCUS BigQuery export and not another billing export`,
      missing,
    );
  }

  const { selectList, synthesized } = buildProjection(source);
  const tagEntries = tagEntriesExpr(TAG_SOURCE_COLUMNS.filter(col => source.has(col)));

  await mkdir(dirname(options.outputPath), { recursive: true });

  await conn.run(`
COPY (
  WITH __src AS (
    SELECT *, ${tagEntries} AS __tag_entries
    FROM ${sourceExpr}
  )
  SELECT
    ${selectList.join(',\n    ')}
  FROM __src
) TO ${quoteLiteral(options.outputPath)} (FORMAT PARQUET, COMPRESSION SNAPPY)`);

  // Single-element list for the same reason the source uses one: a literal
  // path inside a list is not glob-expanded.
  const outputExpr = `read_parquet([${quoteLiteral(options.outputPath)}])`;
  const rows = await readSingleNumber(conn, `SELECT COUNT(*) FROM ${outputExpr}`);

  // A missing column here would mean the projection above and the contract
  // drifted apart — cheap to check, and it fails at sync time rather than at
  // the first query over the period.
  const output = await describeSource(conn, outputExpr);
  const notEmitted = REQUIRED_FOCUS_COLUMNS.filter(col => !output.has(col));
  if (notEmitted.length > 0) {
    throw new GcpCanonicalizeError(
      `Canonicalized output is missing required column(s) ${notEmitted.join(', ')}`,
      notEmitted,
    );
  }

  return { rows, synthesizedColumns: synthesized };
}

/** A connection this module owns, paired with the teardown that releases both
 *  it and the instance behind it. */
interface OwnedConnection {
  readonly connection: CanonicalizeConnection;
  readonly close: () => void;
}

async function createOwnConnection(options: CanonicalizeOptions): Promise<OwnedConnection> {
  // Dynamic so the native binding is only loaded by a workspace that actually
  // has a GCP provider. NOT via `duckdb-lazy.ts`: that helper uses
  // `createRequire(import.meta.url)`, and esbuild rewrites `import.meta` to
  // `{}` when it bundles the sync worker as CJS, so the require factory would
  // be constructed with `undefined` and throw at load.
  const { DuckDBInstance } = await import('@duckdb/node-api');
  const instance = await DuckDBInstance.create();
  // Everything after `create()` is guarded: the caller's `finally` only runs
  // once this function RESOLVES, so a failure in `connect()` or either `SET`
  // (a bad memoryGB, say) leaked a native engine — with its own buffer pool
  // and temp dir — for the life of the sync worker. One per failing period.
  // Inferred, not annotated as `CanonicalizeConnection`: that interface is the
  // narrow slice this module queries through, and `close` below needs the
  // driver's own `disconnectSync`.
  let conn: Awaited<ReturnType<typeof instance.connect>>;
  try {
    conn = await instance.connect();
    // memory_limit / threads are instance-global. This instance shares the box
    // with the query worker's, so it takes a deliberately small slice rather
    // than DuckDB's sole-tenant default.
    await conn.run(`SET memory_limit = '${String(options.memoryGB ?? 2)}GB'`);
    await conn.run(`SET threads = ${String(options.threads ?? 2)}`);
  } catch (err: unknown) {
    try { instance.closeSync(); } catch { /* nothing to close */ }
    throw err;
  }
  return {
    connection: conn,
    close: () => {
      // Best effort: a teardown failure must not mask the canonicalization
      // error that sent us through the `finally`.
      try { conn.disconnectSync(); } catch { /* already gone */ }
      try { instance.closeSync(); } catch { /* already gone */ }
    },
  };
}
