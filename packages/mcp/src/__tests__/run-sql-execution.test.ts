import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asBucketPath, asProviderName } from '@costgoblin/core';
import type { CostGoblinConfig, CostScopeConfig, DimensionsConfig } from '@costgoblin/core';
import type { McpContext, RawRow } from '../context.js';
import { runSql, validateRunSqlQuery } from '../tools/run-sql.js';
import { fetchRows } from './helpers/duckdb-rows.js';
import { parseJsonResult, resultText } from './helpers/json-result.js';
import { isCsvComment, markdownTables, parseCsvRecord } from './helpers/lines.js';

// run_sql end to end with a scripted runQuery: which `costs` CTE the user's
// query is wrapped in (rollup table vs per-provider Parquet, metric, default
// window), and how the returned rows become the result. The last block runs
// the statements on a real DuckDB instead.

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
    const { ctx, statements } = harness({ respond: () => Promise.resolve([{ n: '1' }]) });
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
      'SELECT to_json(COLUMNS(*))::VARCHAR FROM (\nSELECT SUM(cost) AS c FROM costs\n) AS _costgoblin_q\nLIMIT 101',
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
    const { ctx, statements } = harness({ costScope: LAG_7, respond: () => Promise.resolve([{ n: '1' }]) });
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

  // Every cell reaches run_sql as DuckDB's JSON text for the value (the
  // wrapper's to_json), or null for SQL NULL.
  it('types each column by its first non-empty cell', async () => {
    const { ctx } = harness({
      respond: () => Promise.resolve([
        { n: null, s: '""', x: '1.5' },
        { n: '5', s: '"a"', x: '2' },
      ]),
    });
    const text = resultText(await runSql(ctx, { sql: 'SELECT * FROM costs', dateRange: JAN, format: 'json' }));
    const result = parseJsonResult(text);
    const parsed: unknown = JSON.parse(text);
    expect(parsed).toMatchObject({
      tables: [{
        columns: [{ key: 'n', type: 'number' }, { key: 's', type: 'string' }, { key: 'x', type: 'number' }],
      }],
    });
    expect(result.tables[0]?.rows).toEqual([
      { n: '', s: '', x: 1.5 },
      { n: 5, s: 'a', x: 2 },
    ]);
    expect(result.meta.get('Rows')).toBe(2);
    expect(result.notes).toEqual([]);
  });

  // A blank cell reads as a real empty value; a broken wrapper must not.
  it('fails, instead of blanking it, on a cell that is not JSON text', async () => {
    const { ctx } = harness({ respond: () => Promise.resolve([{ n: 5n }]) });
    await expect(runSql(ctx, { sql: 'SELECT 5 AS n', dateRange: JAN })).rejects.toThrow(
      'run_sql expects JSON text or NULL in every cell, got bigint',
    );
  });

  it('caps the rows and says the result was truncated', async () => {
    const { ctx, statements } = harness({ respond: () => Promise.resolve([{ i: '1' }, { i: '2' }, { i: '3' }]) });
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

// The desktop app runs MCP queries on a DuckDB worker thread, and the rows
// come back by postMessage. Its structured clone drops DuckDB's value classes:
// a DATE arrives as `{ days }`, a DECIMAL as `{ width, scale, value }`, a TIME
// and a TIMESTAMP alike as `{ micros }`. These tests run the statement run_sql
// builds on a real DuckDB and clone its rows the same way.
describe('run_sql values from a real DuckDB', () => {
  let instance: DuckDBInstance;
  let conn: DuckDBConnection;

  beforeAll(async () => {
    instance = await DuckDBInstance.create();
    conn = await instance.connect();
    // TIMESTAMPTZ values print in the session time zone.
    await conn.run("SET TimeZone = 'UTC'");
    await conn.run(`CREATE TABLE cost_base AS SELECT * FROM (VALUES
      (DATE '2026-01-02', 'EC2', 10.5::DOUBLE),
      (DATE '2026-01-05', 'S3', 2.25::DOUBLE)
    ) AS t(usage_date, service, cost)`);
  });

  afterAll(() => {
    conn.disconnectSync();
    instance.closeSync();
  });

  interface Rendered {
    /** The json output, parsed. */
    readonly json: unknown;
    /** Its rows, keyed by column. */
    readonly rows: readonly Readonly<Record<string, unknown>>[];
    /** The data rows of the markdown table, one trimmed string per cell. */
    readonly markdown: readonly (readonly string[])[];
    /** The data records of the csv output. */
    readonly csv: readonly (readonly (string | undefined)[])[];
  }

  async function render(sql: string): Promise<Rendered> {
    const { ctx } = harness({
      materialized: 'cost_base',
      respond: async (statement) => structuredClone(await fetchRows(conn, statement)),
    });
    const text = async (format: 'json' | 'markdown' | 'csv'): Promise<string> =>
      resultText(await runSql(ctx, { sql, dateRange: JAN, format }));
    const jsonText = await text('json');
    const table = markdownTables(await text('markdown'))[0];
    const csvLines = (await text('csv')).split('\n').filter(l => l.length > 0 && !isCsvComment(l));
    return {
      json: JSON.parse(jsonText),
      rows: parseJsonResult(jsonText).tables[0]?.rows ?? [],
      markdown: (table?.lines ?? []).slice(2).map(line => line.slice(1, -1).split('|').map(c => c.trim())),
      csv: csvLines.slice(1).map(line => parseCsvRecord(line) ?? []),
    };
  }

  /** The part of a json result that says each column's type. */
  interface ColumnTypes {
    readonly tables: readonly { readonly columns: readonly { readonly key: string; readonly type: string }[] }[];
  }

  function columnTypes(entries: readonly (readonly [key: string, type: 'number' | 'string'])[]): ColumnTypes {
    return { tables: [{ columns: entries.map(([key, type]) => ({ key, type })) }] };
  }

  it('returns the dates and decimals of the reported query', async () => {
    const out = await render('SELECT MIN(usage_date) AS d, 0.0732 AS dec, 1234.5 AS dec2, 0.0732::DOUBLE AS dbl FROM costs');
    expect(out.json).toMatchObject(columnTypes([['d', 'string'], ['dec', 'number'], ['dec2', 'number'], ['dbl', 'number']]));
    expect(out.rows).toEqual([{ d: '2026-01-02', dec: 0.0732, dec2: 1234.5, dbl: 0.0732 }]);
    expect(out.markdown).toEqual([['2026-01-02', '0.0732', '1234.5', '0.0732']]);
    expect(out.csv).toEqual([['2026-01-02', '0.0732', '1234.5', '0.0732']]);
  });

  it('keeps the dates of a daily series', async () => {
    const out = await render('SELECT usage_date, service, cost FROM costs ORDER BY usage_date');
    expect(out.rows).toEqual([
      { usage_date: '2026-01-02', service: 'EC2', cost: 10.5 },
      { usage_date: '2026-01-05', service: 'S3', cost: 2.25 },
    ]);
    expect(out.markdown).toEqual([['2026-01-02', 'EC2', '10.5'], ['2026-01-05', 'S3', '2.25']]);
  });

  // date_trunc on a DATE returns a TIMESTAMP: the usual monthly breakdown.
  it('prints dates, times and timestamps as DuckDB writes them', async () => {
    const out = await render(`SELECT DATE '2026-01-02' AS d, TIMESTAMP '2026-01-02 08:00:00.123456' AS ts,
      date_trunc('month', usage_date) AS month, TIMESTAMPTZ '2026-01-02 08:00:00+00' AS tstz,
      TIME '08:30:00' AS t, INTERVAL 1 DAY AS iv FROM costs ORDER BY usage_date LIMIT 1`);
    expect(out.json).toMatchObject(columnTypes([
      ['d', 'string'], ['ts', 'string'], ['month', 'string'], ['tstz', 'string'], ['t', 'string'], ['iv', 'string'],
    ]));
    const values = ['2026-01-02', '2026-01-02 08:00:00.123456', '2026-01-01 00:00:00', '2026-01-02 08:00:00+00', '08:30:00', '1 day'];
    expect(out.rows).toEqual([{ d: values[0], ts: values[1], month: values[2], tstz: values[3], t: values[4], iv: values[5] }]);
    expect(out.markdown).toEqual([values]);
    expect(out.csv).toEqual([values]);
  });

  // A double holds ~15 significant digits: wider values are rounded, as a
  // HUGEINT already was.
  it('returns DECIMAL and integer values as numbers', async () => {
    const wide = '12345678901234567890.1234567890';
    const huge = '170141183460469231731687303715884105727';
    const out = await render(`SELECT 0.0732 AS dec, ROUND(0.0732, 2) AS rounded, SUM(0.25) AS summed,
      CAST('${wide}' AS DECIMAL(38,10)) AS wide, ${huge}::HUGEINT AS huge, COUNT(*) AS n FROM costs`);
    expect(out.json).toMatchObject(columnTypes([
      ['dec', 'number'], ['rounded', 'number'], ['summed', 'number'], ['wide', 'number'], ['huge', 'number'], ['n', 'number'],
    ]));
    expect(out.rows).toEqual([{ dec: 0.0732, rounded: 0.07, summed: 0.5, wide: Number(wide), huge: Number(huge), n: 2 }]);
    const printed = ['0.0732', '0.07', '0.5', String(Number(wide)), String(Number(huge)), '2'];
    expect(out.markdown).toEqual([printed]);
    expect(out.csv).toEqual([printed]);
  });

  it('prints lists, structs and maps as JSON', async () => {
    const out = await render(`SELECT [1, 2, 3] AS list, {'a': 1, 'b': 'x'} AS struct, MAP {'k1': 1, 'k2': 2} AS map,
      [1.0, 'NaN'::DOUBLE] AS doubles`);
    expect(out.json).toMatchObject(columnTypes([['list', 'string'], ['struct', 'string'], ['map', 'string'], ['doubles', 'string']]));
    const values = ['[1,2,3]', '{"a":1,"b":"x"}', '{"k1":1,"k2":2}', '[1.0,NaN]'];
    expect(out.rows).toEqual([{ list: values[0], struct: values[1], map: values[2], doubles: values[3] }]);
    expect(out.markdown).toEqual([values]);
    expect(out.csv).toEqual([values]);
  });

  it('leaves NULL empty and keeps booleans and strings as they are', async () => {
    const out = await render(`SELECT NULL::DATE AS no_date, NULL::DECIMAL(5,2) AS no_dec, true AS flag,
      'he said "hi" \\ ok' AS quote, '' AS empty`);
    const values = ['', '', 'true', 'he said "hi" \\ ok', ''];
    expect(out.rows).toEqual([{ no_date: '', no_dec: '', flag: 'true', quote: values[3], empty: '' }]);
    expect(out.markdown).toEqual([values]);
    expect(out.csv).toEqual([values]);
  });

  it('types a numeric column whose first value is NULL as a number', async () => {
    const out = await render("SELECT CASE WHEN service = 'EC2' THEN NULL ELSE cost END AS c FROM costs ORDER BY usage_date");
    expect(out.json).toMatchObject(columnTypes([['c', 'number']]));
    expect(out.rows).toEqual([{ c: '' }, { c: 2.25 }]);
    expect(out.markdown).toEqual([[''], ['2.25']]);
  });

  // Markdown used to print a number column like a count: 0, 1.2k, 2.3M.
  it('prints every number exactly in markdown', async () => {
    const out = await render('SELECT 0.0732::DOUBLE AS small, 1234.5::DOUBLE AS mid, 2345678.91::DOUBLE AS big, -0.5::DOUBLE AS neg');
    expect(out.markdown).toEqual([['0.0732', '1234.5', '2345678.91', '-0.5']]);
  });
});
