import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalizeGcpPeriod, GcpCanonicalizeError } from '../sync/gcp-canonicalize.js';
import { REQUIRED_FOCUS_COLUMNS } from '../sync/focus-contract.js';

/** Layer 2: real DuckDB against Parquet shaped the way BigQuery's FOCUS
 *  export actually writes it — TIMESTAMP WITH TIME ZONE, NUMERIC costs,
 *  list-of-struct tags, `x_ServiceId`/`SkuId` instead of the AWS extension
 *  columns. Everything asserted here is a property the query layer depends on
 *  and cannot get from the raw export. */

type Conn = Awaited<ReturnType<Awaited<ReturnType<typeof DuckDBInstance.create>>['connect']>>;

let conn: Conn;
let root: string;

async function rowsOf(sql: string): Promise<Record<string, unknown>[]> {
  const result = await conn.run(sql);
  return result.getRowObjects();
}

/** The columns and types the BigQuery export delivers. Deliberately NOT the
 *  contract shape: no `x_ServiceCode`, no `x_Operation`, no `SkuMeter`, tags
 *  as a repeated struct, costs as DECIMAL, timestamps tz-aware. */
const BQ_COLUMNS = `
  ChargePeriodStart, SubAccountId, SubAccountName,
  BilledCost, EffectiveCost, ListCost, ContractedCost,
  ServiceName, ServiceCategory, RegionId, ResourceId, ChargeCategory, PricingCategory,
  ChargeDescription, ConsumedQuantity,
  Tags, x_Labels, x_ServiceId, SkuId, x_ExportTime`;

function bqRow(opts: {
  readonly ts: string;
  readonly project: string;
  readonly cost: number;
  readonly tags: string;
  readonly labels: string;
}): string {
  return `(
    TIMESTAMPTZ '${opts.ts}',
    '${opts.project}', 'Project ${opts.project}',
    CAST(${String(opts.cost)} AS DECIMAL(38,9)), CAST(${String(opts.cost)} AS DECIMAL(38,9)),
    CAST(${String(opts.cost * 2)} AS DECIMAL(38,9)), CAST(${String(opts.cost)} AS DECIMAL(38,9)),
    'Compute Engine', 'Compute', 'europe-west1', '//compute/instances/x', 'Usage', 'Standard',
    'N1 Predefined Instance Core', CAST(24 AS DECIMAL(38,9)),
    ${opts.tags}, ${opts.labels},
    'compute.googleapis.com', 'N1-Standard-Core', TIMESTAMPTZ '2026-02-02 04:00:00+00'
  )`;
}

const NO_TAGS = `CAST(NULL AS STRUCT("Key" VARCHAR, "Value" VARCHAR, x_Inherited BOOLEAN)[])`;

/** Write one BigQuery-shaped period into its own staging dir. `extraSql`
 *  lets a case drop a column to exercise the missing-column path. */
async function stageBqPeriod(name: string, values: readonly string[], extraSql = ''): Promise<string> {
  const dir = join(root, 'staging', name);
  await mkdir(dir, { recursive: true });
  const table = `bq_${name.replaceAll('-', '_')}`;
  await conn.run(`CREATE TABLE ${table} AS SELECT * FROM (VALUES ${values.join(',')}) AS t(${BQ_COLUMNS})`);
  if (extraSql.length > 0) await conn.run(extraSql.replaceAll('{table}', table));
  await conn.run(`COPY (SELECT * FROM ${table}) TO '${join(dir, 'shard-000000000000.parquet')}' (FORMAT PARQUET)`);
  // Real exports always write at least one file, so a zero-row month lands as
  // a header-only shard rather than an empty directory.
  await conn.run(`COPY (SELECT * FROM ${table} WHERE 1=0) TO '${join(dir, 'shard-000000000001.parquet')}' (FORMAT PARQUET)`);
  return dir;
}

let ownedInstance: DuckDBInstance | null = null;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'gcp-canon-'));
  const instance = await DuckDBInstance.create();
  ownedInstance = instance;
  conn = await instance.connect();
  // The trap this suite exists to pin: `::DATE` on a tz-aware timestamp
  // resolves in the SESSION timezone, so every assertion below runs east of
  // UTC where an un-normalized 23:30 row would land in the next month.
  await conn.run(`SET TimeZone='Europe/Berlin'`);
});

// A DuckDB instance is a native engine with its own buffer pool; without this
// every run of the suite leaks one for the life of the vitest worker.
afterAll(() => {
  conn.disconnectSync();
  ownedInstance?.closeSync();
  ownedInstance = null;
});

describe('canonicalizeGcpPeriod', () => {
  it('produces every contract column, with MAP tags and DOUBLE costs', async () => {
    const staging = await stageBqPeriod('basic', [
      bqRow({
        ts: '2026-01-15 08:00:00+00', project: 'proj-a', cost: 1.5,
        tags: `[{'Key': 'team', 'Value': 'platform', 'x_Inherited': false}]`,
        labels: `[{'Key': 'system', 'Value': 'checkout', 'x_Inherited': true}]`,
      }),
    ]);
    const out = join(root, 'out', 'basic', 'part-0.parquet');

    const result = await canonicalizeGcpPeriod({ stagingDir: staging, outputPath: out, connection: conn });
    expect(result.rows).toBe(1);

    const schema = await rowsOf(`DESCRIBE SELECT * FROM read_parquet('${out}')`);
    const types = new Map(schema.map(r => [String(r['column_name']), String(r['column_type'])]));
    for (const column of REQUIRED_FOCUS_COLUMNS) {
      expect(types.has(column), `missing contract column ${column}`).toBe(true);
    }
    expect(types.get('Tags')).toBe('MAP(VARCHAR, VARCHAR)');
    expect(types.get('ChargePeriodStart')).toBe('TIMESTAMP');
    for (const cost of ['BilledCost', 'EffectiveCost', 'ListCost', 'ContractedCost', 'ConsumedQuantity']) {
      expect(types.get(cost), cost).toBe('DOUBLE');
    }

    // The extraction the whole tag-dimension layer is built on. It only works
    // against a real MAP, which is the reason this step exists.
    const [row] = await rowsOf(`SELECT
      element_at(Tags, 'team')[1] AS team,
      element_at(Tags, 'system')[1] AS system,
      x_ServiceCode, x_Operation, SkuMeter
      FROM read_parquet('${out}')`);
    expect(row?.['team']).toBe('platform');
    expect(row?.['system']).toBe('checkout');
    // Synthesized from x_ServiceId; the AWS-only operation column is present
    // but empty; SkuMeter falls back to the GCP SKU id.
    expect(row?.['x_ServiceCode']).toBe('compute.googleapis.com');
    expect(row?.['x_Operation']).toBeNull();
    expect(row?.['SkuMeter']).toBe('N1-Standard-Core');
    expect(result.synthesizedColumns).toContain('x_Operation');
    expect(result.synthesizedColumns).toContain('x_ServiceCode');
  });

  it('keeps a late-in-month UTC row in its own month under a non-UTC session timezone', async () => {
    const staging = await stageBqPeriod('tz', [
      bqRow({ ts: '2026-01-31 23:30:00+00', project: 'proj-a', cost: 1, tags: NO_TAGS, labels: NO_TAGS }),
    ]);
    const out = join(root, 'out', 'tz', 'part-0.parquet');
    await canonicalizeGcpPeriod({ stagingDir: staging, outputPath: out, connection: conn });

    // Without the UTC normalization this reads 2026-02-01 — silently moving
    // the row into the next month for `usage_date` and the period layout.
    const [row] = await rowsOf(`SELECT strftime(ChargePeriodStart, '%Y-%m-%d %H:%M') AS ts, ChargePeriodStart::DATE AS d FROM read_parquet('${out}')`);
    expect(row?.['ts']).toBe('2026-01-31 23:30');
    expect(String(row?.['d'])).toContain('2026-01-31');
  });

  it('survives duplicate and NULL tag keys, with resource tags outranking labels', async () => {
    // `map_from_entries` raises Invalid Input Error on either, which would
    // fail the whole period's COPY — and both occur in real exports.
    const staging = await stageBqPeriod('dupes', [
      bqRow({
        ts: '2026-01-10 00:00:00+00', project: 'proj-a', cost: 1,
        tags: `[{'Key': 'team', 'Value': 'platform', 'x_Inherited': false},
                {'Key': 'team', 'Value': 'second-wins-nothing', 'x_Inherited': false},
                {'Key': NULL, 'Value': 'orphan', 'x_Inherited': false}]`,
        labels: `[{'Key': 'team', 'Value': 'label-loses', 'x_Inherited': true},
                  {'Key': 'system', 'Value': 'checkout', 'x_Inherited': true}]`,
      }),
    ]);
    const out = join(root, 'out', 'dupes', 'part-0.parquet');
    await canonicalizeGcpPeriod({ stagingDir: staging, outputPath: out, connection: conn });

    const [row] = await rowsOf(`SELECT
      element_at(Tags,'team')[1] AS team,
      element_at(Tags,'system')[1] AS system,
      cardinality(Tags) AS n
      FROM read_parquet('${out}')`);
    expect(row?.['team']).toBe('platform');
    expect(row?.['system']).toBe('checkout');
    // team + system only: the duplicate collapses and the NULL key is dropped.
    expect(Number(row?.['n'])).toBe(2);
  });

  it('emits an empty MAP, not NULL, for a row with no tags at all', async () => {
    const staging = await stageBqPeriod('untagged', [
      bqRow({ ts: '2026-01-11 00:00:00+00', project: 'proj-b', cost: 2, tags: NO_TAGS, labels: NO_TAGS }),
    ]);
    const out = join(root, 'out', 'untagged', 'part-0.parquet');
    await canonicalizeGcpPeriod({ stagingDir: staging, outputPath: out, connection: conn });

    const [row] = await rowsOf(`SELECT cardinality(Tags) AS n, element_at(Tags,'team')[1] AS team FROM read_parquet('${out}')`);
    expect(Number(row?.['n'])).toBe(0);
    expect(row?.['team']).toBeNull();
  });

  it('tolerates a header-only shard and a period that is entirely header-only', async () => {
    // Every case above already mixes in a zero-row shard; this one has nothing
    // else, which is what a freshly-enabled month looks like.
    const dir = join(root, 'staging', 'empty');
    await mkdir(dir, { recursive: true });
    await conn.run(`CREATE TABLE bq_empty AS SELECT * FROM (VALUES ${bqRow({ ts: '2026-01-01 00:00:00+00', project: 'p', cost: 1, tags: NO_TAGS, labels: NO_TAGS })}) AS t(${BQ_COLUMNS}) WHERE 1=0`);
    await conn.run(`COPY (SELECT * FROM bq_empty) TO '${join(dir, 'shard-000000000000.parquet')}' (FORMAT PARQUET)`);

    const out = join(root, 'out', 'empty', 'part-0.parquet');
    const result = await canonicalizeGcpPeriod({ stagingDir: dir, outputPath: out, connection: conn });
    expect(result.rows).toBe(0);
    // Still contract-valid: a zero-row file with the right columns unions
    // cleanly, a file missing them binder-errors every query over the month.
    const schema = await rowsOf(`DESCRIBE SELECT * FROM read_parquet('${out}')`);
    const names = new Set(schema.map(r => String(r['column_name'])));
    for (const column of REQUIRED_FOCUS_COLUMNS) expect(names.has(column), column).toBe(true);
  });

  it('carries through export columns the contract does not mention', async () => {
    const staging = await stageBqPeriod('passthrough', [
      bqRow({ ts: '2026-01-12 00:00:00+00', project: 'proj-c', cost: 3, tags: NO_TAGS, labels: NO_TAGS }),
    ]);
    const out = join(root, 'out', 'passthrough', 'part-0.parquet');
    await canonicalizeGcpPeriod({ stagingDir: staging, outputPath: out, connection: conn });

    const schema = await rowsOf(`DESCRIBE SELECT * FROM read_parquet('${out}')`);
    const names = new Set(schema.map(r => String(r['column_name'])));
    // The export's own change-detection column: nothing queries it, but the
    // local Parquet is the long-term archive, so it must not be dropped.
    expect(names.has('x_ExportTime')).toBe(true);
    // Source columns folded into a contract column are NOT duplicated.
    expect(names.has('x_ServiceId')).toBe(false);
    expect(names.has('SkuId')).toBe(false);
    expect(names.has('x_Labels')).toBe(false);
  });

  it('drops Google-reserved goog- keys, which the real export mixes into x_Labels', async () => {
    // Excluding x_SystemLabels is not enough. In the first real export observed
    // (2026-08), x_Labels carried `goog-resource-type` on 20 of 60 rows,
    // alongside a genuine user label on 9 — so a workspace would get a
    // Google-generated key sitting above its own in the dimension picker.
    // `goog-` is Google's documented reserved label prefix.
    const dir = join(root, 'staging', 'goog-labels');
    await mkdir(dir, { recursive: true });
    await conn.run(`CREATE TABLE bq_goog AS SELECT * FROM (VALUES (
      TIMESTAMPTZ '2026-08-04 04:00:00+00', 'proj-a', 'Project A',
      CAST(1 AS DECIMAL(38,9)), CAST(1 AS DECIMAL(38,9)),
      'Cloud Storage', 'Usage',
      [{'Key': 'goog-resource-type', 'Value': 'bigquery_resource'}, {'Key': 'purpose', 'Value': 'freetier-billing-probe'}],
      'storage.googleapis.com'
    )) AS t(
      ChargePeriodStart, SubAccountId, SubAccountName,
      BilledCost, EffectiveCost, ServiceName, ChargeCategory,
      x_Labels, x_ServiceId
    )`);
    await conn.run(`COPY (SELECT * FROM bq_goog) TO '${join(dir, 'shard-0.parquet')}' (FORMAT PARQUET)`);

    const out = join(root, 'out', 'goog-labels', 'part-0.parquet');
    await canonicalizeGcpPeriod({ stagingDir: dir, outputPath: out, connection: conn });

    const [row] = await rowsOf(`SELECT
      element_at(Tags,'purpose')[1] AS purpose,
      element_at(Tags,'goog-resource-type')[1] AS goog,
      cardinality(Tags) AS n
      FROM read_parquet('${out}')`);

    expect(row?.['purpose']).toBe('freetier-billing-probe');
    expect(row?.['goog']).toBeNull();
    expect(Number(row?.['n'])).toBe(1);
  });

  it('reads tags from the column the real export actually uses (x_Tags)', async () => {
    // The live GCP FOCUS export has 55 columns and NO `Tags` — resource tags
    // are in `x_Tags`. Reading only the FOCUS-standard name produced an empty
    // tag map for every row, with no error anywhere. This pins the real names
    // and their precedence: resource tags beat labels beat project labels.
    const dir = join(root, 'staging', 'real-names');
    await mkdir(dir, { recursive: true });
    await conn.run(`CREATE TABLE bq_real AS SELECT * FROM (VALUES (
      TIMESTAMPTZ '2026-07-15 08:00:00+00', 'proj-a', 'Project A',
      CAST(1 AS DECIMAL(38,9)), CAST(1 AS DECIMAL(38,9)),
      'Compute Engine', 'Usage',
      [{'Key': 'team', 'Value': 'platform', 'x_Inherited': false, 'x_Namespace': CAST(NULL AS VARCHAR)}],
      [{'Key': 'team', 'Value': 'label-loses'}, {'Key': 'system', 'Value': 'checkout'}],
      [{'Key': 'cost-centre', 'Value': 'eng'}],
      [{'Key': 'machine_spec', 'Value': 'n1-standard-1'}],
      'compute.googleapis.com', 'N1-Std'
    )) AS t(
      ChargePeriodStart, SubAccountId, SubAccountName,
      BilledCost, EffectiveCost, ServiceName, ChargeCategory,
      x_Tags, x_Labels, x_ProjectLabels, x_SystemLabels, x_ServiceId, SkuId
    )`);
    await conn.run(`COPY (SELECT * FROM bq_real) TO '${join(dir, 'shard-0.parquet')}' (FORMAT PARQUET)`);

    const out = join(root, 'out', 'real-names', 'part-0.parquet');
    await canonicalizeGcpPeriod({ stagingDir: dir, outputPath: out, connection: conn });

    const [row] = await rowsOf(`SELECT
      element_at(Tags,'team')[1] AS team,
      element_at(Tags,'system')[1] AS system,
      element_at(Tags,'cost-centre')[1] AS cc,
      element_at(Tags,'machine_spec')[1] AS machine,
      cardinality(Tags) AS n,
      x_ServiceCode, SkuMeter, ServiceCategory, CommitmentDiscountStatus
      FROM read_parquet('${out}')`);

    expect(row?.['team']).toBe('platform');          // x_Tags outranks x_Labels
    expect(row?.['system']).toBe('checkout');        // merged from x_Labels
    expect(row?.['cc']).toBe('eng');                 // merged from x_ProjectLabels
    // System labels are GCP-generated, not cost-allocation tags — including
    // them would bury the user's own keys in the dimension picker.
    expect(row?.['machine']).toBeNull();
    expect(Number(row?.['n'])).toBe(3);

    // Columns the real export simply does not have, materialized as NULL so
    // the glob still binds rather than erroring at query time.
    expect(row?.['x_ServiceCode']).toBe('compute.googleapis.com');
    expect(row?.['SkuMeter']).toBe('N1-Std');
    expect(row?.['ServiceCategory']).toBeNull();
    expect(row?.['CommitmentDiscountStatus']).toBeNull();
  });

  it('handles a data directory containing glob metacharacters', async () => {
    // The staging and output paths are built from the user's data directory,
    // and DuckDB treats `[`, `]`, `?` and `*` in a read_parquet path as glob
    // syntax. A folder like `CostGoblin [beta]` made `[beta]` a character
    // class, so the read matched nothing and every period failed with
    // "Could not read the downloaded export" — after the bytes had already
    // been downloaded.
    const oddDir = join(root, 'CostGoblin [beta] v?1', 'staging');
    await mkdir(oddDir, { recursive: true });
    await conn.run(`CREATE TABLE bq_odd AS SELECT * FROM (VALUES ${bqRow({
      ts: '2026-01-10 00:00:00+00', project: 'proj-odd', cost: 3, tags: NO_TAGS, labels: NO_TAGS,
    })}) AS t(${BQ_COLUMNS})`);
    await conn.run(`COPY (SELECT * FROM bq_odd) TO '${join(oddDir, 'shard-000000000000.parquet')}' (FORMAT PARQUET)`);

    const out = join(root, 'CostGoblin [beta] v?1', 'out', 'part-0.parquet');
    const result = await canonicalizeGcpPeriod({ stagingDir: oddDir, outputPath: out, connection: conn });
    expect(result.rows).toBe(1);
  });

  it('fails with a typed error when a required FOCUS column is absent', async () => {
    const staging = await stageBqPeriod(
      'nocost',
      [bqRow({ ts: '2026-01-13 00:00:00+00', project: 'proj-d', cost: 4, tags: NO_TAGS, labels: NO_TAGS })],
      `ALTER TABLE {table} DROP COLUMN EffectiveCost`,
    );
    const out = join(root, 'out', 'nocost', 'part-0.parquet');

    await expect(canonicalizeGcpPeriod({ stagingDir: staging, outputPath: out, connection: conn }))
      .rejects.toThrow(GcpCanonicalizeError);
    await expect(canonicalizeGcpPeriod({ stagingDir: staging, outputPath: out, connection: conn }))
      .rejects.toThrow(/EffectiveCost/);
  });

  it('fails with a typed error when the staging directory holds no Parquet', async () => {
    const dir = join(root, 'staging', 'nothing');
    await mkdir(dir, { recursive: true });
    await expect(canonicalizeGcpPeriod({
      stagingDir: dir,
      outputPath: join(root, 'out', 'nothing', 'part-0.parquet'),
      connection: conn,
    })).rejects.toThrow(GcpCanonicalizeError);
  });

  it('unions with an AWS-shaped file: one tag expression, one cost sum', async () => {
    const staging = await stageBqPeriod('union', [
      bqRow({
        ts: '2026-01-14 00:00:00+00', project: 'proj-a', cost: 10,
        tags: `[{'Key': 'team', 'Value': 'platform', 'x_Inherited': false}]`,
        labels: NO_TAGS,
      }),
    ]);
    const gcpOut = join(root, 'out', 'union', 'part-0.parquet');
    await canonicalizeGcpPeriod({ stagingDir: staging, outputPath: gcpOut, connection: conn });

    // An AWS export as delivered: MAP tags, DOUBLE costs, naive timestamps.
    const awsOut = join(root, 'out', 'union', 'aws.parquet');
    await conn.run(`COPY (SELECT
        TIMESTAMP '2026-01-14' AS ChargePeriodStart,
        '123456789012' AS SubAccountId,
        CAST(5 AS DOUBLE) AS BilledCost,
        MAP{'team':'platform'} AS Tags
      ) TO '${awsOut}' (FORMAT PARQUET)`);

    const rows = await rowsOf(`SELECT element_at(Tags,'team')[1] AS team, SUM(BilledCost) AS total
      FROM read_parquet(['${gcpOut}', '${awsOut}'], union_by_name=true)
      GROUP BY 1`);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['team']).toBe('platform');
    expect(Number(rows[0]?.['total'])).toBe(15);
  });
});
