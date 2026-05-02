import {
  buildSource,
  computePeriodsInRange,
  DEFAULT_LAG_DAYS,
  listLocalMonths,
  logger,
} from '@costgoblin/core';
import type { McpContext } from '../context.js';
import { markdownTable, type ColumnDef } from '../formatters/markdown-table.js';
import { toStr, toolError, toolResult } from './tool-helpers.js';

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
  },
): Promise<{ content: [{ type: 'text'; text: string }] }> {
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
    costsCte = `costs AS (SELECT * FROM ${matSource})`;
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

  const columns: ColumnDef[] = columnNames.map(name => ({ header: name }));
  const tableRows = rows.map(r =>
    columnNames.map(name => {
      const val = r[name];
      if (typeof val === 'number') {
        return Number.isInteger(val) ? String(val) : val.toFixed(4);
      }
      return toStr(val);
    }),
  );

  const sections: string[] = [];
  sections.push(`## Query Result (${String(rows.length)} rows)`);
  sections.push('');
  sections.push(markdownTable(columns, tableRows));
  if (rows.length >= limit) {
    sections.push(`\n*Results limited to ${String(limit)} rows.*`);
  }

  return toolResult(sections.join('\n'));
}
