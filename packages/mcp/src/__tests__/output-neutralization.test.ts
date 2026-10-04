import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadCostScope, loadDimensions, sqlStringLiteral } from '@costgoblin/core';
import type { DimensionsConfig } from '@costgoblin/core';
import type { McpContext } from '../context.js';
import { listBaselines, getBaselineDrift } from '../tools/baselines.js';
import { exploreData } from '../tools/explore-data.js';
import { getFilterValues } from '../tools/get-filter-values.js';
import { listDimensions } from '../tools/list-dimensions.js';
import { queryCosts } from '../tools/query-costs.js';
import { queryDailyCosts } from '../tools/query-daily-costs.js';
import { runSql } from '../tools/run-sql.js';
import { fetchRows, fetchRowsPrepared } from './helpers/duckdb-rows.js';
import {
  isCsvComment,
  markdownTables,
  parseCsvRecord,
  splitPhysicalLines,
  unescapedPipeCount,
} from './helpers/lines.js';

// #602 / VULN-002: billing and config values must not break the structure of
// markdown or csv tool output. Real tools, real DuckDB, a copy of the
// synthetic fixture whose `owner` tag carries the payloads.

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, '..', '..', '..', 'core', 'src', '__fixtures__');
const SYNTHETIC_DIR = join(FIXTURES_DIR, 'synthetic');
const CONFIG_DIR = join(FIXTURES_DIR, 'config');
const PROVIDER = 'aws-main';
const MONTH_DIR = join(PROVIDER, 'raw', 'daily-2026-01');
const JAN = { start: '2026-01-01', end: '2026-01-31' };

// Built with chr(): no single quotes and no raw break characters in the SQL.
const PIPE_SQL = `'bob ' || chr(124) || ' x'`;
const NEWLINE_SQL = `'alice' || chr(10) || '## Forged'`;
const LINE_SEP_SQL = `'carol' || chr(8232) || '## Forged too'`;
const PIPE = 'bob | x';
const NEWLINE = 'alice\n## Forged';
const LINE_SEP = `carol${String.fromCharCode(0x2028)}## Forged too`;

interface ToolText { readonly content: [{ type: 'text'; text: string }] }

function textOf(result: ToolText): string {
  return result.content[0].text;
}

function isErrorResult(result: ToolText): boolean {
  return 'isError' in result && result.isError === true;
}

/** No value started its own line, and every table row has the delimiter row's
 *  structural-pipe count. */
function expectIntactMarkdown(text: string): void {
  const lines = splitPhysicalLines(text);
  expect(lines.filter(l => l.startsWith('## Forged'))).toEqual([]);
  const tables = markdownTables(text);
  expect(tables.length).toBeGreaterThan(0);
  for (const table of tables) {
    for (const line of table.lines) {
      expect(line.startsWith('| '), line).toBe(true);
      expect(unescapedPipeCount(line), line).toBe(table.pipesPerLine);
    }
  }
}

/** Every physical line is a comment or one complete record of `fields` cells. */
function expectRealCsv(text: string, fields: number): void {
  const lines = splitPhysicalLines(text).filter(l => l !== '');
  const records = lines.filter(l => !isCsvComment(l));
  expect(records.length).toBeGreaterThan(1);
  for (const line of records) {
    const parsed = parseCsvRecord(line);
    expect(parsed, line).not.toBeNull();
    expect(parsed, line).toHaveLength(fields);
  }
}

describe('MCP output neutralization (DuckDB)', () => {
  let db: DuckDBInstance;
  let conn: DuckDBConnection;
  let dataDir: string;
  let stateDir: string;
  let dimensions: DimensionsConfig;
  let ctx: McpContext;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'cg-mcp-neutralize-'));
    stateDir = join(dataDir, 'state');
    await mkdir(join(dataDir, MONTH_DIR), { recursive: true });
    await mkdir(stateDir, { recursive: true });

    db = await DuckDBInstance.create();
    conn = await db.connect();
    const src = sqlStringLiteral(join(SYNTHETIC_DIR, MONTH_DIR, 'data.parquet'));
    const dst = sqlStringLiteral(join(dataDir, MONTH_DIR, 'data.parquet'));
    await conn.run(`
      COPY (
        SELECT * REPLACE (map_concat(Tags, MAP {'owner': CASE hash(ResourceId, ChargePeriodStart, ServiceName) % 4
          WHEN 0 THEN ${PIPE_SQL}
          WHEN 1 THEN ${NEWLINE_SQL}
          WHEN 2 THEN ${LINE_SEP_SQL}
          ELSE 'dave' END}) AS Tags)
        FROM read_parquet(${src})
      ) TO ${dst} (FORMAT parquet)
    `);

    const config = await loadConfig(join(CONFIG_DIR, 'costgoblin.yaml'));
    const costScope = await loadCostScope(join(CONFIG_DIR, 'cost-scope.yaml'));
    const base = await loadDimensions(join(CONFIG_DIR, 'dimensions.yaml'));
    // No normalize: the payloads must reach the output byte-for-byte.
    dimensions = { ...base, tags: [...base.tags, { tagName: 'owner', label: 'Owner' }] };

    ctx = {
      dataDir,
      stateDir,
      runQuery: (sql) => fetchRows(conn, sql),
      runPreparedQuery: (sql, params) => fetchRowsPrepared(conn, sql, params),
      getConfig: () => Promise.resolve(config),
      getDimensions: () => Promise.resolve(dimensions),
      getQueryDimensions: () => Promise.resolve(dimensions),
      getCostScope: () => Promise.resolve(costScope),
      getAccountMap: () => Promise.resolve(new Map<string, string>()),
      getAccountReverseMap: () => Promise.resolve(new Map<string, readonly string[]>()),
      getOrgAccountsPath: () => Promise.resolve(undefined),
      materializedBase: { getSource: () => undefined },
      warmup: () => Promise.resolve(),
    };
  }, 30_000);

  afterAll(async () => {
    conn.disconnectSync();
    db.closeSync();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('the payloads landed in the copied Parquet', async () => {
    const rows = await fetchRows(
      conn,
      `SELECT DISTINCT Tags['owner'] AS owner FROM read_parquet(${sqlStringLiteral(join(dataDir, MONTH_DIR, 'data.parquet'))})`,
    );
    const owners = rows.map(r => r['owner']);
    expect(owners).toEqual(expect.arrayContaining([PIPE, NEWLINE, LINE_SEP, 'dave']));
  });

  describe('markdown tables over tag_owner', () => {
    it('get_filter_values', async () => {
      const text = textOf(await getFilterValues(ctx, { dimensionId: 'tag_owner', dateRange: JAN }));
      expect(text).toContain('Forged');
      expectIntactMarkdown(text);
    });

    it('query_costs', async () => {
      const text = textOf(await queryCosts(ctx, { groupBy: 'tag_owner', dateRange: JAN }));
      expect(text).toContain('Forged');
      expectIntactMarkdown(text);
    });

    it('query_daily_costs (the groups are column headers)', async () => {
      const text = textOf(await queryDailyCosts(ctx, { groupBy: 'tag_owner', dateRange: { start: '2026-01-01', end: '2026-01-07' } }));
      expect(text).toContain('Forged');
      expectIntactMarkdown(text);
    });

    it('explore_data grouped by tag_owner', async () => {
      const text = textOf(await exploreData(ctx, { dateRange: JAN, groupByColumns: ['tag_owner'] }));
      expect(text).toContain('Forged');
      expectIntactMarkdown(text);
    });

    it('run_sql with a GROUP BY', async () => {
      const text = textOf(await runSql(ctx, {
        sql: 'SELECT tag_owner, SUM(cost) AS c FROM costs GROUP BY tag_owner ORDER BY tag_owner',
        dateRange: JAN,
      }));
      expect(text).toContain('Forged');
      expectIntactMarkdown(text);
    });

    it('run_sql with a PIVOT (the values are column names)', async () => {
      const text = textOf(await runSql(ctx, {
        sql: 'SELECT * FROM (PIVOT costs ON tag_owner USING sum(cost) GROUP BY service)',
        dateRange: JAN,
      }));
      expect(text).toContain('Forged');
      expectIntactMarkdown(text);
    });

    it('run_sql with a pipe in a column alias', async () => {
      const text = textOf(await runSql(ctx, { sql: 'SELECT 1 AS "a|b", 2 AS c', dateRange: JAN }));
      expect(text).toContain('a\\|b');
      expectIntactMarkdown(text);
    });
  });

  it('a query error echoing a multi-line value stays one line', async () => {
    const result = await runSql(ctx, {
      sql: "SELECT CAST(tag_owner AS INTEGER) FROM costs WHERE tag_owner LIKE '%Forged%'",
      dateRange: JAN,
    });
    expect(isErrorResult(result)).toBe(true);
    const text = textOf(result);
    expect(text).toContain('Forged');
    expect(splitPhysicalLines(text)).toHaveLength(1);
  });

  it('csv over tag_owner keeps one record per line', async () => {
    const text = textOf(await queryCosts(ctx, { groupBy: 'tag_owner', dateRange: JAN, format: 'csv' }));
    expect(text).toContain('Forged');
    const records = splitPhysicalLines(text).filter(l => l !== '' && !isCsvComment(l));
    const width = parseCsvRecord(records[0] ?? '')?.length ?? 0;
    expect(width).toBeGreaterThan(2);
    expectRealCsv(text, width);
  });

  it('list_dimensions keeps its table when a description spans lines', async () => {
    const withDescription: DimensionsConfig = {
      ...dimensions,
      tags: dimensions.tags.map(t => t.tagName === 'owner'
        ? { ...t, description: 'Who owns it.\n## Forged\n| x | y |' }
        : t),
    };
    const text = textOf(await listDimensions({ ...ctx, getDimensions: () => Promise.resolve(withDescription) }));
    expect(text).toContain('Forged');
    expectIntactMarkdown(text);
  });

  describe('baselines', () => {
    const hostileScope = 'bob | x\n## Forged';
    const SPEC_FIELDS = {
      basis: { costMetric: 'billed', rules: [] },
      basisSnapshotAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    beforeAll(async () => {
      await writeFile(join(stateDir, 'baselines.json'), JSON.stringify({
        // Valid specs (the tools hide any the desktop would): the payloads
        // ride in a built-in dimension's filter values and a view id.
        baselines: [
          { id: 'b1', source: 'discovered', scope: { kind: 'filter', filters: { service: [hostileScope, 'carol'] } }, ...SPEC_FIELDS },
          { id: 'b2', source: 'manual', scope: { kind: 'view', viewId: 'v|1\n## Forged view' }, ...SPEC_FIELDS },
        ],
      }));
      const history = Array.from({ length: 40 }, (_, i) => ({
        date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
        cost: 100 + i,
      }));
      await writeFile(join(stateDir, 'baselines-data.json'), JSON.stringify({
        history: { b1: history },
        snapshots: {
          b1: [
            { date: '2026-01-10', current: 120, status: 'over | x\n## Forged status' },
            { date: '2026-01-11', current: 121, status: 'in-band' },
          ],
        },
      }));
    });

    it('list_baselines markdown keeps its structure', async () => {
      const text = textOf(await listBaselines(ctx, {}));
      expect(text).toContain('Forged');
      expectIntactMarkdown(text);
    });

    it('list_baselines csv is real CSV', async () => {
      const text = textOf(await listBaselines(ctx, { format: 'csv' }));
      expect(text).toContain('Forged');
      expectRealCsv(text, 11);
    });

    it('list_baselines json uses the standard shape with the legacy field names as column keys', async () => {
      const parsed: unknown = JSON.parse(textOf(await listBaselines(ctx, { format: 'json' })));
      expect(parsed).toMatchObject({
        title: 'Cost baselines (2)',
        meta: [{ label: 'Total potential', type: 'currency' }],
        tables: [{
          columns: [
            { key: 'id' }, { key: 'name' }, { key: 'scope' }, { key: 'source' }, { key: 'status' },
            { key: 'currentPerDay', type: 'currency' }, { key: 'bandLowerPerDay', type: 'currency' },
            { key: 'bandUpperPerDay', type: 'currency' }, { key: 'potentialPerMonth', type: 'currency' },
            { key: 'realizedPerMonth', type: 'currency' }, { key: 'dataPoints', type: 'number' },
          ],
        }],
      });
      // JSON stays exact: the raw scope value is not escaped.
      expect(JSON.stringify(parsed)).toContain(JSON.stringify(`service=${hostileScope},carol`));
    });

    it('get_baseline_drift markdown keeps its structure', async () => {
      const text = textOf(await getBaselineDrift(ctx, { id: 'b1' }));
      expect(text).toContain('Forged');
      expectIntactMarkdown(text);
    });

    it('get_baseline_drift csv is real CSV', async () => {
      const text = textOf(await getBaselineDrift(ctx, { id: 'b1', format: 'csv' }));
      expect(text).toContain('Forged');
      expectRealCsv(text, 3);
    });

    it('get_baseline_drift without snapshots says so in a note', async () => {
      const text = textOf(await getBaselineDrift(ctx, { id: 'b2' }));
      expect(text).toContain('_No snapshot history yet._');
      expect(splitPhysicalLines(text).filter(l => l.startsWith('## Forged'))).toEqual([]);
    });
  });
});
