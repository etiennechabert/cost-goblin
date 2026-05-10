import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import { mkdtemp, rm, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildCostQuery,
  buildDailyCostsQuery,
  buildMissingTagsQuery,
} from '../query/builder.js';
import {
  deriveRollupSchema,
  buildOnePeriod,
  hashRawEtags,
  computeRollupAvailability,
  isRollupEligible,
  rollupParquetPath,
} from '../rollup/index.js';
import type { DimensionsConfig } from '../types/config.js';
import { asDimensionId, asDateString, asDollars } from '../types/branded.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYNTHETIC_SRC = join(__dirname, '..', '__fixtures__', 'synthetic');

const dimensions: DimensionsConfig = {
  builtIn: [
    { name: asDimensionId('account_id'), label: 'Account', field: 'account_id', displayField: 'account_name' },
    { name: asDimensionId('service'), label: 'Service', field: 'service' },
    { name: asDimensionId('region'), label: 'Region', field: 'region' },
    { name: asDimensionId('resource_id'), label: 'Resource', field: 'resource_id', enabled: false },
  ],
  tags: [
    { tagName: 'team', label: 'Team', concept: 'owner' },
    { tagName: 'environment', label: 'Environment', concept: 'environment' },
  ],
};

interface QueryRow { [key: string]: unknown }

async function queryAll(conn: Awaited<ReturnType<Awaited<ReturnType<typeof DuckDBInstance.create>>['connect']>>, sql: string): Promise<QueryRow[]> {
  const result = await conn.run(sql);
  const cols = result.columnCount;
  const names: string[] = [];
  for (let i = 0; i < cols; i++) names.push(result.columnName(i));
  const rows: QueryRow[] = [];
  let chunk = await result.fetchChunk();
  while (chunk !== null && chunk.rowCount > 0) {
    for (let r = 0; r < chunk.rowCount; r++) {
      const row: QueryRow = {};
      for (let c = 0; c < cols; c++) {
        const name = names[c];
        if (name !== undefined) row[name] = chunk.getColumnVector(c).getItem(r);
      }
      rows.push(row);
    }
    chunk = await result.fetchChunk();
  }
  return rows;
}

function substituteParams(sql: string, params: readonly unknown[]): string {
  let result = sql;
  for (let i = params.length; i >= 1; i--) {
    const param = params[i - 1];
    const placeholder = '$' + String(i);
    const value = typeof param === 'string' ? `'${param}'` : String(param);
    result = result.replaceAll(placeholder, value);
  }
  return result;
}

async function setUpDataDir(): Promise<string> {
  // Copy synthetic raw parquet into a temp data dir so we can build rollups
  // alongside (and not pollute the committed fixture tree).
  const root = await mkdtemp(join(tmpdir(), 'cg-rollup-'));
  await mkdir(join(root, 'aws', 'raw', 'daily-2026-01'), { recursive: true });
  await mkdir(join(root, 'aws', 'raw', 'daily-2026-02'), { recursive: true });
  await copyFile(
    join(SYNTHETIC_SRC, 'aws', 'raw', 'daily-2026-01', 'data.parquet'),
    join(root, 'aws', 'raw', 'daily-2026-01', 'data.parquet'),
  );
  await copyFile(
    join(SYNTHETIC_SRC, 'aws', 'raw', 'daily-2026-02', 'data.parquet'),
    join(root, 'aws', 'raw', 'daily-2026-02', 'data.parquet'),
  );
  // Fake sync-etags so freshPeriods has something to hash. Real sync writes
  // these; the test mimics that step.
  await writeFile(join(root, 'sync-etags.json'), JSON.stringify({
    '2026-01': { 'daily/2026-01/data.parquet': 'etag-jan' },
    '2026-02': { 'daily/2026-02/data.parquet': 'etag-feb' },
  }));
  return root;
}

describe('rollup integration', () => {
  let db: Awaited<ReturnType<typeof DuckDBInstance.create>>;
  let conn: Awaited<ReturnType<typeof db.connect>>;
  let dataDir: string;

  beforeAll(async () => {
    db = await DuckDBInstance.create();
    conn = await db.connect();
    dataDir = await setUpDataDir();
  });

  afterAll(async () => {
    if (dataDir !== '') await rm(dataDir, { recursive: true, force: true });
  });

  it('schema hash is stable for identical config and changes when config changes', () => {
    const a = deriveRollupSchema(dimensions, 'unblended', 'gross');
    const b = deriveRollupSchema(dimensions, 'unblended', 'gross');
    expect(a.hash).toBe(b.hash);

    // Add a tag — hash must change so the rollup is treated as stale.
    const withExtra: DimensionsConfig = {
      ...dimensions,
      tags: [...dimensions.tags, { tagName: 'cost_center', label: 'Cost Center' }],
    };
    expect(deriveRollupSchema(withExtra, 'unblended', 'gross').hash).not.toBe(a.hash);

    // Changing cost metric also bumps hash — different rollup contents.
    expect(deriveRollupSchema(dimensions, 'amortized', 'gross').hash).not.toBe(a.hash);

    // Disabling a built-in changes the carried column set, hence the hash.
    const disabled: DimensionsConfig = {
      ...dimensions,
      builtIn: dimensions.builtIn.map(d =>
        d.field === 'region' ? { ...d, enabled: false } : d,
      ),
    };
    expect(deriveRollupSchema(disabled, 'unblended', 'gross').hash).not.toBe(a.hash);
  });

  it('schema does not include resource_id', () => {
    const schema = deriveRollupSchema(dimensions, 'unblended', 'gross');
    expect(schema.builtInFields).not.toContain('resource_id');
    expect(schema.builtInFields).toContain('account_id');
    expect(schema.builtInFields).toContain('region');
    expect(schema.builtInFields).toContain('service');
    expect(schema.tagColumns).toEqual(expect.arrayContaining(['tag_team', 'tag_environment']));
  });

  it('builds a rollup parquet whose totals match raw to the cent', async () => {
    const schema = deriveRollupSchema(dimensions, 'unblended', 'gross');
    const rawHash = hashRawEtags({ 'daily/2026-01/data.parquet': 'etag-jan' });

    await buildOnePeriod({
      dataDir,
      period: '2026-01',
      schema,
      rawHash,
      availableColumns: undefined,
      runQuery: async (sql) => queryAll(conn, sql),
    });

    const [rawTotal] = await queryAll(conn,
      `SELECT SUM(line_item_unblended_cost) AS t FROM read_parquet('${join(dataDir, 'aws', 'raw', 'daily-2026-01', '*.parquet')}')`,
    );
    const [rollupTotal] = await queryAll(conn,
      `SELECT SUM(cost) AS t FROM read_parquet('${rollupParquetPath(dataDir, '2026-01')}')`,
    );
    // Use exact equality — SUM is associative under floats only when the
    // grouping doesn't reorder; the test passes today because the synthetic
    // fixture is small enough that float drift is below the printed
    // precision. Use closeTo with a generous epsilon for safety.
    expect(Number(rollupTotal?.['t'])).toBeCloseTo(Number(rawTotal?.['t']), 4);
  });

  it('availability sees freshly-built periods', async () => {
    const schema = deriveRollupSchema(dimensions, 'unblended', 'gross');
    const avail = await computeRollupAvailability(dataDir, schema);
    expect(avail.fresh.has('2026-01')).toBe(true);
    // 2026-02 wasn't built in the previous test.
    expect(avail.fresh.has('2026-02')).toBe(false);
  });

  it('eligibility blocks resource_id queries, allows service queries', () => {
    const schema = deriveRollupSchema(dimensions, 'unblended', 'gross');
    expect(isRollupEligible({
      schema, dimensions,
      referencedDimensionIds: [asDimensionId('service')],
    })).toBe(true);
    expect(isRollupEligible({
      schema, dimensions,
      referencedDimensionIds: [asDimensionId('resource_id')],
    })).toBe(false);
    expect(isRollupEligible({
      schema, dimensions,
      referencedDimensionIds: [asDimensionId('service')],
      needsRawRows: true,
    })).toBe(false);
  });

  it('cost query against rollup returns identical totals to raw query', async () => {
    const schema = deriveRollupSchema(dimensions, 'unblended', 'gross');
    // Need both periods built for the date range below.
    await buildOnePeriod({
      dataDir,
      period: '2026-02',
      schema,
      rawHash: hashRawEtags({ 'daily/2026-02/data.parquet': 'etag-feb' }),
      availableColumns: undefined,
      runQuery: async (sql) => queryAll(conn, sql),
    });
    const avail = await computeRollupAvailability(dataDir, schema);

    const params = {
      groupBy: asDimensionId('service'),
      dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-02-28') },
      filters: {},
    };

    const raw = buildCostQuery(params, {
      dataDir, dimensions, availablePeriods: ['2026-01', '2026-02'],
    });
    const fast = buildCostQuery(params, {
      dataDir, dimensions, availablePeriods: ['2026-01', '2026-02'],
      rollupSchema: schema, rollupFreshPeriods: avail.fresh,
    });

    // Build query SQL is different — rollup version reads from rollup parquet.
    expect(fast.sql).not.toBe(raw.sql);
    expect(fast.sql).toContain('rollup/daily-');
    expect(raw.sql).not.toContain('rollup/daily-');

    const rawRows = await queryAll(conn,
      `SELECT SUM(total_cost) AS t FROM (${substituteParams(raw.sql, raw.params)})`,
    );
    const fastRows = await queryAll(conn,
      `SELECT SUM(total_cost) AS t FROM (${substituteParams(fast.sql, fast.params)})`,
    );
    expect(Number(fastRows[0]?.['t'])).toBeCloseTo(Number(rawRows[0]?.['t']), 2);
  });

  it('daily-costs query against rollup returns identical per-day totals to raw', async () => {
    const schema = deriveRollupSchema(dimensions, 'unblended', 'gross');
    const avail = await computeRollupAvailability(dataDir, schema);

    const params = {
      groupBy: asDimensionId('service'),
      dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') },
      filters: {},
    };

    const raw = buildDailyCostsQuery(params, {
      dataDir, dimensions, availablePeriods: ['2026-01'],
    });
    const fast = buildDailyCostsQuery(params, {
      dataDir, dimensions, availablePeriods: ['2026-01'],
      rollupSchema: schema, rollupFreshPeriods: avail.fresh,
    });

    const rawRows = await queryAll(conn,
      `SELECT date, SUM(cost) AS c FROM (${substituteParams(raw.sql, raw.params)}) GROUP BY date ORDER BY date`,
    );
    const fastRows = await queryAll(conn,
      `SELECT date, SUM(cost) AS c FROM (${substituteParams(fast.sql, fast.params)}) GROUP BY date ORDER BY date`,
    );
    expect(fastRows.length).toBe(rawRows.length);
    for (let i = 0; i < rawRows.length; i++) {
      const r = rawRows[i];
      const f = fastRows[i];
      if (r === undefined || f === undefined) continue;
      expect(String(f['date'])).toBe(String(r['date']));
      expect(Number(f['c'])).toBeCloseTo(Number(r['c']), 2);
    }
  });

  it('missing-tags query falls back to raw — rollup never used (resource_id required)', () => {
    const schema = deriveRollupSchema(dimensions, 'unblended', 'gross');
    const result = buildMissingTagsQuery(
      {
        dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') },
        filters: {},
        minCost: asDollars(0),
        tagDimension: asDimensionId('tag_team'),
      },
      {
        dataDir, dimensions, availablePeriods: ['2026-01'],
        rollupSchema: schema, rollupFreshPeriods: new Set(['2026-01']),
      },
    );
    // No matter what we passed for rollup availability, the missing-tags query
    // never opts in — its SQL stays on raw parquet.
    expect(result.sql).not.toContain('rollup/daily-');
    expect(result.sql).toContain('aws/raw/daily-');
  });
});
