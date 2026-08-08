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
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildSource, NO_ACCOUNT_SENTINEL } from '../query/builder.js';
import type { DimensionsConfig } from '../types/config.js';
import { asDimensionId, asProviderName } from '../types/branded.js';
import {
  buildSampleCsv, SAMPLE_BILLED_TOTAL, SAMPLE_MONTH, SAMPLE_ROW_COUNT, SAMPLE_TAGGED_ROW_COUNT,
} from '../__fixtures__/focus-1-2/samples.js';
import {
  contractGap, mandatoryGap, NATIVE_COLUMNS, QUERY_CONTRACT_COLUMNS, SAMPLE_PROVIDERS,
  unknownColumns,
} from '../__fixtures__/focus-1-2/shapes.js';
import type { SampleProvider } from '../__fixtures__/focus-1-2/shapes.js';
import { readSampleCsv, writeSampleParquet } from '../__fixtures__/focus-1-2/load.js';
import type { WrittenSample } from '../__fixtures__/focus-1-2/load.js';

type Conn = Awaited<ReturnType<Awaited<ReturnType<typeof DuckDBInstance.create>>['connect']>>;

let conn: Conn;
let dataDir: string;
/** Written by beforeAll: the on-disk facts each test needs. `load.ts` owns
 *  the layout, so nothing here rebuilds a path or a provider name. */
const written = new Map<string, WrittenSample>();

function sample(provider: SampleProvider, shape: 'native' | 'contract'): WrittenSample {
  const found = written.get(`${provider}:${shape}`);
  if (found === undefined) throw new Error(`sample not written: ${provider}/${shape}`);
  return found;
}

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

function sourceFor(
  provider: SampleProvider,
  dimensions: DimensionsConfig,
  shape: 'native' | 'contract' = 'contract',
): string {
  return buildSource({
    dataDir, tier: 'daily', dimensions,
    providers: [{ name: asProviderName(sample(provider, shape).providerName), periods: [SAMPLE_MONTH] }],
    costMetric: 'billed',
  });
}

beforeAll(async () => {
  const db = await DuckDBInstance.create();
  conn = await db.connect();
  dataDir = await mkdtemp(join(tmpdir(), 'cg-focus12-'));
  for (const provider of SAMPLE_PROVIDERS) {
    for (const shape of ['native', 'contract'] as const) {
      written.set(`${provider}:${shape}`, await writeSampleParquet(conn, provider, dataDir, shape));
    }
  }
}, 60_000);

describe('FOCUS 1.2 samples — shape', () => {
  it.each(SAMPLE_PROVIDERS)('%s: the committed CSV is what the generator produces', async provider => {
    // Guards the case where someone edits the generator and forgets to
    // regenerate — the committed file is the fixture, the generator is only
    // how it got there.
    expect(await readSampleCsv(provider)).toBe(buildSampleCsv(provider));
  });

  it.each(SAMPLE_PROVIDERS)('%s: every declared column is a real FOCUS 1.2 name or an x_ extension', provider => {
    // The header test below is generated from NATIVE_COLUMNS, so it cannot
    // catch a typo there. This one can: a misspelled standard column is
    // neither in the specification's lists nor `x_`-prefixed.
    expect(unknownColumns(provider)).toEqual([]);
  });

  it.each(SAMPLE_PROVIDERS)('%s: header and row count match the declared native shape', async provider => {
    const lines = (await readSampleCsv(provider)).trimEnd().split('\n');
    expect(lines[0]?.split(',')).toEqual([...NATIVE_COLUMNS[provider]]);
    expect(lines.length - 1).toBe(SAMPLE_ROW_COUNT);
  });

  it('bills the same amounts on all three providers, each in its own currency', async () => {
    // One set of billing events rendered three ways, so any difference is a
    // difference in export shape, never in the underlying month. Note this
    // compares NUMERALS: Azure bills the same amounts in EUR (its
    // BillingCurrency), so the fixture models multi-currency without modelling
    // conversion — do not read these equalities as FX-normalized totals.
    for (const provider of SAMPLE_PROVIDERS) {
      const [row] = await rowsOf(`SELECT SUM(BilledCost) AS total FROM read_parquet('${sample(provider, 'native').parquetPath}')`);
      expect(num(row?.['total']), provider).toBeCloseTo(SAMPLE_BILLED_TOTAL, 2);
    }
    const currencies = await Promise.all(SAMPLE_PROVIDERS.map(async provider => {
      const [row] = await rowsOf(`SELECT DISTINCT BillingCurrency AS c FROM read_parquet('${sample(provider, 'native').parquetPath}')`);
      return row?.['c'];
    }));
    expect(currencies).toEqual(['USD', 'EUR', 'USD']);
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
    const [row] = await rowsOf(`SELECT typeof(Tags) AS t FROM read_parquet('${sample('aws', 'native').parquetPath}') LIMIT 1`);
    expect(row?.['t']).toBe('MAP(VARCHAR, VARCHAR)');
  });

  it('queries straight off the native export, with no projection in between', async () => {
    // Deliberately the NATIVE file, not the canonicalized one: this is the
    // suite's proof that AWS needs no adaptation. Reading the contract shape
    // here would make the claim untestable — a future AWS revision could
    // break native ingest with the assertion still green.
    const source = sourceFor('aws', WITH_TAGS, 'native');
    const [row] = await rowsOf(`SELECT COUNT(*) AS n, ROUND(SUM(cost), 2) AS total, COUNT(tag_team) AS tagged FROM ${source}`);
    expect(Number(row?.['n'])).toBe(SAMPLE_ROW_COUNT);
    expect(num(row?.['total'])).toBeCloseTo(SAMPLE_BILLED_TOTAL, 2);
    expect(Number(row?.['tagged'])).toBe(SAMPLE_TAGGED_ROW_COUNT);
  });

  it('carries a marketplace row with no service code, attributed by publisher', async () => {
    // Absent values load as NULL, the way a real export delivers them — hence
    // the COALESCE, which is also what buildSource does on every column.
    const rows = await rowsOf(`
      SELECT DISTINCT PublisherName FROM read_parquet('${sample('aws', 'native').parquetPath}')
      WHERE COALESCE(x_ServiceCode, '') = '' AND COALESCE(ServiceName, '') = ''`);
    expect(rows).toEqual([{ PublisherName: 'Anthropic' }]);
  });

  it('keeps commitment coverage on the standard FOCUS columns', async () => {
    const rows = await rowsOf(`
      SELECT CommitmentDiscountStatus AS status, COUNT(*) AS n
      FROM read_parquet('${sample('aws', 'native').parquetPath}')
      WHERE CommitmentDiscountStatus <> '' GROUP BY 1 ORDER BY 1`);
    expect(rows.map(r => r['status'])).toEqual(['Unused', 'Used']);
  });

  it('does not double-count commitment spend on the contracted metric', async () => {
    // Under FOCUS a commitment's ContractedCost is booked twice: once on the
    // Purchase row (the commitment fee) and again on the covered usage rows.
    // Summing every charge category double-counts it, so the contracted metric
    // must restrict to usage rows — the same slice list uses.
    const nativeFile = sample('aws', 'native').parquetPath;
    const [naive] = await rowsOf(
      `SELECT ROUND(SUM(COALESCE(ContractedCost, 0)), 2) AS total FROM read_parquet('${nativeFile}')`,
    );
    const [usageOnly] = await rowsOf(
      `SELECT ROUND(SUM(COALESCE(ContractedCost, 0)), 2) AS total FROM read_parquet('${nativeFile}')
       WHERE COALESCE(ChargeCategory, '') = 'Usage'`,
    );
    // The all-rows sum (the old, buggy metric) is strictly larger than the
    // usage-only sum — the difference is the double-counted Purchase row(s).
    expect(num(naive?.['total'])).toBeGreaterThan(num(usageOnly?.['total']));

    // The contracted metric now equals the usage-only sum, not the naive one.
    const contractedSource = buildSource({
      dataDir, tier: 'daily', dimensions: WITH_TAGS,
      providers: [{ name: asProviderName(sample('aws', 'native').providerName), periods: [SAMPLE_MONTH] }],
      costMetric: 'contracted',
    });
    const [row] = await rowsOf(`SELECT ROUND(SUM(cost), 2) AS total FROM ${contractedSource}`);
    expect(num(row?.['total'])).toBeCloseTo(num(usageOnly?.['total']), 2);
  });

  it('labels a NULL SubAccountId as a groupable, drillable sentinel account', async () => {
    // FOCUS allows a null SubAccountId and GCP emits it for project-less
    // charges (account-level taxes/fees). Projected raw it rendered as a blank
    // entity the drill-down filter could never match. Materialize an AWS export
    // with every SubAccountId nulled and prove the sentinel carries the cost.
    const noAcctDir = join(dataDir, 'aws-noacct', 'raw', `daily-${SAMPLE_MONTH}`);
    await mkdir(noAcctDir, { recursive: true });
    const noAcctPath = join(noAcctDir, 'data.parquet');
    await conn.run(
      `COPY (SELECT * REPLACE (CAST(NULL AS VARCHAR) AS SubAccountId)
             FROM read_parquet('${sample('aws', 'native').parquetPath}'))
       TO '${noAcctPath}' (FORMAT PARQUET)`,
    );

    const source = buildSource({
      dataDir, tier: 'daily', dimensions: NO_TAGS,
      providers: [{ name: asProviderName('aws-noacct'), periods: [SAMPLE_MONTH] }],
      costMetric: 'billed',
    });

    // Every row groups under one non-null sentinel bucket (never blank/NULL).
    const grouped = await rowsOf(`SELECT account_id, ROUND(SUM(cost), 2) AS total FROM ${source} GROUP BY account_id`);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.['account_id']).toBe(NO_ACCOUNT_SENTINEL);
    expect(num(grouped[0]?.['total'])).toBeCloseTo(SAMPLE_BILLED_TOTAL, 2);

    // Drill-down filters on the sentinel value and matches the full total —
    // the bug was that `account_id = ''`/`IS NULL` matched nothing, so the
    // detail view came back at $0 while the overview row showed the cost.
    const [detail] = await rowsOf(`SELECT ROUND(SUM(cost), 2) AS total FROM ${source} WHERE account_id = '${NO_ACCOUNT_SENTINEL}'`);
    expect(num(detail?.['total'])).toBeCloseTo(SAMPLE_BILLED_TOTAL, 2);
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
    const [row] = await rowsOf(`SELECT typeof(Tags) AS t FROM read_parquet('${sample('azure', 'native').parquetPath}') LIMIT 1`);
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
    // The exact total, not merely a positive one: a projection that mapped
    // the wrong cost column would still be positive on every row.
    expect(num(row?.['total'])).toBeCloseTo(SAMPLE_BILLED_TOTAL, 2);
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

// NOTE: GCP ships as a provider in v0.7.0. These tests exercise the fixtures'
// REFERENCE projection (contractProjection in load.ts), which is deliberately
// richer than the shipped adapter on one point: it INFERS commitment Used/Unused
// from the credit sign, whereas gcp-canonicalize.ts NULL-fills
// CommitmentDiscountStatus (see 'leaves service_category empty' and the shipped
// path's own tests in gcp-aws-union.integration.test.ts). So the commitment
// assertions below describe what a GCP export *can* yield, not what CostGoblin
// currently surfaces for GCP rows.
describe('GCP FOCUS 1.2 BigQuery export (canonicalized locally by the shipped adapter)', () => {
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
    const native = sample('gcp', 'native').parquetPath;
    const cols = await rowsOf(`SELECT name FROM parquet_schema('${native}')`);
    const names = cols.map(c => String(c['name']));
    expect(names).not.toContain('Tags');
    const [row] = await rowsOf(`SELECT typeof(x_Labels) AS t FROM read_parquet('${native}') LIMIT 1`);
    expect(row?.['t']).toBe('STRUCT("Key" VARCHAR, "Value" VARCHAR)[]');
  });

  it('reports commitment coverage through x_Credits, not CommitmentDiscount*', async () => {
    const native = sample('gcp', 'native').parquetPath;
    const [row] = await rowsOf(`
      SELECT COUNT(*) AS n FROM read_parquet('${native}')
      WHERE len(list_filter(x_Credits, c -> c."Type" = 'COMMITTED_USAGE_DISCOUNT')) > 0`);
    expect(Number(row?.['n'])).toBeGreaterThan(0);
  });

  it('queries once projected onto the contract', async () => {
    const source = sourceFor('gcp', NO_TAGS);
    const [row] = await rowsOf(`SELECT COUNT(*) AS n, ROUND(SUM(cost), 2) AS total FROM ${source}`);
    expect(Number(row?.['n'])).toBe(SAMPLE_ROW_COUNT);
    expect(num(row?.['total'])).toBeCloseTo(SAMPLE_BILLED_TOTAL, 2);
  });

  it('merges label sources with tag bindings winning on a shared key', async () => {
    // Three sources, overlapping on `environment`: the project label sets a
    // project-wide default of `production`, the tag binding carries what the
    // workload actually is. GCP_TAG_SOURCES concatenates strongest-first and
    // the projection takes the FIRST match per key, so the binding wins.
    const source = sourceFor('gcp', {
      builtIn: NO_TAGS.builtIn,
      tags: [{ tagName: 'environment', label: 'Environment' }, { tagName: 'team', label: 'Team' }],
    });
    const envs = await rowsOf(`SELECT DISTINCT tag_environment AS env FROM ${source} ORDER BY 1`);
    expect(envs.map(r => r['env'])).toEqual(['production', 'sandbox', 'staging']);

    // The precedence itself: rows whose binding disagrees with the project
    // default resolve to the binding, not to `production`.
    const [overridden] = await rowsOf(`SELECT COUNT(*) AS n FROM ${source} WHERE tag_environment IN ('staging', 'sandbox')`);
    expect(Number(overridden?.['n'])).toBeGreaterThan(0);

    // A key only the resource labels carry still comes through.
    const [teams] = await rowsOf(`SELECT COUNT(DISTINCT tag_team) AS n FROM ${source}`);
    expect(Number(teams?.['n'])).toBeGreaterThan(1);
  });

  it('propagates project labels to rows the workload never labelled', async () => {
    // A genuine provider difference, not generator noise: a GCP project label
    // attaches to every row of the project, so GCP's untagged rows still carry
    // an environment while AWS's and Azure's carry nothing at all. Resource
    // labels (`team`) stay absent, which is what keeps the untagged population
    // meaningful.
    const source = sourceFor('gcp', {
      builtIn: NO_TAGS.builtIn,
      tags: [{ tagName: 'environment', label: 'Environment' }, { tagName: 'team', label: 'Team' }],
    });
    const [row] = await rowsOf(`
      SELECT COUNT(tag_team) AS tagged, COUNT(tag_environment) AS with_env FROM ${source}`);
    expect(Number(row?.['tagged'])).toBe(SAMPLE_TAGGED_ROW_COUNT);
    expect(Number(row?.['with_env'])).toBe(SAMPLE_ROW_COUNT);
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

  it('keeps the untagged population on every provider', async () => {
    // The samples deliberately leave ~8% of rows untagged, because that is the
    // population every tag-coverage report has to account for. A generator
    // that stamped a constant tag on every row of one provider would show
    // 100% coverage there and quietly stop exercising the feature.
    // Each provider is asked for the key in ITS own casing — Azure preserves
    // what the user typed, so `Team` is the same dimension `team` is elsewhere.
    const teamKey: Record<SampleProvider, string> = { aws: 'team', azure: 'Team', gcp: 'team' };
    for (const provider of SAMPLE_PROVIDERS) {
      const key = teamKey[provider];
      const source = sourceFor(provider, {
        builtIn: NO_TAGS.builtIn,
        tags: [{ tagName: key, label: 'Team' }],
      });
      const [row] = await rowsOf(`SELECT COUNT(tag_${key}) AS tagged FROM ${source}`);
      expect(Number(row?.['tagged']), provider).toBe(SAMPLE_TAGGED_ROW_COUNT);
    }
  });

  it('keeps every contract column physically present in each canonical file', async () => {
    for (const provider of SAMPLE_PROVIDERS) {
      const path = sample(provider, 'contract').parquetPath;
      const cols = await rowsOf(`SELECT name FROM parquet_schema('${path}')`);
      const names = new Set(cols.map(c => String(c['name'])));
      for (const col of QUERY_CONTRACT_COLUMNS) {
        expect(names.has(col), `${provider} is missing ${col}`).toBe(true);
      }
    }
  });
});
