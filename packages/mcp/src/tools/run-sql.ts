import {
  assertDateString,
  buildSource,
  computePeriodsInRange,
  DEFAULT_LAG_DAYS,
  logger,
} from '@costgoblin/core';
import type { McpContext } from '../context.js';
import type { Cell, Column, StructuredResult } from '../formatters/result.js';
import {
  computeDataCoverage,
  emptyRangeResult,
  getQueryProviders,
  resolveFormat,
  structuredToolResult,
  toStr,
  toolError,
  toolResult,
} from './tool-helpers.js';

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

/** Per-cell and per-header character budget. One multi-megabyte value (a
 *  `repeat()`, a `string_agg`, a PIVOT header built from a long value) would
 *  otherwise be padded across every row of the markdown table and blow past
 *  V8's max string length. ARNs and resource ids are well under this. */
export const MAX_CELL_CHARS = 4096;

/** The row cap for a run_sql call: the requested limit truncated to an integer
 *  and clamped into 1..MAX_LIMIT (default 100). The schema already rejects
 *  non-integers and values < 1; this is the second layer for direct callers. */
export function resolveRunSqlCap(limit: number | undefined): number {
  return Math.min(Math.max(Math.trunc(limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
}

/** The statement run_sql executes: the user's query wrapped as a subquery over
 *  the `costs` CTE, capped at `cap + 1` rows so the caller can tell a result of
 *  exactly `cap` rows from a truncated one.
 *
 *  The cap is unconditional: a LIMIT (or a `-- LIMIT` comment) in the user's
 *  query stays inside the subquery and cannot lift it. The newlines around the
 *  user's SQL are load-bearing — they end a trailing `--` comment before the
 *  closing `)`. The cap is a validated integer literal, not a `$n` parameter,
 *  so it cannot collide with a placeholder in the user's own SQL. */
export function buildRunSqlStatement(costsCte: string, userSql: string, cap: number): string {
  if (!Number.isSafeInteger(cap) || cap < 1) {
    throw new RangeError(`run_sql row cap must be a positive integer, got ${String(cap)}`);
  }
  // The validator tolerates one trailing ';' — strip it, or the closing
  // `) AS ... LIMIT` lands after it as a second, invalid statement.
  // (String ops, not a regex: no backtracking over long whitespace runs.)
  let bareSql = userSql.trimEnd();
  if (bareSql.endsWith(';')) bareSql = bareSql.slice(0, -1).trimEnd();
  return `WITH ${costsCte}\nSELECT * FROM (\n${bareSql}\n) AS _costgoblin_q\nLIMIT ${String(cap + 1)}`;
}

/** Truncate a string over MAX_CELL_CHARS to its first MAX_CELL_CHARS UTF-16
 *  units plus a `…[+N chars]` marker (N counts the dropped units). Never splits
 *  a surrogate pair: when the cut would land between a high and a low
 *  surrogate, the high one is dropped too. */
export function truncateCell(s: string): string {
  if (s.length <= MAX_CELL_CHARS) return s;
  let end = MAX_CELL_CHARS;
  // charCodeAt, not codePointAt: we need the raw UTF-16 unit before the cut.
  const last = s.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${s.slice(0, end)}…[+${String(s.length - end)} chars]`;
}

// NOT the load-bearing control. The desktop app runs every MCP query on a
// dedicated DuckDB instance that is sandboxed to the workspace data and
// configuration-locked (#594, `buildDuckDbSandboxStatements`); that sandbox is
// what stops run_sql reading `~/.aws/credentials`, writing files or reaching the
// network. This regex guard is kept only as defence in depth and as an early,
// friendlier error for the obvious cases. It is known to be bypassable: the
// scrubber below understands only `'` strings and `--` / `/* */` comments, so a
// double-quoted identifier containing `'` desyncs it (hiding a call or a `;`
// from the single-statement check), a quoted function name (`"read_text"(`)
// dodges the name patterns, and a comma join onto a string path skips the
// FROM/JOIN check. Do not rely on it, and do not grow it into a parser.
const BLOCKED_FUNCTIONS = [
  'read_csv', 'read_csv_auto', 'read_parquet', 'parquet_scan',
  'parquet_metadata', 'parquet_schema', 'parquet_file_metadata', 'parquet_kv_metadata',
  'read_json', 'read_json_auto', 'read_json_objects', 'read_json_objects_auto',
  'read_ndjson', 'read_ndjson_auto', 'read_ndjson_objects',
  'read_text', 'read_blob', 'sniff_csv', 'glob',
  'query', 'query_table', 'json_execute_serialized_sql',
  'iceberg_scan', 'iceberg_metadata', 'iceberg_snapshots', 'delta_scan',
  'postgres_scan', 'postgres_query', 'mysql_scan', 'mysql_query',
  'sqlite_scan', 'sqlite_query',
];

// Precompiled once — the patterns are static and every run_sql call walks the
// full list for a legitimate query.
const BLOCKED_FUNCTION_PATTERNS = BLOCKED_FUNCTIONS.map(fn => ({
  fn,
  re: new RegExp(String.raw`\b${fn}\s*\(`, 'i'),
}));

/** Replace string literals (with '' escapes) and comments with inert
 *  placeholders in a single pass, so the structural checks below can't be
 *  fooled by a keyword hidden inside a string, nor by a `--`/`/*` that is
 *  itself inside a string literal. The original SQL is what actually runs;
 *  this scrubbed copy is only inspected. */
function scrubSql(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    if (ch === undefined) break;
    const next = sql[i + 1];
    if (ch === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      out += "''";
      continue;
    }
    if (ch === '-' && next === '-') {
      i += 2;
      while (i < n && sql[i] !== '\n') i++;
      out += ' ';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Validate an ad-hoc run_sql query. Returns an error message to surface to the
 *  caller, or null when the query is allowed. Defense in depth on top of the
 *  parameterized query layer: run_sql is the one place that takes raw SQL. */
export function validateRunSqlQuery(sql: string): string | null {
  const scrubbed = scrubSql(sql);

  if (!/^\s*(?:WITH|SELECT)\b/i.test(scrubbed)) {
    return 'Only SELECT/WITH queries are allowed. DDL, DML, and COPY statements are rejected for safety.';
  }

  // Single statement only — stop `SELECT 1; COPY ... TO 'file'` style stacking.
  if (scrubbed.replace(/;\s*$/, '').includes(';')) {
    return 'Only a single SQL statement is allowed.';
  }

  // `FROM '/path'` / `JOIN 'x.csv'` triggers DuckDB's replacement scan, reading
  // the path as a file without naming read_csv/read_parquet explicitly.
  if (/\b(?:from|join)\s+'/i.test(scrubbed)) {
    return 'Reading from a file path is not allowed — query the provided `costs` table.';
  }

  for (const { fn, re } of BLOCKED_FUNCTION_PATTERNS) {
    if (re.test(scrubbed)) {
      return `The function ${fn}() is not allowed in run_sql — query the provided \`costs\` table instead.`;
    }
  }

  return null;
}

/** The explicit range when given (validated), else the trailing 60 days ending
 *  at the default lag. */
function resolveDateRange(param: { start: string; end: string } | undefined): { start: string; end: string } {
  if (param !== undefined) {
    assertDateString(param.start);
    assertDateString(param.end);
    return param;
  }
  const dayMs = 86_400_000;
  const end = new Date(Date.now() - DEFAULT_LAG_DAYS * dayMs);
  const start = new Date(end.getTime() - 59 * dayMs);
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

/** The `costs` CTE the user's query runs against: the materialized rollup when
 *  it covers the range, else the per-provider Parquet union. Returns null when
 *  no provider has data in range. */
async function buildCostsCte(ctx: McpContext, dateRange: { start: string; end: string }): Promise<string | null> {
  // Both bounds are interpolated into SQL literals below — assert at the
  // interpolation site (not just in resolveDateRange), matching how core's
  // query builder re-asserts before every BETWEEN interpolation.
  assertDateString(dateRange.start);
  assertDateString(dateRange.end);
  const matSource = ctx.materializedBase.getSource(dateRange, 'daily');
  if (matSource !== undefined) {
    return `costs AS (SELECT * FROM ${matSource} WHERE usage_date BETWEEN '${dateRange.start}' AND '${dateRange.end}')`;
  }
  const allProviders = await getQueryProviders(ctx, 'daily');
  const required = computePeriodsInRange(dateRange);
  // Per-provider month intersection; providers with nothing in range are
  // dropped (a zero-match glob fails the whole union).
  const branches = allProviders
    .map(pr => ({
      name: pr.name,
      periods: required.filter(m => pr.availablePeriods?.includes(m) ?? false),
    }))
    .filter(b => b.periods.length > 0);
  if (branches.length === 0) return null;
  // Mirror the dashboards: the active Cost Scope's metric backs `cost`.
  const scopeMetric = await ctx.getCostScope().then(cs => cs.costMetric).catch(() => 'effective' as const);
  const source = buildSource({
    dataDir: ctx.dataDir,
    tier: 'daily',
    dimensions: await ctx.getQueryDimensions(),
    orgAccountsPath: await ctx.getOrgAccountsPath(),
    providers: branches,
    costMetric: scopeMetric,
  });
  return `costs AS (SELECT * FROM ${source} WHERE usage_date BETWEEN '${dateRange.start}' AND '${dateRange.end}')`;
}

function columnsOf(firstRow: Readonly<Record<string, unknown>>): Column[] {
  return Object.keys(firstRow).map(name => {
    const sample = firstRow[name];
    // bigint counts as numeric: toCellRows converts bigint cells to Number, so
    // the column type must agree or COUNT(*)/integer SUM columns render as text.
    return {
      // `key` stays raw: it indexes the row object. Only the displayed
      // header is budgeted.
      key: name,
      header: truncateCell(name),
      type: typeof sample === 'number' || typeof sample === 'bigint' ? 'number' : 'string',
    };
  });
}

function toCellRows(rows: readonly Readonly<Record<string, unknown>>[], columnNames: readonly string[]): Cell[][] {
  return rows.map(r =>
    columnNames.map((name): Cell => {
      const val = r[name];
      if (typeof val === 'number') return val;
      if (typeof val === 'bigint') return Number(val);
      return truncateCell(toStr(val));
    }),
  );
}

export async function runSql(
  ctx: McpContext,
  params: {
    sql: string;
    limit?: number | undefined;
    dateRange?: { start: string; end: string } | undefined;
    format?: string | undefined;
  },
): Promise<{ content: [{ type: 'text'; text: string }] }> {
  const format = resolveFormat(params.format);
  const userSql = params.sql.trim();
  const cap = resolveRunSqlCap(params.limit);

  const validationError = validateRunSqlQuery(userSql);
  if (validationError !== null) {
    return toolError(validationError);
  }

  const dateRange = resolveDateRange(params.dateRange);
  const costsCte = await buildCostsCte(ctx, dateRange);
  if (costsCte === null) {
    return emptyRangeResult(ctx, dateRange, format, `Query Result`);
  }

  const statement = buildRunSqlStatement(costsCte, userSql, cap);

  logger.info('run-sql', { userSqlLength: userSql.length, cap });

  let fetched: Readonly<Record<string, unknown>>[];
  try {
    fetched = await ctx.runQuery(statement);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return toolError(`Query failed: ${message}`);
  }

  // The statement asks for cap + 1 rows: an extra row means the query had more.
  const truncated = fetched.length > cap;
  const rows = truncated ? fetched.slice(0, cap) : fetched;

  if (rows.length === 0) {
    return toolResult('*Query returned no rows.*');
  }

  const firstRow = rows[0];
  if (firstRow === undefined) {
    return toolResult('*Query returned no rows.*');
  }

  const columns = columnsOf(firstRow);
  // Cells iterate the columns' own key order — headers and cells share one
  // source of truth, so they cannot drift apart.
  const tableRows = toCellRows(rows, columns.map(c => c.key));

  const meta: { label: string; value: string | number; type?: 'number' }[] = [
    { label: 'Rows', value: rows.length, type: 'number' },
  ];
  const notes: string[] = [];
  if (truncated) {
    notes.push(`*Results truncated to ${String(cap)} rows — narrow the query or page with LIMIT/OFFSET inside it.*`);
  }

  const coverage = await computeDataCoverage(ctx, dateRange);
  const result: StructuredResult = {
    title: `Query Result`,
    coverage,
    meta,
    notes,
    tables: [{ columns, rows: tableRows }],
  };
  return structuredToolResult(result, format);
}
