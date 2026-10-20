import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asBucketPath, asDimensionId, asProviderName, DEFAULT_PLACEHOLDER_PATTERNS } from '@costgoblin/core';
import type { CostGoblinConfig, CostScopeConfig, DimensionsConfig } from '@costgoblin/core';
import type { McpContext, RawRow } from '../context.js';
import { getCostOverview } from '../tools/get-cost-overview.js';
import { getFilterValues } from '../tools/get-filter-values.js';
import { listDimensions } from '../tools/list-dimensions.js';
import { queryCosts } from '../tools/query-costs.js';
import { queryDailyCosts } from '../tools/query-daily-costs.js';
import { queryEntityDetail } from '../tools/query-entity-detail.js';
import { queryMissingTags } from '../tools/query-missing-tags.js';
import { queryTrends } from '../tools/query-trends.js';
import { parseJsonResult, resultText } from './helpers/json-result.js';
import type { JsonResult } from './helpers/json-result.js';

// How each query tool turns the rows DuckDB returns into its result: totals,
// shares, account-name resolution, truncation, weekly bucketing and the
// empty-range / no-data answers. The SQL itself is core's (and covered there);
// here runPreparedQuery returns canned rows so every shaping branch is reachable.

const NOW = Date.UTC(2026, 1, 25, 12);
/** defaultDateRange(NOW): the 30 days ending 2 days (the default lag) before NOW. */
const DEFAULT_RANGE = { start: '2026-01-25', end: '2026-02-23' };
const JAN = { start: '2026-01-01', end: '2026-01-31' };
const UNSYNCED = { start: '2025-06-01', end: '2025-06-30' };

const CONFIG: CostGoblinConfig = {
  providers: [{
    name: asProviderName('aws'), type: 'aws', credentialsProfile: 'default',
    sync: { daily: { bucket: asBucketPath('s3://b/d'), retentionDays: 90 }, intervalMinutes: 60 },
  }],
  defaults: { periodDays: 30, costMetric: 'effective', lagDays: 2 },
};

const DIMENSIONS: DimensionsConfig = {
  builtIn: [
    { name: asDimensionId('account'), label: 'Account', field: 'account_id', displayField: 'account_name' },
    { name: asDimensionId('account_id'), label: 'Account ID', field: 'account_id' },
    { name: asDimensionId('service'), label: 'Service', field: 'service', description: 'Cloud service' },
    { name: asDimensionId('region'), label: 'Region', field: 'region', enabled: false },
  ],
  tags: [
    { tagName: 'team', label: 'Team', concept: 'owner', description: 'Owning team' },
    { tagName: 'env', label: 'Environment', enabled: false },
  ],
};

const COST_SCOPE: CostScopeConfig = { costMetric: 'effective', rules: [] };

interface Harness {
  readonly ctx: McpContext;
  readonly prepared: { readonly sql: string; readonly params: readonly unknown[] }[];
}

let root: string;
let dataDir: string;
let emptyDataDir: string;

function harness(opts: {
  rows?: (sql: string) => RawRow[];
  accountMap?: ReadonlyMap<string, string>;
  accountReverseMap?: ReadonlyMap<string, readonly string[]>;
  dataDir?: string;
} = {}): Harness {
  const prepared: { sql: string; params: readonly unknown[] }[] = [];
  const ctx: McpContext = {
    dataDir: opts.dataDir ?? dataDir,
    stateDir: root,
    // Only computeDataCoverage's latest-day probe goes through runQuery here.
    runQuery: () => Promise.resolve([{ d: '2026-02-20' }]),
    runPreparedQuery: (sql, params) => {
      prepared.push({ sql, params });
      return Promise.resolve(opts.rows?.(sql) ?? []);
    },
    getConfig: () => Promise.resolve(CONFIG),
    getDimensions: () => Promise.resolve(DIMENSIONS),
    getQueryDimensions: () => Promise.resolve(DIMENSIONS),
    getCostScope: () => Promise.resolve(COST_SCOPE),
    getAccountMap: () => Promise.resolve(new Map(opts.accountMap ?? [])),
    getAccountReverseMap: () => Promise.resolve(new Map(opts.accountReverseMap ?? [])),
    getOrgAccountsPath: () => Promise.resolve(undefined),
    materializedBase: { getSource: () => undefined },
    warmup: () => Promise.resolve(),
    now: () => NOW,
  };
  return { ctx, prepared };
}

function json(result: { content: [{ type: 'text'; text: string }] }): JsonResult {
  return parseJsonResult(resultText(result));
}

function tableRows(result: JsonResult, title: string): readonly Readonly<Record<string, unknown>>[] {
  const table = result.tables.find(t => t.title === title);
  if (table === undefined) throw new Error(`no table "${title}"; have ${JSON.stringify(result.tables.map(t => t.title))}`);
  return table.rows;
}

const emptyRangeNote = (r: { start: string; end: string }): string =>
  `*No data available for the requested range ${r.start} to ${r.end}. See coverage banner above for what is available.*`;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'cg-mcp-shaping-'));
  dataDir = join(root, 'data');
  emptyDataDir = join(root, 'empty');
  // listLocalMonths only needs a .parquet file per month dir; the rows are canned.
  for (const month of ['2026-01', '2026-02']) {
    const dir = join(dataDir, 'aws', 'raw', `daily-${month}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'data.parquet'), '');
  }
  await mkdir(emptyDataDir, { recursive: true });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('every query tool on a range with no synced month', () => {
  it.each([
    ['query_costs', (ctx: McpContext) => queryCosts(ctx, { groupBy: 'service', dateRange: UNSYNCED, format: 'json' }), 'Costs by service (2025-06-01 to 2025-06-30)'],
    ['query_daily_costs', (ctx: McpContext) => queryDailyCosts(ctx, { dateRange: UNSYNCED, format: 'json' }), 'Daily Costs (2025-06-01 to 2025-06-30)'],
    ['query_trends', (ctx: McpContext) => queryTrends(ctx, { groupBy: 'service', dateRange: UNSYNCED, format: 'json' }), 'Cost Trends (2025-06-01 to 2025-06-30)'],
    ['query_entity_detail', (ctx: McpContext) => queryEntityDetail(ctx, { entity: 'EC2', dimension: 'service', dateRange: UNSYNCED, format: 'json' }), 'EC2 (2025-06-01 to 2025-06-30)'],
    ['query_missing_tags', (ctx: McpContext) => queryMissingTags(ctx, { tagDimension: 'tag_team', dateRange: UNSYNCED, format: 'json' }), 'Missing Tags: tag_team (2025-06-01 to 2025-06-30)'],
    ['get_filter_values', (ctx: McpContext) => getFilterValues(ctx, { dimensionId: 'service', dateRange: UNSYNCED, format: 'json' }), 'Service Values (2025-06-01 to 2025-06-30)'],
    ['get_cost_overview', (ctx: McpContext) => getCostOverview(ctx, { dateRange: UNSYNCED, format: 'json' }), 'Cost Overview (2025-06-01 to 2025-06-30)'],
  ])('%s says the range has no data and runs no query', async (_name, run, title) => {
    const { ctx, prepared } = harness();
    const result = json(await run(ctx));
    expect(result.title).toBe(title);
    expect(result.notes).toEqual([emptyRangeNote(UNSYNCED)]);
    expect(result.coverage).toMatchObject({ availableMonths: ['2026-01', '2026-02'], missingInRange: ['2025-06'] });
    expect(prepared).toEqual([]);
  });
});

describe('get_cost_overview', () => {
  it('reports an error when no provider has synced data', async () => {
    const { ctx } = harness({ dataDir: emptyDataDir });
    expect(await getCostOverview(ctx, { dateRange: JAN })).toEqual({
      content: [{ type: 'text', text: 'Error: No data found. Ensure COSTGOBLIN_DATA_DIR points to a directory with synced Parquet data.' }],
      isError: true,
    });
  });

  it('keeps the first row per service, merges accounts by display name and lists enabled dimensions', async () => {
    const { ctx } = harness({
      accountMap: new Map([['111', 'Prod'], ['222', 'Prod']]),
      rows: (sql) => sql.includes('account_id AS entity')
        ? [{ entity: '111', total_cost: 70 }, { entity: '222', total_cost: 30 }, { entity: '333', total_cost: 5 }]
        // The cost query returns one row per (entity, top service): only the
        // first carries the entity total that is kept.
        : [{ entity: 'EC2', total_cost: 60 }, { entity: 'EC2', total_cost: 999 }, { entity: 'S3', total_cost: 40 }],
    });
    const result = json(await getCostOverview(ctx, { format: 'json' }));
    expect(result.title).toBe(`Cost Overview (${DEFAULT_RANGE.start} to ${DEFAULT_RANGE.end})`);
    expect(Object.fromEntries(result.meta)).toEqual({
      'Total Cost': 100,
      'Available Dimensions': 'account, account_id, service, Team',
    });
    expect(tableRows(result, 'Top Services')).toEqual([
      { service: 'EC2', cost: 60, pct: 60 },
      { service: 'S3', cost: 40, pct: 40 },
    ]);
    expect(tableRows(result, 'Top Accounts')).toEqual([
      { account: 'Prod', cost: 100 },
      { account: '333', cost: 5 },
    ]);
  });

  it('shows 0% shares for a zero total and drops the accounts table when there are none', async () => {
    const { ctx } = harness({
      rows: (sql) => (sql.includes('account_id AS entity') ? [] : [{ entity: 'EC2', total_cost: 0 }]),
    });
    const result = json(await getCostOverview(ctx, { dateRange: JAN, format: 'json' }));
    expect(result.tables.map(t => t.title)).toEqual(['Top Services']);
    expect(tableRows(result, 'Top Services')).toEqual([{ service: 'EC2', cost: 0, pct: 0 }]);
  });
});

describe('query_entity_detail', () => {
  /** `count` consecutive days from 2026-01-01. */
  function dayRows(count: number, row: (i: number) => Record<string, unknown>): RawRow[] {
    return Array.from({ length: count }, (_, i) => ({
      usage_date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
      ...row(i),
    }));
  }

  it('switches to a weekly trend past 31 days and omits the account table for a single account', async () => {
    const { ctx } = harness({
      rows: () => dayRows(40, i => ({ service: i % 2 === 0 ? 'EC2' : 'S3', account_id: '111', cost: 1 })),
    });
    const result = json(await queryEntityDetail(ctx, {
      entity: 'Team A', dimension: 'tag_team', dateRange: { start: '2026-01-01', end: '2026-02-09' }, format: 'json',
    }));
    expect(result.title).toBe('Team A (Team)');
    expect(result.meta.get('Total Cost')).toBe(40);
    expect(result.tables.map(t => t.title)).toEqual(['Service Breakdown', 'Weekly Trend']);
    expect(tableRows(result, 'Service Breakdown')).toEqual([
      { service: 'EC2', cost: 20, pct: 50 },
      { service: 'S3', cost: 20, pct: 50 },
    ]);
    // 2026-01-01 is a Thursday: its week starts Monday 2025-12-29.
    expect(tableRows(result, 'Weekly Trend')).toEqual([
      { week: 'w/2025-12-29', cost: 4 },
      { week: 'w/2026-01-05', cost: 7 },
      { week: 'w/2026-01-12', cost: 7 },
      { week: 'w/2026-01-19', cost: 7 },
      { week: 'w/2026-01-26', cost: 7 },
      { week: 'w/2026-02-02', cost: 7 },
      { week: 'w/2026-02-09', cost: 1 },
    ]);
  });

  it('keeps a daily trend up to 31 days, names accounts, and shows 0% shares for a zero total', async () => {
    const { ctx } = harness({
      accountMap: new Map([['111', 'Prod']]),
      rows: () => [
        { usage_date: '2026-01-02', service: 'EC2', account_id: '111', cost: 0 },
        { usage_date: '2026-01-01', service: 'EC2', account_id: '222', cost: 0 },
        { usage_date: '2026-01-02', service: 'S3', account_id: '222', cost: 0 },
      ],
    });
    const result = json(await queryEntityDetail(ctx, { entity: 'EC2', dimension: 'service', dateRange: JAN, format: 'json' }));
    expect(result.tables.map(t => t.title)).toEqual(['Service Breakdown', 'Account Breakdown', 'Daily Trend']);
    expect(tableRows(result, 'Service Breakdown')).toEqual([
      { service: 'EC2', cost: 0, pct: 0 },
      { service: 'S3', cost: 0, pct: 0 },
    ]);
    expect(tableRows(result, 'Account Breakdown')).toEqual([
      { account: 'Prod', cost: 0, pct: 0 },
      { account: '222', cost: 0, pct: 0 },
    ]);
    expect(tableRows(result, 'Daily Trend')).toEqual([
      { date: '2026-01-01', cost: 0 },
      { date: '2026-01-02', cost: 0 },
    ]);
  });

  it('returns only the totals when the entity has no rows, over the default range', async () => {
    const { ctx, prepared } = harness();
    const result = json(await queryEntityDetail(ctx, { entity: 'nobody', dimension: 'service', format: 'json' }));
    expect(result.tables).toEqual([]);
    expect(Object.fromEntries(result.meta)).toEqual({
      'Period': `${DEFAULT_RANGE.start} to ${DEFAULT_RANGE.end}`,
      'Total Cost': 0,
    });
    expect(prepared[0]?.params).toEqual(expect.arrayContaining([DEFAULT_RANGE.start, DEFAULT_RANGE.end, 'nobody']));
  });
});

describe('query_trends', () => {
  const ROWS: RawRow[] = [
    { entity: '111', current_cost: 150, previous_cost: 100, delta: 50, percent_change: 50 },
    { entity: '222', current_cost: 50, previous_cost: 100, delta: -50, percent_change: -50 },
    // Under the $1 default delta threshold.
    { entity: '333', current_cost: 100.5, previous_cost: 100, delta: 0.5, percent_change: 0.5 },
    // Over the delta threshold, under the 5% default change threshold.
    { entity: '444', current_cost: 2000, previous_cost: 1990, delta: 10, percent_change: 0.5 },
    { entity: '555', current_cost: 300, previous_cost: 100, delta: 200, percent_change: 200 },
  ];

  it.each(['account', 'account_id'])('ranks increases and savings past both thresholds and names accounts (groupBy=%s)', async (groupBy) => {
    const { ctx } = harness({ accountMap: new Map([['111', 'Prod']]), rows: () => ROWS });
    const result = json(await queryTrends(ctx, { groupBy, dateRange: JAN, limit: 1, format: 'json' }));
    expect(result.notes).toEqual([]);
    expect(result.tables.map(t => t.title)).toEqual(['Top Increases ($250 total)', 'Top Savings ($50.00 total)']);
    expect(tableRows(result, 'Top Increases ($250 total)')).toEqual([
      { entity: '555', current: 300, previous: 100, delta: 200, change: 200 },
    ]);
    // limit 1 hides the smaller increase (Prod, +$50) behind a footer.
    expect(result.tables[0]?.footer).toBe('*...and 1 more totaling $50.00*');
    expect(tableRows(result, 'Top Savings ($50.00 total)')).toEqual([
      { entity: '222', current: 50, previous: 100, delta: -50, change: -50 },
    ]);
    expect(result.tables[1]?.footer).toBeUndefined();
  });

  it('does not resolve account names for other dimensions', async () => {
    const { ctx } = harness({ accountMap: new Map([['111', 'Prod']]), rows: () => ROWS });
    const result = json(await queryTrends(ctx, { groupBy: 'service', dateRange: JAN, format: 'json' }));
    expect(result.title).toBe('Cost Trends by Service (2026-01-01 to 2026-01-31)');
    expect(tableRows(result, 'Top Increases ($250 total)').map(r => r['entity'])).toEqual(['555', '111']);
  });

  it('notes when nothing moved enough, over the default range', async () => {
    const { ctx, prepared } = harness({ rows: () => [ROWS[2] ?? {}] });
    const result = json(await queryTrends(ctx, { groupBy: 'service', format: 'json' }));
    expect(result.title).toBe(`Cost Trends by Service (${DEFAULT_RANGE.start} to ${DEFAULT_RANGE.end})`);
    expect(result.tables).toEqual([]);
    expect(result.notes).toEqual(['*No significant increases found.*', '*No significant savings found.*']);
    expect(prepared[0]?.params).toEqual(expect.arrayContaining([DEFAULT_RANGE.start, DEFAULT_RANGE.end, 1]));
  });

  it('applies caller thresholds', async () => {
    const { ctx, prepared } = harness({ rows: () => ROWS });
    const result = json(await queryTrends(ctx, {
      groupBy: 'service', dateRange: JAN, deltaThreshold: 100, percentThreshold: 0, format: 'json',
    }));
    // Only the +$200 change clears a $100 threshold.
    expect(result.tables.map(t => t.title)).toEqual(['Top Increases ($200 total)']);
    expect(result.notes).toEqual(['*No significant savings found.*']);
    expect(prepared[0]?.params).toContain(100);
  });
});

describe('query_missing_tags', () => {
  const LONG_ARN = `arn:aws:s3:::${'x'.repeat(40)}`;
  const RESOURCE_ROWS: RawRow[] = [
    { account_id: '111', account_name: 'raw name', resource_id: 'i-1', service: 'EC2', cost: 50, bucket: 'actionable' },
    { account_id: '', account_name: 'Shared', resource_id: LONG_ARN, service: 'S3', cost: 20, bucket: 'actionable' },
    // Counted, but under the $10 default threshold for the table.
    { account_id: '222', account_name: '', resource_id: 'i-small', service: 'EC2', cost: 5, bucket: 'actionable' },
    { account_id: '333', account_name: '', resource_id: 'tax-1', service: 'Tax', cost: 7, bucket: 'likely-untaggable' },
  ];

  function rows(resources: RawRow[]): (sql: string) => RawRow[] {
    return (sql) => (sql.includes('category_coverage') ? resources : [{ cost: 3 }, { cost: 4.5 }]);
  }

  it('splits actionable from likely-untaggable cost and lists the actionable resources over the threshold', async () => {
    const { ctx } = harness({ accountMap: new Map([['111', 'Prod']]), rows: rows(RESOURCE_ROWS) });
    const result = json(await queryMissingTags(ctx, { tagDimension: 'tag_team', dateRange: JAN, format: 'json' }));
    expect(Object.fromEntries(result.meta)).toEqual({
      'Actionable Resources': 3,
      'Actionable Cost': 75,
      'Likely Untaggable Resources': 1,
      'Likely Untaggable Cost': 7,
      'Non-Resource Cost': 7.5,
      'Placeholder Patterns Treated As Missing': DEFAULT_PLACEHOLDER_PATTERNS.join(', '),
    });
    expect(result.notes).toEqual([]);
    expect(tableRows(result, 'Top Actionable Untagged Resources')).toEqual([
      { account: 'Prod', service: 'EC2', resource: 'i-1', cost: 50 },
      // No account id: the row's own account name; a long id is cut to 37 chars + "...".
      { account: 'Shared', service: 'S3', resource: `${LONG_ARN.slice(0, 37)}...`, cost: 20 },
    ]);
  });

  it('honours minCost and limit', async () => {
    const { ctx } = harness({ rows: rows(RESOURCE_ROWS) });
    const result = json(await queryMissingTags(ctx, { tagDimension: 'tag_team', dateRange: JAN, minCost: 1, limit: 2, format: 'json' }));
    const table = result.tables[0];
    // A $1 threshold lets the $5 resource in; limit 2 then hides it behind the footer.
    expect(table?.rows.map(r => r['resource'])).toEqual(['i-1', `${LONG_ARN.slice(0, 37)}...`]);
    expect(table?.footer).toBe('*...and 1 more totaling $5.00*');
  });

  it('notes when no actionable resource clears the threshold, over the default range', async () => {
    const { ctx } = harness({ rows: rows([RESOURCE_ROWS[3] ?? {}]) });
    const result = json(await queryMissingTags(ctx, { tagDimension: 'tag_team', format: 'json' }));
    expect(result.title).toBe(`Missing Tags: tag_team (${DEFAULT_RANGE.start} to ${DEFAULT_RANGE.end})`);
    expect(result.tables).toEqual([]);
    expect(result.notes).toEqual(['*No actionable untagged resources above the cost threshold.*']);
  });
});

describe('query_costs', () => {
  it('builds per-entity rows with top-service columns, shares and account names', async () => {
    const { ctx } = harness({
      accountMap: new Map([['111', 'Prod']]),
      rows: () => [
        { entity: '111', total_cost: 80, service: 'EC2', service_cost: 60 },
        { entity: '111', total_cost: 80, service: 'S3', service_cost: 20 },
        // No top service for this entity (LEFT JOIN miss): a null service.
        { entity: '222', total_cost: 20, service: null, service_cost: 0 },
        { entity: '333', total_cost: 0, service: '', service_cost: 0 },
      ],
    });
    const result = json(await queryCosts(ctx, { groupBy: 'account', dateRange: JAN, limit: 2, format: 'json' }));
    expect(result.title).toBe('Costs by Account (2026-01-01 to 2026-01-31)');
    expect(result.meta.get('Total')).toBe(100);
    expect(result.tables[0]?.columnKeys).toEqual(['entity', 'cost', 'pct', 'svc_EC2', 'svc_S3']);
    expect(result.tables[0]?.rows).toEqual([
      { entity: 'Prod', cost: 80, pct: 80, svc_EC2: 60, svc_S3: 20 },
      { entity: '222', cost: 20, pct: 20, svc_EC2: 0, svc_S3: 0 },
    ]);
    expect(result.tables[0]?.footer).toBe('*...and 1 more totaling $0.0000*');
  });

  it('merges the accounts that share a display name into one row, as get_cost_overview does', async () => {
    const { ctx } = harness({
      accountMap: new Map([['111', 'Prod'], ['222', 'Prod']]),
      rows: () => [
        { entity: '111', total_cost: 70, service: 'EC2', service_cost: 50 },
        { entity: '111', total_cost: 70, service: 'S3', service_cost: 20 },
        { entity: '333', total_cost: 40, service: 'EC2', service_cost: 40 },
        { entity: '222', total_cost: 30, service: 'EC2', service_cost: 30 },
      ],
    });
    const result = json(await queryCosts(ctx, { groupBy: 'account', dateRange: JAN, format: 'json' }));
    expect(result.tables[0]?.rows).toEqual([
      { entity: 'Prod', cost: 100, pct: (100 / 140) * 100, svc_EC2: 80, svc_S3: 20 },
      { entity: '333', cost: 40, pct: (40 / 140) * 100, svc_EC2: 40, svc_S3: 0 },
    ]);
    expect(result.meta.get('Total')).toBe(140);
  });

  it('shows 0% shares when every entity costs nothing, over the default range', async () => {
    const { ctx, prepared } = harness({ rows: () => [{ entity: 'EC2', total_cost: 0, service: 'EC2', service_cost: 0 }] });
    const result = json(await queryCosts(ctx, { groupBy: 'service', format: 'json' }));
    expect(result.tables[0]?.rows).toEqual([{ entity: 'EC2', cost: 0, pct: 0, svc_EC2: 0 }]);
    expect(prepared[0]?.params).toEqual(expect.arrayContaining([DEFAULT_RANGE.start, DEFAULT_RANGE.end]));
  });
});

describe('query_daily_costs', () => {
  it('defaults to grouping by service over the default (weekly) range', async () => {
    const { ctx } = harness({
      rows: () => [
        { date: '2026-01-26', group_name: 'EC2', cost: 5 },
        { date: '2026-01-27', group_name: 'EC2', cost: 5 },
        { date: '2026-01-27', group_name: 'S3', cost: 2 },
        // A NULL group lands in the '' bucket.
        { date: '2026-02-02', group_name: null, cost: 1 },
      ],
    });
    const result = json(await queryDailyCosts(ctx, { format: 'json' }));
    expect(result.title).toBe(`Weekly Costs by Service (${DEFAULT_RANGE.start} to ${DEFAULT_RANGE.end})`);
    expect(result.tables[0]?.columnKeys).toEqual(['date', 'total', 'grp_EC2', 'grp_S3', 'grp_']);
    expect(result.tables[0]?.rows).toEqual([
      { date: 'w/2026-01-26', total: 12, grp_EC2: 10, grp_S3: 2, grp_: 0 },
      { date: 'w/2026-02-02', total: 1, grp_EC2: 0, grp_S3: 0, grp_: 1 },
    ]);
  });

  it('keeps daily rows for a window of 14 days or less', async () => {
    const { ctx } = harness({
      rows: () => [
        { date: '2026-01-02', group_name: 'EC2', cost: 3 },
        { date: '2026-01-01', group_name: 'EC2', cost: 1 },
        { date: '2026-01-01', group_name: 'EC2', cost: 1 },
      ],
    });
    const result = json(await queryDailyCosts(ctx, { groupBy: 'service', dateRange: { start: '2026-01-01', end: '2026-01-14' }, format: 'json' }));
    expect(result.title).toBe('Daily Costs by Service (2026-01-01 to 2026-01-14)');
    expect(result.tables[0]?.rows).toEqual([
      { date: '2026-01-01', total: 2, grp_EC2: 2 },
      { date: '2026-01-02', total: 3, grp_EC2: 3 },
    ]);
  });

  it('names accounts as get_cost_overview does, summing the ids that share a name on each day', async () => {
    const accountMap = new Map([['111', 'Prod'], ['222', 'Prod']]);
    const { ctx } = harness({
      accountMap,
      rows: (sql) => sql.includes('AS group_name')
        ? [
            { date: '2026-01-01', group_name: '111', cost: 5 },
            { date: '2026-01-01', group_name: '222', cost: 3 },
            { date: '2026-01-01', group_name: '333', cost: 1 },
            { date: '2026-01-02', group_name: '222', cost: 2 },
          ]
        : [{ entity: '111', total_cost: 5 }, { entity: '222', total_cost: 5 }, { entity: '333', total_cost: 1 }],
    });
    const range = { start: '2026-01-01', end: '2026-01-14' };
    const daily = json(await queryDailyCosts(ctx, { groupBy: 'account', dateRange: range, format: 'json' }));
    expect(daily.tables[0]?.columnKeys).toEqual(['date', 'total', 'grp_Prod', 'grp_333']);
    expect(daily.tables[0]?.rows).toEqual([
      { date: '2026-01-01', total: 9, grp_Prod: 8, grp_333: 1 },
      { date: '2026-01-02', total: 2, grp_Prod: 2, grp_333: 0 },
    ]);
    expect(daily.meta.get('Total')).toBe(11);

    // The same accounts, under the same names, as the overview's.
    const overview = json(await getCostOverview(ctx, { dateRange: range, format: 'json' }));
    expect(tableRows(overview, 'Top Accounts').map(r => r['account'])).toEqual(['Prod', '333']);
  });

  it('filters on a display name it shows by every account id behind it', async () => {
    const { ctx, prepared } = harness({
      accountMap: new Map([['111', 'Prod'], ['222', 'Prod']]),
      accountReverseMap: new Map([['Prod', ['111', '222']]]),
    });
    await queryDailyCosts(ctx, { groupBy: 'account', dateRange: { start: '2026-01-01', end: '2026-01-14' }, filters: { account: ['Prod'] }, format: 'json' });
    expect(prepared[0]?.sql).toContain('account_id IN (');
    expect(prepared[0]?.params).toEqual(expect.arrayContaining(['111', '222']));
    expect(prepared[0]?.params).not.toContain('Prod');
  });

  it('keeps an account id that has no display name, and never renames another dimension\'s groups', async () => {
    const { ctx } = harness({
      accountMap: new Map([['111', 'Prod']]),
      rows: () => [
        { date: '2026-01-01', group_name: '111', cost: 4 },
        { date: '2026-01-01', group_name: '999', cost: 1 },
      ],
    });
    const range = { start: '2026-01-01', end: '2026-01-14' };
    const byAccount = json(await queryDailyCosts(ctx, { groupBy: 'account_id', dateRange: range, format: 'json' }));
    expect(byAccount.tables[0]?.columnKeys).toEqual(['date', 'total', 'grp_Prod', 'grp_999']);
    const byService = json(await queryDailyCosts(ctx, { groupBy: 'service', dateRange: range, format: 'json' }));
    expect(byService.tables[0]?.columnKeys).toEqual(['date', 'total', 'grp_111', 'grp_999']);
  });
});

describe('get_filter_values', () => {
  it('refuses an unknown dimension with a pointer to list_dimensions', async () => {
    const { ctx, prepared } = harness();
    expect(await getFilterValues(ctx, { dimensionId: 'colour', dateRange: JAN })).toEqual({
      content: [{ type: 'text', text: 'Error: Unknown dimension "colour". Use list_dimensions to see available dimensions.' }],
      isError: true,
    });
    expect(prepared).toEqual([]);
  });

  it.each(['account', 'account_id'])('merges %s values that share a display name', async (dimensionId) => {
    const { ctx } = harness({
      accountMap: new Map([['111', 'Prod'], ['222', 'Prod']]),
      rows: () => [{ val: '111', total_cost: 30 }, { val: '333', total_cost: 50 }, { val: '222', total_cost: 30 }],
    });
    const result = json(await getFilterValues(ctx, { dimensionId, dateRange: JAN, format: 'json' }));
    expect(result.tables[0]?.rows).toEqual([
      { value: 'Prod', cost: 60, pct: 54.54545454545454 },
      { value: '333', cost: 50, pct: 45.45454545454545 },
    ]);
    expect(result.meta.get('Distinct Values')).toBe(2);
  });

  it('lists values as returned, with 0% shares for a zero total and a truncation footer, over the default range', async () => {
    const { ctx, prepared } = harness({
      rows: () => [{ val: 'EC2', total_cost: 0 }, { val: 'S3', total_cost: 0 }],
    });
    const result = json(await getFilterValues(ctx, { dimensionId: 'service', limit: 1, format: 'json' }));
    expect(result.title).toBe(`Service Values (${DEFAULT_RANGE.start} to ${DEFAULT_RANGE.end})`);
    expect(result.tables[0]?.rows).toEqual([{ value: 'EC2', cost: 0, pct: 0 }]);
    expect(result.tables[0]?.footer).toBe('*...and 1 more totaling $0.0000*');
    expect(prepared[0]?.params).toEqual([DEFAULT_RANGE.start, DEFAULT_RANGE.end]);
  });
});

describe('list_dimensions', () => {
  it('lists built-in and tag dimensions with their SQL column, type, state and description', async () => {
    const { ctx } = harness();
    const result = json(await listDimensions(ctx, { format: 'json' }));
    const rows = result.tables[0]?.rows ?? [];
    expect(rows.map(r => [r['id'], r['type'], r['enabled'], r['description']])).toEqual([
      ['account', 'built-in', 'yes', ''],
      ['account_id', 'built-in', 'yes', ''],
      ['service', 'built-in', 'yes', 'Cloud service'],
      ['region', 'built-in', 'no', ''],
      ['tag_team', 'tag (owner)', 'yes', 'Owning team'],
      ['tag_env', 'tag', 'no', ''],
    ]);
  });

  it('defaults to markdown when called without params', async () => {
    const { ctx } = harness();
    expect(resultText(await listDimensions(ctx))).toContain('## Available Dimensions');
  });
});
