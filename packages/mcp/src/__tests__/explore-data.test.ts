import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadCostScope, loadDimensions, SecurityError } from '@costgoblin/core';
import type { McpContext } from '../context.js';
import { exploreData } from '../tools/explore-data.js';
import { fetchRows, fetchRowsPrepared } from './helpers/duckdb-rows.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, '..', '..', '..', 'core', 'src', '__fixtures__');
const SYNTHETIC_DIR = join(FIXTURES_DIR, 'synthetic');
const CONFIG_DIR = join(FIXTURES_DIR, 'config');

interface RecordedCall {
  readonly kind: 'query' | 'prepared';
  readonly sql: string;
  readonly params: readonly unknown[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The first table's rows from a format=json tool response, narrowed. */
function jsonRows(text: string): readonly (readonly unknown[])[] {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error('response is not an object');
  const tables = parsed['tables'];
  if (!Array.isArray(tables)) throw new Error('response has no tables');
  const first: unknown = tables[0];
  if (!isRecord(first)) throw new Error('response has no first table');
  const rows = first['rows'];
  if (!Array.isArray(rows)) throw new Error('first table has no rows');
  return rows.map((r: unknown) => {
    if (!Array.isArray(r)) throw new Error('row is not an array');
    const cells: unknown[] = r;
    return cells;
  });
}

describe('explore_data', () => {
  let db: DuckDBInstance;
  let conn: DuckDBConnection;
  let ctx: McpContext;
  const calls: RecordedCall[] = [];

  beforeAll(async () => {
    db = await DuckDBInstance.create();
    conn = await db.connect();

    const config = await loadConfig(join(CONFIG_DIR, 'costgoblin.yaml'));
    const dimensions = await loadDimensions(join(CONFIG_DIR, 'dimensions.yaml'));
    const costScope = await loadCostScope(join(CONFIG_DIR, 'cost-scope.yaml'));

    ctx = {
      dataDir: SYNTHETIC_DIR,
      stateDir: FIXTURES_DIR,
      runQuery: (sql) => {
        calls.push({ kind: 'query', sql, params: [] });
        return fetchRows(conn, sql);
      },
      // Real prepared statements with positional binding — not text
      // substitution — so a mis-bound or interpolated value would show up.
      runPreparedQuery: (sql, params) => {
        calls.push({ kind: 'prepared', sql, params });
        return fetchRowsPrepared(conn, sql, params);
      },
      getConfig: () => Promise.resolve(config),
      getDimensions: () => Promise.resolve(dimensions),
      getQueryDimensions: () => Promise.resolve(dimensions),
      getCostScope: () => Promise.resolve(costScope),
      getAccountMap: () => Promise.resolve(new Map<string, string>()),
      getAccountReverseMap: () => Promise.resolve(new Map<string, readonly string[]>()),
      getOrgAccountsPath: () => Promise.resolve(undefined),
      materializedBase: { getSource: () => undefined },
      warmup: () => Promise.resolve(),
      now: () => Date.now(),
    };
  });

  afterAll(() => {
    conn.disconnectSync();
    db.closeSync();
  });

  beforeEach(() => {
    calls.length = 0;
  });

  it('rejects a V8-parseable but non-YYYY-MM-DD end before any SQL runs', async () => {
    await expect(exploreData(ctx, {
      dateRange: { start: '2026-01-01', end: "31 Jan 2026 (' OR 1=1 OR '" },
    })).rejects.toThrow(SecurityError);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['raw rows', {}],
    ['aggregated rows', { groupByColumns: ['service'] }],
  ])('binds the date range and limit as parameters (%s)', async (_label, extra) => {
    const result = await exploreData(ctx, {
      dateRange: { start: '2026-01-01', end: '2026-01-31' },
      limit: 7,
      format: 'json',
      ...extra,
    });
    expect(jsonRows(result.content[0].text).length).toBe(7);

    const main = calls.filter(c => c.kind === 'prepared');
    expect(main).toHaveLength(1);
    const call = main[0];
    expect(call?.sql).toContain('usage_date BETWEEN $1 AND $2');
    expect(call?.sql).not.toContain('2026-01-');
    expect(call?.sql).toMatch(/LIMIT \$3\s*$/);
    expect(call?.params).toEqual(['2026-01-01', '2026-01-31', 7]);
    // Only computeDataCoverage's own probe goes through runQuery.
    for (const c of calls.filter(q => q.kind === 'query')) {
      expect(c.sql).not.toContain('usage_date BETWEEN');
    }
  });

  it('clamps the limit into 1..200 before binding it', async () => {
    await exploreData(ctx, {
      dateRange: { start: '2026-01-01', end: '2026-01-31' },
      limit: 10_000,
      format: 'json',
    });
    expect(calls.find(c => c.kind === 'prepared')?.params.at(-1)).toBe(200);
  });

  it('applies filters, binding their values', async () => {
    const all = await exploreData(ctx, {
      dateRange: { start: '2026-01-01', end: '2026-01-31' },
      groupByColumns: ['service'],
      limit: 200,
      format: 'json',
    });
    const allServices = jsonRows(all.content[0].text).map(r => r[0]);
    expect(allServices.length).toBeGreaterThan(1);
    expect(allServices).toContain('Amazon Elastic Compute Cloud');

    calls.length = 0;
    const filtered = await exploreData(ctx, {
      dateRange: { start: '2026-01-01', end: '2026-01-31' },
      filters: { service: ['Amazon Elastic Compute Cloud'] },
      groupByColumns: ['service'],
      limit: 200,
      format: 'json',
    });
    const services = jsonRows(filtered.content[0].text).map(r => r[0]);
    expect(services).toEqual(['Amazon Elastic Compute Cloud']);

    const call = calls.find(c => c.kind === 'prepared');
    expect(call?.sql).not.toContain('Amazon Elastic Compute Cloud');
    expect(call?.params).toContain('Amazon Elastic Compute Cloud');
  });

  it('applies filters to raw rows too', async () => {
    const result = await exploreData(ctx, {
      dateRange: { start: '2026-01-01', end: '2026-01-31' },
      filters: { service: ['Amazon Elastic Compute Cloud'] },
      limit: 50,
      format: 'json',
    });
    const rows = jsonRows(result.content[0].text);
    expect(rows.length).toBeGreaterThan(0);
    // Raw columns: date, account, service, resource, cost.
    for (const r of rows) expect(r[2]).toBe('Amazon Elastic Compute Cloud');
  });

  it('rejects an unknown filter dimension with SecurityError', async () => {
    await expect(exploreData(ctx, {
      dateRange: { start: '2026-01-01', end: '2026-01-31' },
      filters: { "service = '' OR 1=1 --": ['x'] },
    })).rejects.toThrow(SecurityError);
    expect(calls.filter(c => c.kind === 'prepared')).toHaveLength(0);
  });
});
