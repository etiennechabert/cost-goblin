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
  resolveFormat,
  structuredToolResult,
  toStr,
  toolError,
  toolResult,
} from './tool-helpers.js';

const MAX_LIMIT = 500;

function isSafeSelect(sql: string): boolean {
  const trimmed = sql.trim();
  const firstToken = trimmed.split(/\s+/)[0]?.toUpperCase();
  return firstToken === 'SELECT' || firstToken === 'WITH';
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

  if (!isSafeSelect(userSql)) {
    return toolError('Only SELECT/WITH queries are allowed. DDL, DML, and COPY statements are rejected for safety.');
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
    const available = await listLocalMonths(ctx.dataDir, 'daily');
    const required = computePeriodsInRange(dateRange);
    const periods = required.filter(p => available.includes(p));
    if (periods.length === 0) {
      return toolError(`No data available for ${dateRange.start} to ${dateRange.end}.`);
    }
    const source = buildSource({
      dataDir: ctx.dataDir,
      tier: 'daily',
      dimensions,
      orgAccountsPath: orgPath,
      periods,
      costMetric: 'unblended',
      availableColumns,
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

  const result: StructuredResult = {
    title: `Query Result`,
    meta,
    notes,
    tables: [{ columns, rows: tableRows }],
  };
  return structuredToolResult(result, format);
}
