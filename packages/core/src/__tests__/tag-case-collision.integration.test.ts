import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCostQuery, buildRollupPartitionQuery, sqlStringLiteral } from '../query/builder.js';
import type { QueryContextOptions } from '../query/builder.js';
import { rollupGrainColumns } from '../rollup/grain.js';
import { asDateString, asDimensionId, asProviderName, asTagValue, tagDimColumn, tagSqlColumn } from '../types/branded.js';
import type { DimensionsConfig, TagDimension } from '../types/config.js';
import type { FilterMap } from '../types/query.js';

/**
 * A customer had both a `STAGE` and a `stage` tag, each with its own values,
 * and both dimensions showed the values of whichever was declared first.
 * DuckDB identifiers are case-insensitive even when quoted, so the
 * `tag_STAGE` / `tag_stage` columns were one column to every query reading
 * them, and a persisted rollup silently renamed the second to `tag_stage_1`.
 * Locked the Layer-2 way: real Parquet, real DuckDB, both declaration orders.
 */

const PROVIDER = asProviderName('aws');
const UPPER: TagDimension = { tagName: 'STAGE', label: 'Stage (upper)' };
const LOWER: TagDimension = { tagName: 'stage', label: 'Stage (lower)' };
const DATE_RANGE = { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') };

/** Positional $1..$n binding, mirroring the duckdb-worker's. */
async function runPrepared(conn: DuckDBConnection, sql: string, params: readonly unknown[]): Promise<Record<string, unknown>[]> {
  const stmt = await conn.prepare(sql);
  try {
    params.forEach((value, i) => {
      if (typeof value === 'string') stmt.bindVarchar(i + 1, value);
      else if (typeof value === 'number' && Number.isInteger(value)) stmt.bindInteger(i + 1, value);
      else throw new Error(`unexpected query parameter ${String(value)}`);
    });
    const reader = await stmt.runAndReadAll();
    return reader.getRowObjectsJson();
  } finally {
    stmt.destroySync();
  }
}

describe('tag dimensions whose keys differ only by case (DuckDB execution)', () => {
  let db: DuckDBInstance;
  let conn: DuckDBConnection;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = (await mkdtemp(join(tmpdir(), 'cg-tag-case-'))).replaceAll('\\', '/');
    const monthDir = join(dataDir, 'aws', 'raw', 'daily-2026-01');
    await mkdir(monthDir, { recursive: true });
    db = await DuckDBInstance.create();
    conn = await db.connect();

    // Every row carries both keys, with different values under each.
    await conn.run(`
      COPY (
        SELECT * FROM (VALUES
          (TIMESTAMP '2026-01-05 00:00:00', 'acct-1', 'Account One', 'eu-west-1',
           'Amazon Elastic Compute Cloud', 'AmazonEC2', 'Compute', 'instance usage',
           10.0, 12.0, 'arn:aws:ec2:res-1', 10.0, 'Usage', 'Standard', '',
           'RunInstances', 'BoxUsage', MAP {'STAGE': 'PROD', 'stage': 'dev'}),
          (TIMESTAMP '2026-01-06 00:00:00', 'acct-2', 'Account Two', 'eu-west-1',
           'Amazon Simple Storage Service', 'AmazonS3', 'Storage', 'storage usage',
           5.0, 6.0, 'arn:aws:s3:res-2', 5.0, 'Usage', 'Standard', '',
           'PutObject', 'TimedStorage', MAP {'STAGE': 'QA', 'stage': 'test'})
        ) AS t(ChargePeriodStart, SubAccountId, SubAccountName, RegionId,
               ServiceName, x_ServiceCode, ServiceCategory, ChargeDescription,
               ConsumedQuantity, ListCost, ResourceId, EffectiveCost,
               ChargeCategory, PricingCategory, CommitmentDiscountStatus,
               x_Operation, SkuMeter, Tags)
      ) TO ${sqlStringLiteral(join(monthDir, 'data.parquet').replaceAll('\\', '/'))} (FORMAT PARQUET)
    `);
  });

  afterAll(async () => {
    conn.disconnectSync();
    db.closeSync();
    await rm(dataDir, { recursive: true, force: true });
  });

  function optsFor(tags: readonly TagDimension[]): QueryContextOptions {
    const dimensions: DimensionsConfig = { builtIn: [], tags: [...tags] };
    return { dataDir, dimensions, providers: [{ name: PROVIDER, availablePeriods: ['2026-01'] }] };
  }

  function filterOn(tag: TagDimension, value: string): FilterMap {
    return { [asDimensionId(tagDimColumn(tag))]: [asTagValue(value)] };
  }

  async function entitiesGroupedBy(
    opts: QueryContextOptions,
    tag: TagDimension,
    filters: FilterMap = {},
  ): Promise<string[]> {
    const q = buildCostQuery({ groupBy: asDimensionId(tagDimColumn(tag)), dateRange: DATE_RANGE, filters }, opts);
    const rows = await runPrepared(conn, q.sql, q.params);
    return [...new Set(rows.map(r => String(r['entity'])))].sort((a, b) => a.localeCompare(b));
  }

  for (const [order, tags] of [['STAGE first', [UPPER, LOWER]], ['stage first', [LOWER, UPPER]]] as const) {
    it(`groups each dimension by its own tag key (${order})`, async () => {
      const opts = optsFor(tags);
      expect(await entitiesGroupedBy(opts, UPPER)).toEqual(['PROD', 'QA']);
      expect(await entitiesGroupedBy(opts, LOWER)).toEqual(['dev', 'test']);
    });

    it(`filters on one key while grouping by the other (${order})`, async () => {
      const opts = optsFor(tags);
      expect(await entitiesGroupedBy(opts, UPPER, filterOn(LOWER, 'dev'))).toEqual(['PROD']);
      expect(await entitiesGroupedBy(opts, LOWER, filterOn(UPPER, 'QA'))).toEqual(['test']);
    });
  }

  it('persists both keys as separate rollup columns with their own values', async () => {
    const opts = optsFor([UPPER, LOWER]);
    const outPath = join(dataDir, 'rollup-2026-01.parquet').replaceAll('\\', '/');
    await conn.run(buildRollupPartitionQuery('2026-01', 'daily', outPath, opts));

    // No column was renamed on write (`tag_stage_1`): the file holds exactly
    // the grain the rollup readers will ask for.
    const schema = await runPrepared(conn, `SELECT name FROM parquet_schema(${sqlStringLiteral(outPath)}) WHERE name <> 'duckdb_schema'`, []);
    expect(schema.map(r => String(r['name']))).toEqual([...rollupGrainColumns(opts.dimensions), 'cost', 'line_items']);

    const rows = await runPrepared(
      conn,
      `SELECT ${tagSqlColumn(UPPER)} AS upper_value, ${tagSqlColumn(LOWER)} AS lower_value
       FROM read_parquet(${sqlStringLiteral(outPath)}) ORDER BY upper_value`,
      [],
    );
    expect(rows).toEqual([
      { upper_value: 'PROD', lower_value: 'dev' },
      { upper_value: 'QA', lower_value: 'test' },
    ]);
  });
});
