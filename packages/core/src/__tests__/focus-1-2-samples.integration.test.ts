/** Per-provider tests over the committed FOCUS 1.2 samples.
 *
 *  Each provider gets its own suite because each one's export is genuinely
 *  different: AWS ships the whole specification plus three extension columns,
 *  Azure ships it with `Tags` as a JSON document and no service-code column,
 *  and GCP ships neither `Tags` nor `ServiceCategory` at all. The cross-
 *  provider suite at the end is the payoff — once each export is projected
 *  onto the query contract, the same query answers all three identically. */

import { describe, it, expect, beforeAll } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildSource } from '../query/builder.js';
import type { DimensionsConfig } from '../types/config.js';
import { asDimensionId, asProviderName } from '../types/branded.js';
import { buildSampleCsv, SAMPLE_MONTH, SAMPLE_ROW_COUNT } from '../__fixtures__/focus-1-2/samples.js';
import {
  contractGap, mandatoryGap, NATIVE_COLUMNS, QUERY_CONTRACT_COLUMNS, SAMPLE_PROVIDERS,
} from '../__fixtures__/focus-1-2/shapes.js';
import type { SampleProvider } from '../__fixtures__/focus-1-2/shapes.js';
import { readSampleCsv, writeSampleParquet } from '../__fixtures__/focus-1-2/load.js';

type Conn = Awaited<ReturnType<Awaited<ReturnType<typeof DuckDBInstance.create>>['connect']>>;

let conn: Conn;
let dataDir: string;

const NO_TAGS: DimensionsConfig = {
  builtIn: [
    { name: asDimensionId('provider'), label: 'Provider', field: 'provider' },
    { name: asDimensionId('service'), label: 'Service', field: 'service' },
    { name: asDimensionId('account'), label: 'Account', field: 'account_id' },
  ],
  tags: [],
};

const WITH_TAGS: DimensionsConfig = {
  builtIn: NO_TAGS.builtIn,
  tags: [
    { tagName: 'team', label: 'Team' },
    { tagName: 'system', label: 'System' },
  ],
};

async function rowsOf(sql: string): Promise<Record<string, unknown>[]> {
  const result = await conn.run(sql);
  return result.getRowObjects();
}

/** Sum a numeric aggregate, tolerating DuckDB's DECIMAL row objects. */
function num(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  // DuckDB returns DECIMAL columns as { value, scale, width }.
  if (typeof value === 'object' && value !== null && 'value' in value && 'scale' in value) {
    return Number(value.value) / 10 ** Number(value.scale);
  }
  throw new Error(`not a number: ${JSON.stringify(value)}`);
}

function sourceFor(provider: SampleProvider, dimensions: DimensionsConfig): string {
  return buildSource({
    dataDir, tier: 'daily', dimensions,
    providers: [{ name: asProviderName(provider), periods: [SAMPLE_MONTH] }],
    costMetric: 'billed',
  });
}

beforeAll(async () => {
  const db = await DuckDBInstance.create();
  conn = await db.connect();
  dataDir = await mkdtemp(join(tmpdir(), 'cg-focus12-'));
  for (const provider of SAMPLE_PROVIDERS) {
    await writeSampleParquet(conn, provider, dataDir, 'native');
    await writeSampleParquet(conn, provider, dataDir, 'contract');
  }
}, 60_000);

describe('FOCUS 1.2 samples — shape', () => {
  it.each(SAMPLE_PROVIDERS)('%s: the committed CSV is what the generator produces', async provider => {
    // Guards the case where someone edits the generator and forgets to
    // regenerate — the committed file is the fixture, the generator is only
    // how it got there.
    expect(await readSampleCsv(provider)).toBe(buildSampleCsv(provider));
  });

  it.each(SAMPLE_PROVIDERS)('%s: header and row count match the declared native shape', async provider => {
    const lines = (await readSampleCsv(provider)).trimEnd().split('\n');
    expect(lines[0]?.split(',')).toEqual([...NATIVE_COLUMNS[provider]]);
    expect(lines.length - 1).toBe(SAMPLE_ROW_COUNT);
  });

  it('bills the same money on all three providers', async () => {
    // The samples render one set of billing events three ways, so any
    // difference between them is a difference in export shape, never in the
    // underlying month.
    const totals = await Promise.all(SAMPLE_PROVIDERS.map(async provider => {
      const rows = await rowsOf(`SELECT SUM(BilledCost) AS total FROM read_parquet('${join(dataDir, `${provider}-native`, 'raw', `daily-${SAMPLE_MONTH}`, 'data.parquet')}')`);
      return num(rows[0]?.['total']);
    }));
    expect(totals[0]).toBeCloseTo(Number(totals[1]), 2);
    expect(totals[0]).toBeCloseTo(Number(totals[2]), 2);
  });
});

describe('AWS FOCUS 1.2 Data Export', () => {
  it('is FOCUS 1.2 conformant and needs no adaptation', () => {
    expect(mandatoryGap('aws')).toEqual([]);
    // Every column the query layer reads is already in the export — AWS is
    // the provider the contract was shaped around.
    expect(contractGap('aws')).toEqual([]);
  });

  it('delivers Tags as a Parquet MAP', async () => {
    const [row] = await rowsOf(`SELECT typeof(Tags) AS t FROM read_parquet('${join(dataDir, 'aws-native', 'raw', `daily-${SAMPLE_MONTH}`, 'data.parquet')}') LIMIT 1`);
    expect(row?.['t']).toBe('MAP(VARCHAR, VARCHAR)');
  });

  it('queries straight off the native export', async () => {
    const source = sourceFor('aws', NO_TAGS);
    const [row] = await rowsOf(`SELECT COUNT(*) AS n, ROUND(SUM(cost), 2) AS total FROM ${source}`);
    expect(Number(row?.['n'])).toBe(SAMPLE_ROW_COUNT);
    expect(num(row?.['total'])).toBeGreaterThan(0);
  });

  it('carries a marketplace row with no service code, attributed by publisher', async () => {
    // Absent values load as NULL, the way a real export delivers them — hence
    // the COALESCE, which is also what buildSource does on every column.
    const rows = await rowsOf(`
      SELECT DISTINCT PublisherName FROM read_parquet('${join(dataDir, 'aws-native', 'raw', `daily-${SAMPLE_MONTH}`, 'data.parquet')}')
      WHERE COALESCE(x_ServiceCode, '') = '' AND COALESCE(ServiceName, '') = ''`);
    expect(rows).toEqual([{ PublisherName: 'Anthropic' }]);
  });

  it('keeps commitment coverage on the standard FOCUS columns', async () => {
    const rows = await rowsOf(`
      SELECT CommitmentDiscountStatus AS status, COUNT(*) AS n
      FROM read_parquet('${join(dataDir, 'aws-native', 'raw', `daily-${SAMPLE_MONTH}`, 'data.parquet')}')
      WHERE CommitmentDiscountStatus <> '' GROUP BY 1 ORDER BY 1`);
    expect(rows.map(r => r['status'])).toEqual(['Unused', 'Used']);
  });
});

describe('Azure Cost Management FOCUS 1.2 export (provider not supported yet)', () => {
  it('is FOCUS 1.2 conformant but misses the two AWS extension columns', () => {
    expect(mandatoryGap('azure')).toEqual([]);
    // The only gap is AWS-specific: Azure publishes no service code and no
    // operation dimension, so an adapter has to synthesize both.
    expect(contractGap('azure')).toEqual(['x_ServiceCode', 'x_Operation']);
  });

  it('delivers Tags as a JSON document, not a MAP', async () => {
    const [row] = await rowsOf(`SELECT typeof(Tags) AS t FROM read_parquet('${join(dataDir, 'azure-native', 'raw', `daily-${SAMPLE_MONTH}`, 'data.parquet')}') LIMIT 1`);
    expect(row?.['t']).toBe('JSON');
  });

  it('cannot be queried natively — the missing columns are a binder error', async () => {
    // union_by_name NULL-fills a column missing from *some* file in a glob;
    // a column missing from every file still fails to bind. This is what
    // makes the canonicalization step mandatory rather than cosmetic.
    const source = buildSource({
      dataDir, tier: 'daily', dimensions: NO_TAGS,
      providers: [{ name: asProviderName('azure-native'), periods: [SAMPLE_MONTH] }],
      costMetric: 'billed',
    });
    await expect(rowsOf(`SELECT SUM(cost) FROM ${source}`)).rejects.toThrow(/x_ServiceCode/);
  });

  it('queries once projected onto the contract', async () => {
    const source = sourceFor('azure', NO_TAGS);
    const [row] = await rowsOf(`SELECT COUNT(*) AS n, ROUND(SUM(cost), 2) AS total FROM ${source}`);
    expect(Number(row?.['n'])).toBe(SAMPLE_ROW_COUNT);
    expect(num(row?.['total'])).toBeGreaterThan(0);
  });

  it('resolves tags written in Azure PascalCase once mapped to a MAP', async () => {
    // Azure preserves the casing a user typed; the sample uses `Team`, so a
    // dimension configured for `team` finds nothing until the key casing is
    // reconciled. Worth pinning: it is the kind of gap that shows up as a
    // silently empty dimension rather than an error.
    const source = sourceFor('azure', WITH_TAGS);
    const [row] = await rowsOf(`SELECT COUNT(tag_team) AS tagged FROM ${source}`);
    expect(Number(row?.['tagged'])).toBe(0);

    const casedSource = sourceFor('azure', {
      builtIn: NO_TAGS.builtIn,
      tags: [{ tagName: 'Team', label: 'Team' }],
    });
    const [cased] = await rowsOf(`SELECT COUNT(tag_Team) AS tagged FROM ${casedSource}`);
    expect(Number(cased?.['tagged'])).toBeGreaterThan(0);
  });
});

describe('GCP FOCUS 1.2 BigQuery export (provider not supported yet)', () => {
  it('omits three unconditionally-mandatory FOCUS 1.2 columns', () => {
    // Not a gap in our tooling — a gap in Google's export. Pinned here so a
    // future export revision that closes it is noticed.
    expect(mandatoryGap('gcp')).toEqual([
      'BillingAccountName', 'InvoiceIssuerName', 'ServiceCategory',
    ]);
  });

  it('is missing six of the columns the query layer reads', () => {
    expect(contractGap('gcp')).toEqual([
      'ServiceCategory', 'CommitmentDiscountStatus', 'SkuMeter', 'Tags',
      'x_ServiceCode', 'x_Operation',
    ]);
  });

  it('has no Tags column at all — labels arrive as repeated records', async () => {
    const native = join(dataDir, 'gcp-native', 'raw', `daily-${SAMPLE_MONTH}`, 'data.parquet');
    const cols = await rowsOf(`SELECT name FROM parquet_schema('${native}')`);
    const names = cols.map(c => String(c['name']));
    expect(names).not.toContain('Tags');
    const [row] = await rowsOf(`SELECT typeof(x_Labels) AS t FROM read_parquet('${native}') LIMIT 1`);
    expect(row?.['t']).toBe('STRUCT("Key" VARCHAR, "Value" VARCHAR)[]');
  });

  it('reports commitment coverage through x_Credits, not CommitmentDiscount*', async () => {
    const native = join(dataDir, 'gcp-native', 'raw', `daily-${SAMPLE_MONTH}`, 'data.parquet');
    const [row] = await rowsOf(`
      SELECT COUNT(*) AS n FROM read_parquet('${native}')
      WHERE len(list_filter(x_Credits, c -> c."Type" = 'COMMITTED_USAGE_DISCOUNT')) > 0`);
    expect(Number(row?.['n'])).toBeGreaterThan(0);
  });

  it('queries once projected onto the contract', async () => {
    const source = sourceFor('gcp', NO_TAGS);
    const [row] = await rowsOf(`SELECT COUNT(*) AS n, ROUND(SUM(cost), 2) AS total FROM ${source}`);
    expect(Number(row?.['n'])).toBe(SAMPLE_ROW_COUNT);
    expect(num(row?.['total'])).toBeGreaterThan(0);
  });

  it('merges label sources with tag bindings winning on a shared key', async () => {
    // The sample sets `environment` in both x_Labels (varying) and x_Tags
    // (always `production`). The projection builds the map weakest-source
    // first, so the tag binding is the value that survives.
    const source = sourceFor('gcp', {
      builtIn: NO_TAGS.builtIn,
      tags: [{ tagName: 'environment', label: 'Environment' }, { tagName: 'team', label: 'Team' }],
    });
    const envs = await rowsOf(`SELECT DISTINCT tag_environment AS env FROM ${source} WHERE tag_environment IS NOT NULL`);
    expect(envs).toEqual([{ env: 'production' }]);
    // A key only x_Labels carries still comes through.
    const [teams] = await rowsOf(`SELECT COUNT(DISTINCT tag_team) AS n FROM ${source}`);
    expect(Number(teams?.['n'])).toBeGreaterThan(1);
  });

  it('distinguishes used from unused commitment by the credit sign', async () => {
    // Both states are the same x_Credits type; only the sign separates them,
    // so a projection keyed on the type alone reports every commitment row as
    // 'Used' and silently loses the unused one.
    const source = sourceFor('gcp', NO_TAGS);
    const rows = await rowsOf(`
      SELECT commitment_status, COUNT(*) AS n FROM ${source}
      WHERE commitment_status <> '' GROUP BY 1 ORDER BY 1`);
    expect(rows.map(r => [r['commitment_status'], Number(r['n'])])).toEqual([
      ['Unused', 1], ['Used', 14],
    ]);
  });

  it('leaves service_category empty rather than inventing one', async () => {
    const source = sourceFor('gcp', NO_TAGS);
    const rows = await rowsOf(`SELECT DISTINCT service_category FROM ${source}`);
    expect(rows).toEqual([{ service_category: '' }]);
  });
});

describe('cross-provider', () => {
  it('answers one query over all three exports once they share the contract', async () => {
    const source = buildSource({
      dataDir, tier: 'daily', dimensions: NO_TAGS,
      providers: SAMPLE_PROVIDERS.map(p => ({ name: asProviderName(p), periods: [SAMPLE_MONTH] })),
      costMetric: 'billed',
    });
    const rows = await rowsOf(`SELECT provider, COUNT(*) AS n, ROUND(SUM(cost), 2) AS total FROM ${source} GROUP BY provider ORDER BY provider`);
    expect(rows.map(r => r['provider'])).toEqual(['aws', 'azure', 'gcp']);
    for (const row of rows) expect(Number(row['n'])).toBe(SAMPLE_ROW_COUNT);
    // Same billing events on every provider, so the totals agree to the cent.
    const totals = rows.map(r => num(r['total']));
    expect(totals[1]).toBeCloseTo(Number(totals[0]), 2);
    expect(totals[2]).toBeCloseTo(Number(totals[0]), 2);
  });

  it('agrees on the commitment split across all three exports', async () => {
    // The same month is billed on every provider, so the canonical form has
    // to report the same commitment states — however differently each export
    // encodes them. This is the assertion that catches a projection which
    // drops or mislabels a state rather than merely renaming it.
    for (const provider of SAMPLE_PROVIDERS) {
      const source = sourceFor(provider, NO_TAGS);
      const rows = await rowsOf(`
        SELECT commitment_status, COUNT(*) AS n FROM ${source}
        WHERE commitment_status <> '' GROUP BY 1 ORDER BY 1`);
      expect(rows.map(r => [r['commitment_status'], Number(r['n'])]), provider).toEqual([
        ['Unused', 1], ['Used', 14],
      ]);
    }
  });

  it('keeps every contract column physically present in each canonical file', async () => {
    for (const provider of SAMPLE_PROVIDERS) {
      const path = join(dataDir, provider, 'raw', `daily-${SAMPLE_MONTH}`, 'data.parquet');
      const cols = await rowsOf(`SELECT name FROM parquet_schema('${path}')`);
      const names = new Set(cols.map(c => String(c['name'])));
      for (const col of QUERY_CONTRACT_COLUMNS) {
        expect(names.has(col), `${provider} is missing ${col}`).toBe(true);
      }
    }
  });
});
