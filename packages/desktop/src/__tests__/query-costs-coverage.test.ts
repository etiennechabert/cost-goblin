import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import { asDateString, asDimensionId, asTagValue } from '@costgoblin/core';
import type {
  CostQueryParams,
  CostResult,
  DailyCostsParams,
  DailyCostsResult,
  DateRange,
  FilterMap,
  Granularity,
} from '@costgoblin/core';
import type { DuckDBClient } from '../main/duckdb-client.js';
import { createAppContext, type AppContext } from '../main/handlers/context.js';
import { registerCostHandlers } from '../main/handlers/query-costs.js';
import { fetchRows, fetchRowsPrepared } from './helpers/duckdb-rows.js';
import { pinnedIpcContext } from './helpers/ipc-context.js';

/** `query:costs` and `query:daily-costs` report how many days of the asked
 *  range their data covers, so the renderer can refuse to compare against a
 *  previous period that is only partly synced. Run through the real handlers,
 *  over Parquet on disk: the coverage comes from the months sync left there,
 *  never from the rows the query returns. */

type CostsHandler = (event: unknown, params: CostQueryParams) => Promise<CostResult>;
type DailyCostsHandler = (event: unknown, params: DailyCostsParams) => Promise<DailyCostsResult>;

// registerCostHandlers reaches ipcMain; context.ts reaches
// @sentry/electron/main (which imports `electron`) through the tracing helper.
// Tracing is never armed here. Each kept channel is stored under its own
// handler's type: the intersection only lets the assignment pick it.
const ipc = vi.hoisted((): { costs: CostsHandler | undefined; dailyCosts: DailyCostsHandler | undefined } => ({
  costs: undefined,
  dailyCosts: undefined,
}));
vi.mock('electron', () => ({
  app: {},
  ipcMain: {
    handle: (channel: string, handler: CostsHandler & DailyCostsHandler) => {
      if (channel === 'query:costs') ipc.costs = handler;
      if (channel === 'query:daily-costs') ipc.dailyCosts = handler;
    },
  },
}));
vi.mock('@sentry/electron/main', () => ({}));

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_CONFIG = join(__dirname, '..', '..', '..', 'core', 'src', '__fixtures__', 'config', 'costgoblin.yaml');
// The fixture config's provider (FIXTURE_PROVIDER_NAME in core's fixtures,
// not importable from here — outside this package's tsconfig rootDir).
const PROVIDER = 'aws-main';

const DIMENSIONS_YAML = `builtIn:
  - name: account
    label: Account
    field: account_id
    displayField: account_name
  - name: service
    label: Service
    field: service
tags: []
`;

interface SeedRow {
  readonly day: string;
  readonly account: string;
  readonly service: string;
  readonly cost: number;
}

/** Synced data: February and March. January's directory exists but holds no
 *  Parquet, as an interrupted download leaves it; it isn't synced data.
 *  EC2 has spend on three days of the two months; AWS Lambda is used once,
 *  on March 10. */
const SYNCED: Readonly<Record<string, readonly SeedRow[]>> = {
  '2026-02': [
    { day: '2026-02-03', account: '111', service: 'AmazonEC2', cost: 100 },
    { day: '2026-02-20', account: '222', service: 'AmazonEC2', cost: 50 },
  ],
  '2026-03': [
    { day: '2026-03-05', account: '111', service: 'AmazonEC2', cost: 70 },
    { day: '2026-03-10', account: '111', service: 'AWS Lambda', cost: 5 },
  ],
};

/** One month of FOCUS 1.2 rows, written as the daily tier's Parquet. */
async function seedMonth(conn: DuckDBConnection, dataDir: string, period: string, rows: readonly SeedRow[]): Promise<void> {
  const dir = join(dataDir, PROVIDER, 'raw', `daily-${period}`);
  await mkdir(dir, { recursive: true });
  const values = rows.map(r =>
    `(TIMESTAMP '${r.day}', '${r.account}', 'acct-${r.account}', 'eu-central-1', '${r.service}', '${r.service}', 'Compute', 'row', 1,
      ${String(r.cost)}, 'res', ${String(r.cost)}, ${String(r.cost)}, ${String(r.cost)}, 'Usage', 'Standard', '', 'Op', 'SKU')`,
  );
  await conn.run(`COPY (
    SELECT * FROM (VALUES ${values.join(',\n')}) AS t(
      ChargePeriodStart, SubAccountId, SubAccountName, RegionId, ServiceName, x_ServiceCode, ServiceCategory,
      ChargeDescription, ConsumedQuantity, ListCost, ResourceId, BilledCost, EffectiveCost, ContractedCost,
      ChargeCategory, PricingCategory, CommitmentDiscountStatus, x_Operation, SkuMeter)
  ) TO '${join(dir, 'data.parquet')}' (FORMAT PARQUET)`);
}

function inProcessDb(conn: DuckDBConnection): DuckDBClient {
  return {
    runQuery: sql => fetchRows(conn, sql),
    runPreparedQuery: (sql, params) => fetchRowsPrepared(conn, sql, params),
    runBuildQuery: () => Promise.reject(new Error('rollup builds are not part of this test')),
    cancelPendingQueries: () => undefined,
    configure: () => undefined,
    terminate: () => Promise.resolve(),
  };
}

function range(start: string, end: string): DateRange {
  return { start: asDateString(start), end: asDateString(end) };
}

// One workspace for both handlers. Unset until beforeAll gets that far:
// teardown must not hide its error.
let root: string | undefined;
let instance: DuckDBInstance | undefined;
let app: AppContext | undefined;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'cg-coverage-'));
  instance = await DuckDBInstance.create();
  const conn = await instance.connect();
  const ipcContext = pinnedIpcContext(root, inProcessDb(conn));
  await mkdir(dirname(ipcContext.configPath), { recursive: true });
  await copyFile(FIXTURE_CONFIG, ipcContext.configPath);
  await writeFile(ipcContext.dimensionsPath, DIMENSIONS_YAML);
  for (const [period, rows] of Object.entries(SYNCED)) await seedMonth(conn, ipcContext.dataDir, period, rows);
  await mkdir(join(ipcContext.dataDir, PROVIDER, 'raw', 'daily-2026-01'), { recursive: true });

  app = createAppContext(ipcContext);
  registerCostHandlers(app);
});

afterAll(async () => {
  await app?.awaitWarmup(5_000);
  instance?.closeSync();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

describe('query:costs data coverage (DuckDB end-to-end)', () => {
  function queryCosts(dateRange: DateRange, filters: FilterMap = {}, granularity: Granularity = 'daily'): Promise<CostResult> {
    const handler = ipc.costs;
    if (handler === undefined) throw new Error('query:costs is not registered');
    // The summary widget's grouping: per account, merged by display name.
    return handler({}, { groupBy: asDimensionId('account'), dateRange, filters, granularity });
  }

  it('covers every day of a range inside synced months, whatever was spent on them', async () => {
    const result = await queryCosts(range('2026-02-01', '2026-03-31'));
    expect(result.totalCost).toBe(225);
    expect(result.coveredDays).toBe(28 + 31);
  });

  it('leaves out the days before the first synced month, and echoes the asked range', async () => {
    // Jan 18 - Feb 14: only February's half is synced, and its $100 is all
    // the query can see of the period.
    const asked = range('2026-01-18', '2026-02-14');
    const result = await queryCosts(asked);
    expect(result.totalCost).toBe(100);
    expect(result.coveredDays).toBe(14);
    expect(result.dateRange).toEqual(asked);
  });

  it('counts a synced month in full when a filter matches nothing in it: zero spend, not missing data', async () => {
    const result = await queryCosts(range('2026-02-01', '2026-02-28'), { [asDimensionId('service')]: [asTagValue('AWS Lambda')] });
    expect(result.rows).toEqual([]);
    expect(result.totalCost).toBe(0);
    expect(result.coveredDays).toBe(28);
  });

  it('covers nothing of a range with no synced month', async () => {
    const result = await queryCosts(range('2025-12-01', '2026-01-31'));
    expect(result.totalCost).toBe(0);
    expect(result.coveredDays).toBe(0);
  });

  it('reads the hourly tier\'s own months for an hourly query', async () => {
    // Only the daily tier is on disk.
    const result = await queryCosts(range('2026-02-01', '2026-02-28'), {}, 'hourly');
    expect(result.coveredDays).toBe(0);
  });
});

describe('query:daily-costs data coverage (DuckDB end-to-end)', () => {
  function queryDailyCosts(dateRange: DateRange, filters: FilterMap = {}, granularity: Granularity = 'daily'): Promise<DailyCostsResult> {
    const handler = ipc.dailyCosts;
    if (handler === undefined) throw new Error('query:daily-costs is not registered');
    // The line and stacked-bar widgets' default grouping.
    return handler({}, { groupBy: asDimensionId('service'), dateRange, filters, granularity });
  }

  function dates(result: DailyCostsResult): string[] {
    return result.days.map(d => d.date);
  }

  it('covers every day of synced months, though only three of them had spend', async () => {
    const result = await queryDailyCosts(range('2026-02-01', '2026-03-31'), { [asDimensionId('service')]: [asTagValue('AmazonEC2')] });
    expect(dates(result)).toEqual(['2026-02-03', '2026-02-20', '2026-03-05']);
    expect(result.totalCost).toBe(220);
    expect(result.coveredDays).toBe(28 + 31);
  });

  it('leaves out the days before the first synced month', async () => {
    // Jan 18 - Feb 14: February's 14 days are synced, one of them with spend.
    const result = await queryDailyCosts(range('2026-01-18', '2026-02-14'));
    expect(dates(result)).toEqual(['2026-02-03']);
    expect(result.totalCost).toBe(100);
    expect(result.coveredDays).toBe(14);
  });

  it('counts a synced month in full when a filter matches nothing in it: zero spend, not missing data', async () => {
    const result = await queryDailyCosts(range('2026-02-01', '2026-02-28'), { [asDimensionId('service')]: [asTagValue('AWS Lambda')] });
    expect(result.days).toEqual([]);
    expect(result.groups).toEqual([]);
    expect(result.totalCost).toBe(0);
    expect(result.coveredDays).toBe(28);
  });

  it('covers nothing of a range with no synced month', async () => {
    // No provider holds any of these months: the handler returns before
    // querying, and still says how much it covered.
    const result = await queryDailyCosts(range('2025-12-01', '2026-01-31'));
    expect(result.days).toEqual([]);
    expect(result.coveredDays).toBe(0);
  });

  it('reads the hourly tier\'s own months for an hourly query', async () => {
    // Only the daily tier is on disk.
    const result = await queryDailyCosts(range('2026-02-01', '2026-02-28'), {}, 'hourly');
    expect(result.coveredDays).toBe(0);
  });
});
