import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import { join } from 'node:path';
import { buildSource } from '../query/builder.js';
import type { DimensionsConfig } from '../types/config.js';
import { asDimensionId, asProviderName } from '../types/branded.js';
import { FIXTURE_GCP_PROVIDER_NAME, FIXTURE_PROVIDER_NAME } from '../__fixtures__/layout.js';

/**
 * The committed fixture tree gained a second provider so the mixed-workspace
 * e2e has something to query. This suite is that e2e's premise, checked in the
 * fast layer: if `gcp-main/` is not genuinely GCP-shaped, the e2e proves
 * nothing — it would just be two AWS branches under different names.
 *
 * The fixture is written by the real canonicalizer at global setup, so what is
 * asserted here is the post-sync layout an actual GCP provider produces.
 */

type Conn = Awaited<ReturnType<Awaited<ReturnType<typeof DuckDBInstance.create>>['connect']>>;

const DATA_DIR = join(import.meta.dirname, '..', '__fixtures__', 'synthetic');
const GCP_PARQUET = join(DATA_DIR, FIXTURE_GCP_PROVIDER_NAME, 'raw', 'daily-2026-01', 'part-0.parquet');

const dimensions: DimensionsConfig = {
  builtIn: [
    { name: asDimensionId('provider'), label: 'Provider', field: 'provider' },
    { name: asDimensionId('service'), label: 'Service', field: 'service' },
    { name: asDimensionId('account'), label: 'Account', field: 'account_id' },
  ],
  tags: [{ label: 'Team', tagName: 'team' }],
};

let conn: Conn;
let ownedInstance: DuckDBInstance | null = null;

async function rowsOf(sql: string): Promise<Record<string, unknown>[]> {
  const result = await conn.run(sql);
  return result.getRowObjects();
}

beforeAll(async () => {
  const instance = await DuckDBInstance.create();
  ownedInstance = instance;
  conn = await instance.connect();
  await conn.run(`SET TimeZone='Europe/Berlin'`);
});

afterAll(() => {
  conn.disconnectSync();
  ownedInstance?.closeSync();
  ownedInstance = null;
});

describe('the gcp-main fixture is genuinely GCP-shaped', () => {
  it('carries MAP tags and DOUBLE costs, as the query layer requires', async () => {
    const types = new Map(
      (await rowsOf(`DESCRIBE SELECT * FROM read_parquet('${GCP_PARQUET}')`))
        .map(r => [String(r['column_name']), String(r['column_type'])]),
    );
    expect(types.get('Tags')).toBe('MAP(VARCHAR, VARCHAR)');
    expect(types.get('BilledCost')).toBe('DOUBLE');
    // Naive, not tz-aware: `::DATE` resolves in the session timezone, so a
    // TIMESTAMP WITH TIME ZONE here would bucket rows into the wrong day
    // anywhere east of UTC.
    expect(types.get('ChargePeriodStart')).toBe('TIMESTAMP');
  });

  it('materializes the columns GCP does not deliver, rather than omitting them', async () => {
    // A column absent from every file on one branch is a binder error at query
    // time, not a NULL fill — so the canonicalizer has to synthesize them.
    const names = new Set(
      (await rowsOf(`DESCRIBE SELECT * FROM read_parquet('${GCP_PARQUET}')`))
        .map(r => String(r['column_name'])),
    );
    for (const col of ['ServiceCategory', 'CommitmentDiscountStatus', 'x_ServiceCode', 'x_Operation', 'SkuMeter']) {
      expect(names.has(col), col).toBe(true);
    }
  });

  it('holds GCP service names and project-shaped accounts, not the AWS ones', async () => {
    const rows = await rowsOf(`SELECT DISTINCT ServiceName FROM read_parquet('${GCP_PARQUET}') ORDER BY 1`);
    const services = rows.map(r => String(r['ServiceName']));
    expect(services).toContain('Compute Engine');
    expect(services.some(s => s.startsWith('Amazon'))).toBe(false);

    const accounts = await rowsOf(`SELECT DISTINCT SubAccountId FROM read_parquet('${GCP_PARQUET}')`);
    expect(accounts.every(r => String(r['SubAccountId']).startsWith('proj-'))).toBe(true);
  });
});

describe('the fixture tree serves a mixed workspace', () => {
  function source(providers: readonly string[]): string {
    return buildSource({
      dataDir: DATA_DIR,
      tier: 'daily',
      dimensions,
      providers: providers.map(name => ({ name: asProviderName(name), periods: ['2026-01', '2026-02'] })),
      costMetric: 'billed',
    });
  }

  it('is invisible to the single-provider baseline', async () => {
    // The dozen suites asserting exact totals list only aws-main, and
    // buildSource globs per CONFIGURED provider — so adding gcp-main to the
    // tree must not move a single one of those numbers.
    const rows = await rowsOf(`SELECT DISTINCT provider FROM ${source([FIXTURE_PROVIDER_NAME])}`);
    expect(rows).toEqual([{ provider: FIXTURE_PROVIDER_NAME }]);
  });

  it('unions both providers when both are configured', async () => {
    const rows = await rowsOf(`SELECT provider, COUNT(*) AS n FROM ${source([FIXTURE_PROVIDER_NAME, FIXTURE_GCP_PROVIDER_NAME])} GROUP BY provider ORDER BY provider`);
    expect(rows).toHaveLength(2);
    expect(rows.map(r => String(r['provider']))).toEqual([FIXTURE_PROVIDER_NAME, FIXTURE_GCP_PROVIDER_NAME]);
    for (const r of rows) expect(Number(r['n'])).toBeGreaterThan(0);
  });

  it('shares tag values across the two providers, so a tag rollup spans both', async () => {
    // Derived from the same synthetic rows on purpose: a mixed query has to
    // have something to get wrong. If the tag expression failed on one branch
    // the owner totals would come from a single provider.
    const rows = await rowsOf(`SELECT tag_team, COUNT(DISTINCT provider) AS providers
      FROM ${source([FIXTURE_PROVIDER_NAME, FIXTURE_GCP_PROVIDER_NAME])}
      WHERE tag_team IS NOT NULL AND tag_team <> ''
      GROUP BY 1 ORDER BY 1`);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(Number(r['providers']), String(r['tag_team'])).toBe(2);
  });
});
