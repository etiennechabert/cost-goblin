import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { buildCostQuery, buildDailyCostsQuery, buildGrainProbeQuery, buildPeriodDaysQuery, buildRollupPartitionQuery, buildSource, buildTrendQuery, sqlStringLiteral } from '../query/builder.js';
import type { QueryContextOptions } from '../query/builder.js';
import { periodsForRange } from '../query/period-days.js';
import type { PeriodDays } from '../query/period-days.js';
import { rollupGrainColumns } from '../rollup/grain.js';
import { FIXTURE_PROVIDER_NAME } from '../__fixtures__/layout.js';
import type { DimensionsConfig } from '../types/config.js';
import type { CostScopeConfig } from '../types/cost-scope.js';
import { asDateString, asDimensionId, asDollars, asProviderName } from '../types/branded.js';
import type { DateRange } from '../types/query.js';
import { queryAll, runPrepared } from './helpers/duckdb-rows.js';
import { costByDay, costIn, filedDays, FILED_PERIODS, FILED_SERVICE, writeFiledRows } from './helpers/filed-rows.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYNTHETIC_DIR = join(__dirname, '..', '__fixtures__', 'synthetic');
const PROVIDER = asProviderName(FIXTURE_PROVIDER_NAME);
const MONTHS = ['2026-01', '2026-02'];

const dimensions: DimensionsConfig = {
  builtIn: [
    { name: asDimensionId('account_id'), label: 'Account', field: 'account_id', displayField: 'account_name' },
    { name: asDimensionId('service'), label: 'Service', field: 'service' },
  ],
  tags: [{ tagName: 'team', label: 'Team', concept: 'owner', normalize: 'lowercase-kebab' }],
};
const costScope: CostScopeConfig = { costMetric: 'effective', rules: [] };

// The rollup invariant: aggregating the multi-month partition GLOB (with a
// date-range filter, as the dashboard handlers do) yields exactly the same
// numbers as aggregating raw over the same window+scope. This is what
// resolveSource relies on when it routes a dashboard query to the rollup.
describe('rollup multi-month glob == raw over the window', () => {
  let db: Awaited<ReturnType<typeof DuckDBInstance.create>>;
  let conn: Awaited<ReturnType<typeof db.connect>>;
  let rollupDir: string;
  let glob: string;

  beforeAll(async () => {
    db = await DuckDBInstance.create();
    conn = await db.connect();
    rollupDir = await mkdtemp(join(tmpdir(), 'cg-rollup-inv-'));
    for (const m of MONTHS) {
      const dir = join(rollupDir, `daily-${m}`);
      await mkdir(dir, { recursive: true });
      await conn.run(buildRollupPartitionQuery(m, 'daily', join(dir, 'rollup.parquet'), { dataDir: SYNTHETIC_DIR, dimensions, providers: [{ name: PROVIDER, type: 'aws', availablePeriods: [m] }], costScope }));
    }
    glob = `read_parquet('${join(rollupDir, 'daily-*', 'rollup.parquet').replaceAll('\\', '/')}')`;
  });
  afterAll(async () => { await rm(rollupDir, { recursive: true, force: true }); });

  const window = `usage_date >= '2026-01-01' AND usage_date < '2026-03-01'`;
  const rawSrc = () => buildSource({ dataDir: SYNTHETIC_DIR, tier: 'daily', dimensions, providers: [{ name: PROVIDER, type: 'aws', periods: MONTHS }], costMetric: 'effective' });

  it('total matches across the 2-month window', async () => {
    const raw = Number((await queryAll(conn, `SELECT CAST(SUM(cost) AS DOUBLE) t FROM ${rawSrc()} WHERE ${window}`))[0]?.['t']);
    const roll = Number((await queryAll(conn, `SELECT CAST(SUM(cost) AS DOUBLE) t FROM ${glob} WHERE ${window}`))[0]?.['t']);
    expect(roll).toBeGreaterThan(0);
    expect(roll).toBeCloseTo(raw, 2);
  });

  it('per-service and per-account aggregations match (the shapes handlers issue)', async () => {
    for (const dim of ['service', 'account_id']) {
      const rawMap = new Map<string, number>();
      for (const r of await queryAll(conn, `SELECT ${dim} k, CAST(SUM(cost) AS DOUBLE) c FROM ${rawSrc()} WHERE ${window} GROUP BY ${dim}`)) rawMap.set(String(r['k']), Number(r['c']));
      const rollRows = await queryAll(conn, `SELECT ${dim} k, CAST(SUM(cost) AS DOUBLE) c FROM ${glob} WHERE ${window} GROUP BY ${dim}`);
      expect(rollRows).toHaveLength(rawMap.size);
      for (const r of rollRows) expect(Number(r['c'])).toBeCloseTo(rawMap.get(String(r['k'])) ?? -1, 2);
    }
  });

  it('a sub-window only reads the months it touches (date pushdown over the glob)', async () => {
    const subWin = `usage_date >= '2026-02-01' AND usage_date < '2026-03-01'`;
    const raw = Number((await queryAll(conn, `SELECT CAST(SUM(cost) AS DOUBLE) t FROM ${rawSrc()} WHERE ${subWin}`))[0]?.['t']);
    const roll = Number((await queryAll(conn, `SELECT CAST(SUM(cost) AS DOUBLE) t FROM ${glob} WHERE ${subWin}`))[0]?.['t']);
    expect(roll).toBeCloseTo(raw, 2);
  });
});

// Description is off by default, so a rollup rarely stores it, but the build
// must still be able to read it: for the grain once the user turns it on, and
// for an exclusion rule on it either way. A build that can't read it fails on
// every month, and the dashboards with it.
describe('rollup partitions reading Description', () => {
  const MONTH = '2026-01';
  const JANUARY = `usage_date >= '2026-01-01' AND usage_date < '2026-02-01'`;
  const DESCRIPTION = { name: asDimensionId('description'), label: 'Description', field: 'description' };
  let db: Awaited<ReturnType<typeof DuckDBInstance.create>>;
  let conn: Awaited<ReturnType<typeof db.connect>>;
  let rollupDir: string;

  beforeAll(async () => {
    db = await DuckDBInstance.create();
    conn = await db.connect();
    rollupDir = await mkdtemp(join(tmpdir(), 'cg-rollup-description-'));
  });
  afterAll(async () => { await rm(rollupDir, { recursive: true, force: true }); });

  async function buildPartition(name: string, dims: DimensionsConfig, scope: CostScopeConfig): Promise<string> {
    const out = join(rollupDir, `${name}.parquet`);
    await conn.run(buildRollupPartitionQuery(MONTH, 'daily', out, { dataDir: SYNTHETIC_DIR, dimensions: dims, providers: [{ name: PROVIDER, type: 'aws', availablePeriods: [MONTH] }], costScope: scope }));
    return `read_parquet('${out.replaceAll('\\', '/')}')`;
  }
  const rawJanuary = (dims: DimensionsConfig): string => buildSource({ dataDir: SYNTHETIC_DIR, tier: 'daily', dimensions: dims, providers: [{ name: PROVIDER, type: 'aws', periods: [MONTH] }], costMetric: 'effective' });

  it('stores it when the dimension is on, with raw\'s total for each description', async () => {
    const on: DimensionsConfig = { ...dimensions, builtIn: [...dimensions.builtIn, DESCRIPTION] };
    const rollup = await buildPartition('on', on, costScope);

    const raw = await queryAll(conn, `SELECT description k, CAST(SUM(cost) AS DOUBLE) c FROM ${rawJanuary(on)} WHERE ${JANUARY} GROUP BY 1`);
    const rolled = await queryAll(conn, `SELECT description k, CAST(SUM(cost) AS DOUBLE) c FROM ${rollup} GROUP BY 1`);
    expect(raw.length).toBeGreaterThan(1);
    expect(rolled).toHaveLength(raw.length);
    const rawByDescription = new Map(raw.map(r => [String(r['k']), Number(r['c'])]));
    for (const r of rolled) expect(Number(r['c'])).toBeCloseTo(rawByDescription.get(String(r['k'])) ?? -1, 2);
  });

  it('applies an exclusion rule on it when the dimension is off, without storing it', async () => {
    const off: DimensionsConfig = { ...dimensions, builtIn: [...dimensions.builtIn, { ...DESCRIPTION, enabled: false }] };
    const top = String((await queryAll(conn, `SELECT description k FROM ${rawJanuary(off)} WHERE ${JANUARY} GROUP BY 1 ORDER BY SUM(cost) DESC LIMIT 1`))[0]?.['k']);
    const rule = { id: 'no-top', name: 'No top description', enabled: true, builtIn: false, conditions: [{ dimensionId: DESCRIPTION.name, values: [top] }] };
    const rollup = await buildPartition('off', off, { ...costScope, rules: [rule] });

    const kept = Number((await queryAll(conn, `SELECT CAST(SUM(cost) AS DOUBLE) t FROM ${rawJanuary(off)} WHERE ${JANUARY} AND description <> '${top.replaceAll("'", "''")}'`))[0]?.['t']);
    const rolled = Number((await queryAll(conn, `SELECT CAST(SUM(cost) AS DOUBLE) t FROM ${rollup}`))[0]?.['t']);
    expect(kept).toBeGreaterThan(0);
    expect(rolled).toBeCloseTo(kept, 2);
    const columns = await queryAll(conn, `DESCRIBE SELECT * FROM ${rollup}`);
    expect(columns.map(c => c['column_name'])).not.toContain('description');
  });

  it('reads no column the partition does not need', async () => {
    const rollup = buildRollupPartitionQuery(MONTH, 'daily', join(rollupDir, 'plan.parquet'), { dataDir: SYNTHETIC_DIR, dimensions, providers: [{ name: PROVIDER, type: 'aws', availablePeriods: [MONTH] }], costScope });
    const select = rollup.slice(rollup.indexOf('(') + 1, rollup.lastIndexOf(') TO '));
    const plan = (await queryAll(conn, `EXPLAIN ${select}`)).map(r => String(r['explain_value'])).join('\n');
    // Not slim any more, so nothing but DuckDB's pruning keeps a rebuild from
    // scanning these strings across every line item of the month.
    expect(plan).toContain('ServiceName');
    expect(plan).not.toContain('ChargeDescription');
    expect(plan).not.toContain('ConsumedQuantity');
  });
});

// A billing period's files hold rows of other months too (see period-days.ts).
// A partition is one period's files, whole, and a range reads every period
// holding one of its days: from raw Parquet and from the rollup alike, so a
// day costs the same whichever path answers and whatever range asks for it.
describe('billing-period files holding rows of other months', () => {
  const FILED = asProviderName('aws');
  const service = asDimensionId('service');
  const range = (start: string, end: string): DateRange => ({ start: asDateString(start), end: asDateString(end) });
  const RANGES: readonly (readonly [string, DateRange])[] = [
    ['a month and the days of it filed under another', range('2026-01-01', '2026-01-31')],
    ['a month with no file of its own', range('2026-02-01', '2026-02-28')],
    ['days before the first file\'s month', range('2025-12-01', '2025-12-31')],
    ['days after the last file\'s month', range('2026-04-01', '2026-04-30')],
    ['a month two files hold days of', range('2026-03-01', '2026-03-31')],
    ['one day, filed under the month before', range('2026-02-01', '2026-02-01')],
    ['days of a month only its neighbour holds', range('2026-03-01', '2026-03-10')],
    ['every day there is', range('2025-12-01', '2026-04-30')],
  ];

  let db: Awaited<ReturnType<typeof DuckDBInstance.create>>;
  let conn: Awaited<ReturnType<typeof db.connect>>;
  let dataDir: string;
  let periodDays: PeriodDays;
  const partition = (period: string): string => join(dataDir, 'rollup', `daily-${period}`, 'rollup.parquet').replaceAll('\\', '/');

  const opts = (): QueryContextOptions => ({
    dataDir, dimensions, costScope,
    providers: [{ name: FILED, type: 'aws', availablePeriods: [...FILED_PERIODS], periodDays }],
  });
  /** The same options, reading the rollup partitions the range needs. */
  const fromRollup = (dateRange: DateRange): QueryContextOptions => {
    const periods = periodsForRange({ availablePeriods: [...FILED_PERIODS], periodDays }, dateRange);
    return { ...opts(), materializedSource: `read_parquet([${periods.map(p => sqlStringLiteral(partition(p))).join(', ')}])` };
  };
  const dailyCosts = async (dateRange: DateRange, o: QueryContextOptions, granularity?: 'hourly'): Promise<Record<string, number>> => {
    const q = buildDailyCostsQuery({ groupBy: service, dateRange, filters: {}, ...(granularity === undefined ? {} : { granularity }) }, o);
    const out: Record<string, number> = {};
    for (const r of await runPrepared(conn, q.sql, q.params)) out[String(r['date'])] = (out[String(r['date'])] ?? 0) + Number(r['cost']);
    return out;
  };

  beforeAll(async () => {
    db = await DuckDBInstance.create();
    conn = await db.connect();
    dataDir = (await mkdtemp(join(tmpdir(), 'cg-rollup-filed-'))).replaceAll('\\', '/');
    await writeFiledRows(conn, dataDir, String(FILED), ['daily', 'hourly']);
    const days: Record<string, string[]> = {};
    for (const period of FILED_PERIODS) {
      const rows = await queryAll(conn, buildPeriodDaysQuery(dataDir, { name: FILED, type: 'aws' }, 'daily', period));
      days[period] = rows.map(r => String(r['day']));
      await mkdir(dirname(partition(period)), { recursive: true });
      await conn.run(buildRollupPartitionQuery(period, 'daily', partition(period), { ...opts(), providers: [{ name: FILED, type: 'aws' }] }));
    }
    periodDays = days;
  });
  afterAll(async () => { await rm(dataDir, { recursive: true, force: true }); });

  it('lists the UTC days each period\'s files hold, as text, oldest first', () => {
    expect(periodDays).toEqual({ '2026-01': filedDays('2026-01'), '2026-03': filedDays('2026-03') });
    expect(periodDays['2026-01']).toEqual(['2025-12-30', '2026-01-10', '2026-01-31', '2026-02-01', '2026-02-15', '2026-03-02']);
  });

  it('keeps every row of a period\'s files in its partition, whatever month it is dated in', async () => {
    for (const period of FILED_PERIODS) {
      const rows = await queryAll(conn, `SELECT usage_date::VARCHAR AS day, SUM(cost) AS cost, SUM(line_items)::DOUBLE AS n FROM read_parquet(${sqlStringLiteral(partition(period))}) GROUP BY 1 ORDER BY 1`);
      expect(rows.map(r => r['day'])).toEqual(filedDays(period));
      expect(rows.reduce((sum, r) => sum + Number(r['n']), 0)).toBe(period === '2026-01' ? 6 : 4);
    }
  });

  it('probes the grain over the rows a partition stores', async () => {
    const probe = buildGrainProbeQuery('2026-01', rollupGrainColumns(dimensions), { ...opts(), providers: [{ name: FILED, type: 'aws' }] });
    const [counts] = await queryAll(conn, probe);
    const [stored] = await queryAll(conn, `SELECT COUNT(*) AS n FROM read_parquet(${sqlStringLiteral(partition('2026-01'))})`);
    expect(Number(counts?.['line_items'])).toBe(6);
    expect(Number(counts?.['grain_rows'])).toBe(Number(stored?.['n']));
  });

  it.each(RANGES)('costs %s the same from the rollup and from raw, day by day', async (_name, dateRange) => {
    const expected = costByDay(dateRange);
    expect(await dailyCosts(dateRange, opts())).toEqual(expected);
    expect(await dailyCosts(dateRange, fromRollup(dateRange))).toEqual(expected);
  });

  it('gives a day the same cost whatever range asks for it', async () => {
    // 2026-03-02 is in both files: 32 filed under January, 128 under March.
    for (const dateRange of [range('2026-03-02', '2026-03-02'), range('2026-03-01', '2026-03-31'), range('2026-01-01', '2026-03-31')]) {
      expect((await dailyCosts(dateRange, opts()))['2026-03-02']).toBe(160);
      expect((await dailyCosts(dateRange, fromRollup(dateRange)))['2026-03-02']).toBe(160);
    }
  });

  it('totals and trends a range whose previous period has no file of its own', async () => {
    // March against February (the 28 days before it start on 2026-02-01).
    const march = range('2026-03-01', '2026-03-28');
    const both = range('2026-02-01', '2026-03-28');
    for (const o of [opts(), fromRollup(both)]) {
      const cost = buildCostQuery({ groupBy: service, dateRange: march, filters: {} }, o);
      expect((await runPrepared(conn, cost.sql, cost.params)).map(r => [r['entity'], Number(r['total_cost'])])).toEqual([[FILED_SERVICE, costIn(march)]]);
      const trend = buildTrendQuery({ groupBy: service, dateRange: march, filters: {}, deltaThreshold: asDollars(0), percentThreshold: 0 }, o);
      expect((await runPrepared(conn, trend.sql, trend.params)).map(r => [Number(r['current_cost']), Number(r['previous_cost'])]))
        .toEqual([[costIn(march), costIn(range('2026-02-01', '2026-02-28'))]]);
    }
    expect(costIn(march)).toBe(32 + 128 + 256);
    expect(costIn(range('2026-02-01', '2026-02-28'))).toBe(8 + 16 + 64);
  });

  it('reads the hourly files the same way', async () => {
    const hourly = await queryAll(conn, buildPeriodDaysQuery(dataDir, { name: FILED, type: 'aws' }, 'hourly', '2026-03'));
    expect(hourly.map(r => String(r['day']))).toEqual(filedDays('2026-03'));
    expect(await dailyCosts(range('2026-02-01', '2026-02-28'), opts(), 'hourly')).toEqual({
      '2026-02-01 00:00': 8, '2026-02-15 12:00': 16, '2026-02-27 00:00': 64,
    });
  });

  it('refuses a period, a tier or a provider path that is not one', () => {
    expect(() => buildPeriodDaysQuery(dataDir, { name: FILED, type: 'aws' }, 'daily', '2026-1')).toThrow();
    expect(() => buildPeriodDaysQuery(dataDir, { name: FILED, type: 'aws' }, 'weekly', '2026-01')).toThrow();
    expect(buildPeriodDaysQuery("/tmp/o'brien", { name: FILED, type: 'aws' }, 'daily', '2026-01')).toContain("'/tmp/o''brien/aws/raw/daily-2026-01/*.parquet'");
  });
});
