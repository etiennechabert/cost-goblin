import { describe, expect, it } from 'vitest';
import {
  buildBaselineDiscoveryQuery,
  buildBaselineTotalsQuery,
  buildCostQuery,
  buildDimCardinalityQuery,
  buildEntityDetailQuery,
  buildFilterClauses,
  buildMissingTagsQuery,
  buildSource,
  buildTrendQuery,
} from '../query/builder.js';
import type { QueryContextOptions } from '../query/builder.js';
import { QueryBuilder } from '../query/parameterized.js';
import { SecurityError } from '../query/identifier-validator.js';
import type { DimensionsConfig, TagDimension } from '../types/config.js';
import type { FilterMap } from '../types/query.js';
import { asDateString, asDimensionId, asDollars, asEntityRef, asHourString, asProviderName, asTagValue, tagDimColumn, tagSqlColumn } from '../types/branded.js';
import type { CostScopeConfig } from '../types/cost-scope.js';

// The query builders' input guards and the SQL shape of their less common
// inputs: numeric parameters, multi-value and account-name filters, provider
// fallbacks, account-only tag dimensions and the raw-tag columns. Every value
// that reaches the SQL must arrive as a bound parameter.

const TEAM: TagDimension = { tagName: 'team', label: 'Team' };
const COST_CENTER: TagDimension = { tagName: 'cc', label: 'Cost Center', accountTagFallback: 'CostCenter' };
const BU: TagDimension = { label: 'Business Unit', accountTagFallback: 'BusinessUnit' };

const dimensions: DimensionsConfig = {
  builtIn: [
    { name: asDimensionId('account'), label: 'Account', field: 'account_id', displayField: 'account_name' },
    { name: asDimensionId('service'), label: 'Service', field: 'service' },
  ],
  tags: [TEAM],
};

const JAN = { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') };
const opts: QueryContextOptions = { dataDir: '/data', dimensions, providers: [{ name: asProviderName('aws') }] };
const noFilters: FilterMap = {};

function filters(entries: Record<string, readonly string[]>): FilterMap {
  const map: Record<string, readonly ReturnType<typeof asTagValue>[]> = {};
  for (const [id, values] of Object.entries(entries)) map[asDimensionId(id)] = values.map(v => asTagValue(v));
  return map;
}

describe('numeric query parameters', () => {
  it.each([
    [-1, 'got -1'],
    [Number.NaN, 'got NaN'],
    [Number.POSITIVE_INFINITY, 'got Infinity'],
  ])('buildCostQuery refuses topN %s', (topN, got) => {
    expect(() => buildCostQuery({ groupBy: asDimensionId('service'), dateRange: JAN, filters: noFilters }, opts, topN))
      .toThrow(`Query parameter "topN" must be a non-negative finite number, ${got}`);
  });

  it('buildCostQuery accepts a topN of 0 and binds it', () => {
    const { params } = buildCostQuery({ groupBy: asDimensionId('service'), dateRange: JAN, filters: noFilters }, opts, 0);
    expect(params).toEqual(['2026-01-01', '2026-01-31', 0]);
  });

  it('buildTrendQuery refuses a negative delta threshold', () => {
    expect(() => buildTrendQuery({
      groupBy: asDimensionId('service'), dateRange: JAN, filters: noFilters, deltaThreshold: asDollars(-5), percentThreshold: 5,
    }, opts)).toThrow('Query parameter "deltaThreshold" must be a non-negative finite number, got -5');
  });

  it('buildMissingTagsQuery refuses a non-finite minimum cost', () => {
    expect(() => buildMissingTagsQuery({
      tagDimension: asDimensionId('tag_team'), dateRange: JAN, filters: noFilters, minCost: asDollars(Number.POSITIVE_INFINITY),
    }, opts)).toThrow('Query parameter "minCost" must be a non-negative finite number, got Infinity');
  });

  it('buildBaselineDiscoveryQuery refuses a negative minimum total', () => {
    expect(() => buildBaselineDiscoveryQuery({
      dateRange: JAN, filters: noFilters, grainDimensionIds: [asDimensionId('service')], minTotalCost: -0.01,
    }, opts)).toThrow('Query parameter "minTotalCost" must be a non-negative finite number, got -0.01');
  });
});

describe('buildFilterClauses', () => {
  const reverse = new Map<string, readonly string[]>([['Prod', ['111', '222']], ['Retired', []]]);

  function clauses(map: FilterMap, accountReverseMap?: ReadonlyMap<string, readonly string[]>): { sql: string[]; params: readonly unknown[] } {
    const qb = new QueryBuilder();
    const sql = buildFilterClauses(map, dimensions, accountReverseMap, qb);
    return { sql, params: qb.build().params };
  }

  it('skips dimensions with no values', () => {
    expect(clauses(filters({ service: [], tag_team: [] }))).toEqual({ sql: [], params: [] });
  });

  it('binds one value with = and several with an IN list', () => {
    expect(clauses(filters({ service: ['Amazon EC2'], tag_team: ['core', "o'brien"] }))).toEqual({
      sql: ['service = $1', `${tagSqlColumn(TEAM)} IN ($2, $3)`],
      params: ['Amazon EC2', 'core', "o'brien"],
    });
  });

  it('expands an account display name to every account id behind it, keeping raw ids', () => {
    expect(clauses(filters({ account: ['Prod', '999'] }), reverse)).toEqual({
      sql: ['account_id IN ($1, $2, $3)'],
      params: ['111', '222', '999'],
    });
  });

  it.each([
    ['one value', ['999'], 'account_id = $1'],
    ['several values', ['999', 'Retired'], 'account_id IN ($1, $2)'],
  ])('binds account values as-is when none is a known display name (%s)', (_label, values, sql) => {
    expect(clauses(filters({ account: values }), reverse)).toEqual({ sql: [sql], params: values });
  });

  it('only expands names on the account dimension', () => {
    expect(clauses(filters({ service: ['Prod'] }), reverse)).toEqual({ sql: ['service = $1'], params: ['Prod'] });
  });

  it('refuses an unknown dimension id', () => {
    expect(() => clauses(filters({ "service = '' OR 1=1 --": ['x'] }))).toThrow(SecurityError);
  });
});

describe('buildSource edge inputs', () => {
  it('refuses to build a source without a provider branch', () => {
    expect(() => buildSource({ dataDir: '/data', tier: 'daily', dimensions, providers: [] }))
      .toThrow(new SecurityError('buildSource requires at least one provider branch'));
  });

  it('emits NULL for an account-only tag dimension when there is no org join', () => {
    const sql = buildSource({ dataDir: '/data', tier: 'daily', dimensions: { builtIn: [], tags: [BU] }, providers: [{ name: asProviderName('aws') }] });
    expect(sql).toContain(`NULL AS ${tagSqlColumn(BU)}`);
    expect(sql).not.toContain('acct_tags');
  });

  it('prefixes a missing-value template that has no {fallback} placeholder', () => {
    const tag: TagDimension = { ...COST_CENTER, missingValueTemplate: 'unassigned' };
    const sql = buildSource({
      dataDir: '/data', tier: 'daily', dimensions: { builtIn: [], tags: [tag] },
      orgAccountsPath: '/state/org-accounts.json', providers: [{ name: asProviderName('aws') }],
    });
    const col = tagSqlColumn(tag);
    expect(sql).toContain(`COALESCE(NULLIF(element_at(src.Tags, 'cc')[1], ''), 'unassigned' || acct_tags.fallback_${col} || '') AS ${col}`);
  });

  it('emits raw tag columns only for resource tags that carry an account fallback', () => {
    const sql = buildSource({
      dataDir: '/data', tier: 'daily', dimensions: { builtIn: [], tags: [TEAM, COST_CENTER, BU] },
      orgAccountsPath: '/state/org-accounts.json', providers: [{ name: asProviderName('aws') }], includeRawTags: true,
    });
    expect(sql).toContain(`element_at(src.Tags, 'cc')[1] AS raw_${tagSqlColumn(COST_CENTER)}`);
    expect(sql).not.toContain(`raw_${tagSqlColumn(TEAM)}`);
    expect(sql).not.toContain(`raw_${tagSqlColumn(BU)}`);
  });

  it('keeps every provider on its wildcard glob when none reports a month on disk', () => {
    const { sql } = buildCostQuery({ groupBy: asDimensionId('service'), dateRange: JAN, filters: noFilters }, {
      ...opts,
      providers: [{ name: asProviderName('aws'), availablePeriods: [] }, { name: asProviderName('gcp'), availablePeriods: [] }],
    });
    expect(sql).toContain("read_parquet('/data/aws/raw/daily-*/*.parquet', union_by_name=true)");
    expect(sql).toContain("read_parquet('/data/gcp/raw/daily-*/*.parquet', union_by_name=true)");
  });

  it('drops a provider with no months on disk while another has data', () => {
    const { sql } = buildCostQuery({ groupBy: asDimensionId('service'), dateRange: JAN, filters: noFilters }, {
      ...opts,
      providers: [{ name: asProviderName('aws'), availablePeriods: [] }, { name: asProviderName('gcp'), availablePeriods: ['2026-01'] }],
    });
    expect(sql).toContain("'/data/gcp/raw/daily-2026-01/*.parquet'");
    expect(sql).not.toContain('/data/aws/raw/');
  });
});

describe('materialized base and Cost Scope sources', () => {
  const excludeSandbox: CostScopeConfig = {
    costMetric: 'list',
    rules: [{ id: 'r1', name: 'No sandbox', enabled: true, builtIn: false, conditions: [{ dimensionId: asDimensionId('account'), values: ['444'] }] }],
  };

  it('reads the materialized base as-is: its rows are already scoped', () => {
    const { sql, params } = buildCostQuery(
      { groupBy: asDimensionId('service'), dateRange: JAN, filters: noFilters },
      { ...opts, costScope: excludeSandbox, materializedSource: 'cost_base' },
    );
    expect(sql).toContain('FROM cost_base');
    expect(sql).not.toContain('read_parquet');
    expect(sql).not.toContain('NOT (');
    expect(params).toEqual(['2026-01-01', '2026-01-31', 5]);
  });

  it('reads hourly Parquet with the Cost Scope applied when the range has hour bounds', () => {
    const { sql, params } = buildCostQuery(
      {
        groupBy: asDimensionId('service'),
        dateRange: { ...JAN, startHour: asHourString('2026-01-05 00:00:00'), endHour: asHourString('2026-01-05 23:00:00') },
        filters: noFilters,
      },
      { ...opts, costScope: excludeSandbox, materializedSource: 'cost_base' },
    );
    expect(sql).not.toContain('FROM cost_base');
    expect(sql).toContain("'/data/aws/raw/hourly-2026-01/*.parquet'");
    expect(sql).toContain('NOT (COALESCE(account_id IN ($1), FALSE))');
    expect(params).toEqual(['444', '2026-01-05 00:00:00', '2026-01-05 23:00:00', 5]);
  });

  it('applies the Cost Scope exclusions and metric to a trend query', () => {
    const { sql, params } = buildTrendQuery({
      groupBy: asDimensionId('service'), dateRange: JAN, filters: noFilters, deltaThreshold: asDollars(1), percentThreshold: 5,
    }, { ...opts, costScope: excludeSandbox });
    expect(sql).toContain('NOT (COALESCE(account_id IN ($1), FALSE))');
    expect(sql).toContain('COALESCE(ListCost, 0) AS cost');
    // The list metric only reads usage rows.
    expect(sql).toContain("WHERE COALESCE(ChargeCategory, '') IN ('Usage')");
    expect(params).toEqual(['444', '2026-01-01', '2026-01-31', 1]);
  });
});

describe('buildCostQuery org-node restriction', () => {
  it('restricts the entities to the org node values, bound before topN', () => {
    const { sql, params } = buildCostQuery({
      groupBy: asDimensionId('account'), dateRange: JAN, filters: noFilters, orgNodeValues: ['111', '222'],
    }, opts, 3);
    expect(sql).toContain('account_id IN ($3, $4)');
    expect(params).toEqual(['2026-01-01', '2026-01-31', '111', '222', 3]);
  });

  it('adds no restriction for an empty org node', () => {
    const { sql, params } = buildCostQuery({
      groupBy: asDimensionId('account'), dateRange: JAN, filters: noFilters, orgNodeValues: [],
    }, opts);
    expect(sql).not.toContain('account_id IN');
    expect(params).toEqual(['2026-01-01', '2026-01-31', 5]);
  });
});

describe('buildEntityDetailQuery account entities', () => {
  const reverse = new Map<string, readonly string[]>([['Prod', ['111', '222']], ['Retired', []]]);

  // The entity is bound first, then the date range.
  it.each([
    ['a display name with accounts behind it', 'account', 'Prod', 'account_id IN ($1, $2)', ['111', '222']],
    ['a display name with no account left', 'account', 'Retired', 'account_id = $1', ['Retired']],
    ['a raw account id', 'account', '333', 'account_id = $1', ['333']],
    ['a non-account entity', 'service', 'Prod', 'service = $1', ['Prod']],
  ])('matches %s', (_label, dimension, entity, clause, bound) => {
    const { sql, params } = buildEntityDetailQuery(
      { entity: asEntityRef(entity), dimension: asDimensionId(dimension), dateRange: JAN, filters: noFilters },
      { ...opts, accountReverseMap: reverse },
    );
    expect(sql).toContain(`WHERE usage_date BETWEEN $${String(bound.length + 1)} AND $${String(bound.length + 2)} AND ${clause}`);
    expect(params).toEqual([...bound, '2026-01-01', '2026-01-31']);
  });
});

describe('buildMissingTagsQuery tag check column', () => {
  const withFallbacks: DimensionsConfig = { builtIn: dimensions.builtIn, tags: [TEAM, COST_CENTER, BU] };
  const orgOpts: QueryContextOptions = { ...opts, dimensions: withFallbacks, orgAccountsPath: '/state/org-accounts.json' };

  function tagCheck(tagDimension: string, o: QueryContextOptions): string {
    const { sql } = buildMissingTagsQuery({ tagDimension: asDimensionId(tagDimension), dateRange: JAN, filters: noFilters, minCost: asDollars(0) }, o);
    const match = /MAX\(CASE WHEN (\S+) IS NOT NULL/.exec(sql);
    if (match === null) throw new Error('no tag check in the missing-tags SQL');
    return match[1] ?? '';
  }

  it('checks the resource-level raw column of a tag with an account fallback', () => {
    expect(tagCheck(tagDimColumn(COST_CENTER), orgOpts)).toBe(`raw_${tagSqlColumn(COST_CENTER)}`);
  });

  it('checks the resolved column when there is no org join to fall back from', () => {
    expect(tagCheck(tagDimColumn(COST_CENTER), { ...orgOpts, orgAccountsPath: undefined })).toBe(tagSqlColumn(COST_CENTER));
  });

  it('checks the resolved column of an account-only dimension', () => {
    expect(tagCheck(tagDimColumn(BU), orgOpts)).toBe(tagSqlColumn(BU));
  });

  it('checks a plain tag and a built-in dimension on their own columns', () => {
    expect(tagCheck(tagDimColumn(TEAM), orgOpts)).toBe(tagSqlColumn(TEAM));
    expect(tagCheck('service', orgOpts)).toBe('service');
  });
});

describe('baseline and cardinality probes', () => {
  it.each([
    ['buildBaselineDiscoveryQuery', () => buildBaselineDiscoveryQuery({ dateRange: JAN, filters: noFilters, grainDimensionIds: [], minTotalCost: 1 }, opts)],
    ['buildBaselineTotalsQuery', () => buildBaselineTotalsQuery({ dateRange: JAN, filters: noFilters, grainDimensionIds: [] }, opts)],
  ])('%s refuses an empty grain', (_name, build) => {
    expect(build).toThrow(new SecurityError('Baseline discovery requires at least one grain dimension.'));
  });

  it('buildDimCardinalityQuery refuses a column that is not a bare identifier', () => {
    expect(() => buildDimCardinalityQuery(['service', 'region; DROP TABLE x'], JAN, opts))
      .toThrow(new SecurityError('Unsafe column "region; DROP TABLE x" in cardinality probe.'));
  });

  it('buildDimCardinalityQuery counts each column and the rows over the bound range', () => {
    const { sql, params } = buildDimCardinalityQuery(['service', 'account_id'], JAN, opts);
    expect(sql).toMatch(/^SELECT COUNT\(DISTINCT service\) AS service, COUNT\(DISTINCT account_id\) AS account_id, COUNT\(\*\) AS row_count\s+FROM/);
    expect(sql).toContain('WHERE usage_date BETWEEN $1 AND $2');
    expect(params).toEqual(['2026-01-01', '2026-01-31']);
  });
});
