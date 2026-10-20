import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asBucketPath, asProviderName } from '@costgoblin/core';
import type { CostGoblinConfig, CostScopeConfig, DimensionsConfig } from '@costgoblin/core';
import type { McpContext, RawRow } from '../context.js';
import { runSql, validateRunSqlQuery } from '../tools/run-sql.js';
import { parseJsonResult, resultText } from './helpers/json-result.js';

// run_sql end to end with a scripted runQuery: which `costs` CTE the user's
// query is wrapped in (rollup table vs per-provider Parquet, metric, default
// window), and how the returned rows become the result.

const NOW = Date.UTC(2026, 1, 25, 12);
const JAN = { start: '2026-01-01', end: '2026-01-31' };

const CONFIG: CostGoblinConfig = {
  providers: [{
    name: asProviderName('aws'), type: 'aws', credentialsProfile: 'default',
    sync: { daily: { bucket: asBucketPath('s3://b/d'), retentionDays: 90 }, intervalMinutes: 60 },
  }],
  defaults: { periodDays: 30, costMetric: 'effective', lagDays: 2 },
};
const DIMENSIONS: DimensionsConfig = { builtIn: [], tags: [] };

let root: string;
let dataDir: string;

interface Harness {
  readonly ctx: McpContext;
  /** Every statement run through runQuery except the coverage probe. */
  readonly statements: string[];
  readonly sourceRequests: { range: { readonly start: string; readonly end: string }; tier: string }[];
}

function harness(opts: {
  respond?: (sql: string) => Promise<RawRow[]>;
  costScope?: () => Promise<CostScopeConfig>;
  materialized?: string;
} = {}): Harness {
  const statements: string[] = [];
  const sourceRequests: { range: { readonly start: string; readonly end: string }; tier: string }[] = [];
  const unused = (): never => { throw new Error('not used by run_sql'); };
  const ctx: McpContext = {
    dataDir,
    stateDir: root,
    runQuery: (sql) => {
      if (sql.includes('MAX(ChargePeriodStart::DATE)')) return Promise.resolve([{ d: '2026-02-20' }]);
      statements.push(sql);
      return opts.respond?.(sql) ?? Promise.resolve([]);
    },
    runPreparedQuery: unused,
    getConfig: () => Promise.resolve(CONFIG),
    getDimensions: () => Promise.resolve(DIMENSIONS),
    getQueryDimensions: () => Promise.resolve(DIMENSIONS),
    getCostScope: opts.costScope ?? (() => Promise.resolve({ costMetric: 'billed', rules: [] })),
    getAccountMap: unused,
    getAccountReverseMap: unused,
    getOrgAccountsPath: () => Promise.resolve(undefined),
    materializedBase: {
      getSource: (range, tier) => {
        sourceRequests.push({ range, tier });
        return opts.materialized;
      },
    },
    warmup: () => Promise.resolve(),
    now: () => NOW,
  };
  return { ctx, statements, sourceRequests };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'cg-mcp-run-sql-'));
  dataDir = join(root, 'data');
  for (const month of ['2026-01', '2026-02']) {
    const dir = join(dataDir, 'aws', 'raw', `daily-${month}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'data.parquet'), '');
  }
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('run_sql costs CTE', () => {
  it('defaults to the 60 days ending at the default lag, reading only the months on disk', async () => {
    const { ctx, statements } = harness({ respond: () => Promise.resolve([{ n: 1 }]) });
    await runSql(ctx, { sql: 'SELECT COUNT(*) AS n FROM costs' });
    expect(statements).toHaveLength(1);
    const sql = statements[0] ?? '';
    // NOW minus 61 days .. NOW minus 2 days (the default lag).
    expect(sql).toContain("WHERE usage_date BETWEEN '2025-12-26' AND '2026-02-23')");
    expect(sql).toContain('/aws/raw/daily-2026-01/*.parquet');
    expect(sql).toContain('/aws/raw/daily-2026-02/*.parquet');
    expect(sql).not.toContain('daily-2025-12');
  });

  it('backs `cost` with the active Cost Scope metric', async () => {
    const { ctx, statements } = harness({ costScope: () => Promise.resolve({ costMetric: 'list', rules: [] }) });
    await runSql(ctx, { sql: 'SELECT SUM(cost) AS c FROM costs', dateRange: JAN });
    expect(statements[0]).toContain('COALESCE(ListCost, 0) AS cost');
  });

  // An answer on another metric than the user's would read as the real cost.
  it('fails, running nothing, when the Cost Scope does not load', async () => {
    const { ctx, statements } = harness({ costScope: () => Promise.reject(new Error("Couldn't load cost-scope.yaml: rules must be an array")) });
    await expect(runSql(ctx, { sql: 'SELECT SUM(cost) AS c FROM costs', dateRange: JAN })).rejects.toThrow("Couldn't load cost-scope.yaml");
    expect(statements).toEqual([]);
  });

  it('reads the materialized rollup when it covers the range', async () => {
    const { ctx, statements, sourceRequests } = harness({ materialized: 'cost_base' });
    await runSql(ctx, { sql: 'SELECT SUM(cost) AS c FROM costs', dateRange: JAN });
    expect(sourceRequests).toEqual([{ range: JAN, tier: 'daily' }]);
    expect(statements[0]).toBe(
      "WITH costs AS (SELECT * FROM cost_base WHERE usage_date BETWEEN '2026-01-01' AND '2026-01-31')\n" +
      'SELECT * FROM (\nSELECT SUM(cost) AS c FROM costs\n) AS _costgoblin_q\nLIMIT 101',
    );
  });

  it('answers with the coverage note, without running the query, when no month is synced in range', async () => {
    const { ctx, statements } = harness();
    const result = parseJsonResult(resultText(await runSql(ctx, {
      sql: 'SELECT 1 AS x FROM costs', dateRange: { start: '2025-06-01', end: '2025-06-30' }, format: 'json',
    })));
    expect(result.title).toBe('Query Result');
    expect(result.notes).toEqual([
      '*No data available for the requested range 2025-06-01 to 2025-06-30. See coverage banner above for what is available.*',
    ]);
    expect(statements).toEqual([]);
  });
});

// NOW is 2026-02-25: a 7-day freshness lag leaves Feb 18 as the newest day.
describe('run_sql and the cost scope freshness lag', () => {
  const LAG_7 = (): Promise<CostScopeConfig> => Promise.resolve({ costMetric: 'billed', rules: [], lagDays: 7 });

  it('ends the default window at the configured lag', async () => {
    const { ctx, statements } = harness({ costScope: LAG_7 });
    await runSql(ctx, { sql: 'SELECT COUNT(*) AS n FROM costs' });
    expect(statements[0]).toContain("WHERE usage_date BETWEEN '2025-12-21' AND '2026-02-18')");
  });

  it('cuts a requested range back to the lag and says so', async () => {
    const { ctx, statements } = harness({ costScope: LAG_7, respond: () => Promise.resolve([{ n: 1 }]) });
    const text = resultText(await runSql(ctx, { sql: 'SELECT COUNT(*) AS n FROM costs', dateRange: { start: '2026-02-01', end: '2026-02-25' } }));
    expect(statements[0]).toContain("WHERE usage_date BETWEEN '2026-02-01' AND '2026-02-18')");
    expect(text).toContain('Your requested range stops at 2026-02-18');
  });

  it('runs nothing for a range entirely within the lag, naming the newest day it can read', async () => {
    const { ctx, statements } = harness({ costScope: LAG_7 });
    const text = resultText(await runSql(ctx, { sql: 'SELECT COUNT(*) AS n FROM costs', dateRange: { start: '2026-02-20', end: '2026-02-25' } }));
    expect(statements).toEqual([]);
    expect(text).toContain('Ask for a range ending on or before 2026-02-18');
  });
});

describe('run_sql results', () => {
  it('says so when the query returns no rows', async () => {
    const { ctx } = harness({ respond: () => Promise.resolve([]) });
    expect(resultText(await runSql(ctx, { sql: 'SELECT 1 AS x FROM costs WHERE false', dateRange: JAN }))).toBe('*Query returned no rows.*');
  });

  it.each([
    ['an Error', new Error('Binder Error: column "nope" not found'), 'Error: Query failed: Binder Error: column "nope" not found'],
    ['a non-Error value', 'interrupted', 'Error: Query failed: interrupted'],
  ])('reports a query that fails with %s', async (_label, failure, text) => {
    const reason: unknown = failure;
    const { ctx } = harness({ respond: () => { throw reason; } });
    expect(await runSql(ctx, { sql: 'SELECT nope FROM costs', dateRange: JAN })).toEqual({
      content: [{ type: 'text', text }],
      isError: true,
    });
  });

  it('types columns from the first row and converts each cell', async () => {
    const { ctx } = harness({
      respond: () => Promise.resolve([
        { n: 5n, x: 1.5, s: 'a', d: new Date('2026-01-02T08:00:00Z'), b: true, o: null },
        { n: 7n, x: 2, s: null, d: null, b: false, o: { nested: 1 } },
      ]),
    });
    const text = resultText(await runSql(ctx, { sql: 'SELECT * FROM costs', dateRange: JAN, format: 'json' }));
    const result = parseJsonResult(text);
    const parsed: unknown = JSON.parse(text);
    expect(parsed).toMatchObject({
      tables: [{
        columns: [
          { key: 'n', type: 'number' }, { key: 'x', type: 'number' }, { key: 's', type: 'string' },
          { key: 'd', type: 'string' }, { key: 'b', type: 'string' }, { key: 'o', type: 'string' },
        ],
      }],
    });
    // bigint becomes a number; a Date its UTC day; null and objects ''.
    expect(result.tables[0]?.rows).toEqual([
      { n: 5, x: 1.5, s: 'a', d: '2026-01-02', b: 'true', o: '' },
      { n: 7, x: 2, s: '', d: '', b: 'false', o: '' },
    ]);
    expect(result.meta.get('Rows')).toBe(2);
    expect(result.notes).toEqual([]);
  });

  it('caps the rows and says the result was truncated', async () => {
    const { ctx, statements } = harness({ respond: () => Promise.resolve([{ i: 1 }, { i: 2 }, { i: 3 }]) });
    const result = parseJsonResult(resultText(await runSql(ctx, { sql: 'SELECT i FROM costs', dateRange: JAN, limit: 2, format: 'json' })));
    expect(statements[0]).toMatch(/\nLIMIT 3$/);
    expect(result.tables[0]?.rows).toEqual([{ i: 1 }, { i: 2 }]);
    expect(result.meta.get('Rows')).toBe(2);
    expect(result.notes).toEqual(['*Results truncated to 2 rows — narrow the query or page with LIMIT/OFFSET inside it.*']);
  });
});

describe('validateRunSqlQuery block comments', () => {
  it('scrubs a block comment that contains a lone star', () => {
    expect(validateRunSqlQuery('SELECT 1 /* a * b */ FROM costs')).toBeNull();
  });

  it('ignores a blocked function name inside a block comment', () => {
    expect(validateRunSqlQuery('SELECT 1 /* read_text( */ FROM costs')).toBeNull();
  });

  it('still sees a blocked call after a closed block comment', () => {
    expect(validateRunSqlQuery("SELECT 1 /* note */ FROM read_text('/etc/hosts')")).toBe(
      'The function read_text() is not allowed in run_sql — query the provided `costs` table instead.',
    );
  });
});
