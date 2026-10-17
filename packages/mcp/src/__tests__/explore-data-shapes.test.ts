import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asBucketPath, asProviderName, tagDimColumn, tagSqlColumn } from '@costgoblin/core';
import type { CostGoblinConfig, CostScopeConfig, DimensionsConfig } from '@costgoblin/core';
import type { McpContext, RawRow } from '../context.js';
import { exploreData } from '../tools/explore-data.js';
import { parseJsonResult, resultText } from './helpers/json-result.js';

// explore_data's SQL shape for the rollup vs Parquet sources and each sort
// mode, and how its rows are shaped — with scripted query results (the
// DuckDB-backed behaviour is covered in explore-data.test.ts).

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
  readonly prepared: { readonly sql: string; readonly params: readonly unknown[] }[];
}

function harness(opts: {
  rows?: RawRow[];
  materialized?: string;
  costScope?: () => Promise<CostScopeConfig>;
} = {}): Harness {
  const prepared: { sql: string; params: readonly unknown[] }[] = [];
  const unused = (): never => { throw new Error('not used by explore_data'); };
  const ctx: McpContext = {
    dataDir,
    stateDir: root,
    runQuery: () => Promise.resolve([{ d: '2026-02-20' }]),
    runPreparedQuery: (sql, params) => {
      prepared.push({ sql, params });
      return Promise.resolve(opts.rows ?? []);
    },
    getConfig: () => Promise.resolve(CONFIG),
    getDimensions: unused,
    getQueryDimensions: () => Promise.resolve(DIMENSIONS),
    getCostScope: opts.costScope ?? (() => Promise.resolve({ costMetric: 'billed', rules: [] })),
    getAccountMap: unused,
    getAccountReverseMap: () => Promise.resolve(new Map<string, readonly string[]>()),
    getOrgAccountsPath: () => Promise.resolve(undefined),
    materializedBase: { getSource: () => opts.materialized },
    warmup: () => Promise.resolve(),
    now: () => NOW,
  };
  return { ctx, prepared };
}

function onlySql(h: Harness): string {
  expect(h.prepared).toHaveLength(1);
  return h.prepared[0]?.sql ?? '';
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'cg-mcp-explore-'));
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

describe('explore_data range and source', () => {
  it('defaults to the 30 days ending at the default lag and a limit of 50', async () => {
    const h = harness();
    const result = parseJsonResult(resultText(await exploreData(h.ctx, { format: 'json' })));
    expect(result.title).toBe('Raw Data (2026-01-25 to 2026-02-23)');
    expect(h.prepared[0]?.params).toEqual(['2026-01-25', '2026-02-23', 50]);
  });

  it('answers with the coverage note when no month is synced in range', async () => {
    const h = harness();
    const result = parseJsonResult(resultText(await exploreData(h.ctx, {
      dateRange: { start: '2025-06-01', end: '2025-06-30' }, format: 'json',
    })));
    expect(result.title).toBe('Explore Data (2025-06-01 to 2025-06-30)');
    expect(result.notes).toEqual([
      '*No data available for the requested range 2025-06-01 to 2025-06-30. See coverage banner above for what is available.*',
    ]);
    expect(h.prepared).toEqual([]);
  });

  it('reads the slim rollup when it covers the range: no list_cost or usage_amount', async () => {
    const grouped = harness({ materialized: 'cost_base' });
    await exploreData(grouped.ctx, { dateRange: JAN, groupByColumns: ['service'] });
    const groupedSql = onlySql(grouped);
    expect(groupedSql).toContain('FROM cost_base');
    expect(groupedSql).not.toContain('list_cost');
    expect(groupedSql).not.toContain('usage_amount');

    const raw = harness({ materialized: 'cost_base' });
    await exploreData(raw.ctx, { dateRange: JAN });
    const rawSql = onlySql(raw);
    expect(rawSql).toContain('FROM cost_base');
    expect(rawSql).not.toContain('list_cost');
  });

  it('aggregates list_cost and usage_amount from Parquet, with the effective metric when the Cost Scope fails', async () => {
    const h = harness({ costScope: () => Promise.reject(new Error('unreadable')) });
    await exploreData(h.ctx, { dateRange: JAN, groupByColumns: ['service'] });
    const sql = onlySql(h);
    expect(sql).toContain('CAST(SUM(list_cost) AS DOUBLE) AS list_cost');
    expect(sql).toContain('CAST(SUM(usage_amount) AS DOUBLE) AS usage_amount');
    expect(sql).toContain('COALESCE(EffectiveCost, 0) AS cost');
  });
});

describe('explore_data sorting', () => {
  it.each([
    ['grouped, by cost ascending', { groupByColumns: ['service'], sort: { column: 'cost', direction: 'asc' } }, 'ORDER BY SUM(cost) ASC'],
    ['grouped, by a grouped column descending', { groupByColumns: ['service'], sort: { column: 'service', direction: 'desc' } }, 'ORDER BY service DESC'],
    ['grouped, by an unknown column', { groupByColumns: ['service'], sort: { column: 'nope', direction: 'asc' } }, 'ORDER BY SUM(cost) DESC'],
    ['raw, by an allowed column ascending', { sort: { column: 'usage_date', direction: 'asc' } }, 'ORDER BY usage_date ASC'],
    ['raw, by cost descending', { sort: { column: 'cost', direction: 'desc' } }, 'ORDER BY cost DESC'],
    ['raw, by an unknown column', { sort: { column: 'nope; DROP', direction: 'asc' } }, 'ORDER BY ABS(cost) DESC'],
  ] as const)('%s', async (_label, extra, orderBy) => {
    const h = harness();
    await exploreData(h.ctx, { dateRange: JAN, ...extra });
    expect(onlySql(h)).toContain(orderBy);
  });

  it('groups by the usage date as text', async () => {
    const h = harness({ rows: [{ usage_date: '2026-01-02', cost: 4, row_count: 2n }] });
    const result = parseJsonResult(resultText(await exploreData(h.ctx, { dateRange: JAN, groupByColumns: ['usage_date'], format: 'json' })));
    expect(onlySql(h)).toContain('usage_date::VARCHAR AS usage_date');
    expect(result.meta.get('Group By')).toBe('usage_date');
    expect(result.tables[0]?.rows).toEqual([{ usage_date: '2026-01-02', cost: 4, row_count: 2 }]);
  });
});

describe('explore_data column names', () => {
  it('resolves a name that is one tag\'s SQL column and another tag\'s id to the SQL column', async () => {
    // A tag keyed `team_<hash of team>` has the id `tag_team_<hash>`: exactly
    // the SQL column of the `team` tag. The SQL column keeps the name.
    const team = { tagName: 'team', label: 'Team' };
    const column = tagSqlColumn(team);
    const lookalike = { tagName: column.slice('tag_'.length), label: 'Lookalike' };
    expect(tagDimColumn(lookalike)).toBe(column);
    const h = harness();
    const ctx: McpContext = { ...h.ctx, getQueryDimensions: () => Promise.resolve({ builtIn: [], tags: [team, lookalike] }) };
    await exploreData(ctx, { dateRange: JAN, groupByColumns: [column] });
    expect(onlySql(h)).toContain(`GROUP BY ${column}\n`);
    expect(onlySql(h)).not.toContain(`GROUP BY ${tagSqlColumn(lookalike)}`);
  });
});

describe('explore_data raw rows', () => {
  it('falls back to the account id and shortens long resource ids', async () => {
    const longId = `arn:aws:ec2:eu-west-1:111:instance/${'i'.repeat(20)}`;
    const h = harness({
      rows: [
        { usage_date: '2026-01-02', account_id: '111', account_name: '', service: 'EC2', resource_id: longId, cost: 3 },
        { usage_date: '2026-01-03', account_id: '222', account_name: 'Prod', service: 'S3', resource_id: 'bucket-a', cost: 1 },
      ],
    });
    const result = parseJsonResult(resultText(await exploreData(h.ctx, { dateRange: JAN, format: 'json' })));
    expect(result.meta.get('Showing')).toBe('2 rows (sorted by |cost|)');
    expect(result.tables[0]?.rows).toEqual([
      { date: '2026-01-02', account: '111', service: 'EC2', resource: `${longId.slice(0, 27)}...`, cost: 3 },
      { date: '2026-01-03', account: 'Prod', service: 'S3', resource: 'bucket-a', cost: 1 },
    ]);
  });
});
