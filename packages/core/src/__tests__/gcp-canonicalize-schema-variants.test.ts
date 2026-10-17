import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { logger } from '../logger/logger.js';
import { canonicalizeGcpPeriod, GcpCanonicalizeError } from '../sync/gcp-canonicalize.js';
import type { CanonicalizeChunk, CanonicalizeConnection, CanonicalizeResultSet } from '../sync/gcp-canonicalize.js';
import { REQUIRED_FOCUS_COLUMNS } from '../sync/focus-contract.js';

/** Export shapes the BigQuery-shaped fixture of the main canonicalize suite
 *  never takes: a minimal export (naive timestamps, no tags, no SubAccountName,
 *  no x_ServiceId), one that already carries `SkuMeter`, one with a column
 *  whose name is not a plain identifier — plus, through a scripted connection,
 *  the driver answers a live DuckDB never gives (NULL schema cells, a count
 *  that is not a bigint, a failing DESCRIBE, an output that lost columns). */

type Conn = Awaited<ReturnType<DuckDBInstance['connect']>>;

let instance: DuckDBInstance | null = null;
let conn: Conn;
let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'gcp-canon-variants-'));
  instance = await DuckDBInstance.create();
  conn = await instance.connect();
  // East of UTC, so a timestamp the module wrongly shifted would move.
  await conn.run(`SET TimeZone='Europe/Berlin'`);
});

afterAll(async () => {
  conn.disconnectSync();
  instance?.closeSync();
  instance = null;
  await rm(root, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function rowsOf(sql: string): Promise<Record<string, unknown>[]> {
  const result = await conn.run(sql);
  return result.getRowObjects();
}

/** Write one shard holding exactly `select`'s columns into a fresh staging dir. */
async function stage(name: string, select: string): Promise<{ stagingDir: string; outputPath: string }> {
  const stagingDir = join(root, 'staging', name);
  await mkdir(stagingDir, { recursive: true });
  await conn.run(`COPY (${select}) TO '${join(stagingDir, 'shard-000000000000.parquet')}' (FORMAT PARQUET)`);
  return { stagingDir, outputPath: join(root, 'out', name, 'part-0.parquet') };
}

/** The six columns no export can do without, as BigQuery types them, but with
 *  a NAIVE timestamp rather than the tz-aware one the real export writes. */
const MINIMAL = `
  TIMESTAMP '2026-01-31 23:30:00' AS ChargePeriodStart,
  'proj-a' AS SubAccountId,
  CAST(2.5 AS DECIMAL(38,9)) AS BilledCost,
  CAST(2.0 AS DECIMAL(38,9)) AS EffectiveCost,
  'Cloud Storage' AS ServiceName,
  'Usage' AS ChargeCategory`;

describe('canonicalizeGcpPeriod on exports narrower than the real one', () => {
  it('fills a minimal export: naive time kept as is, empty tags, names and codes derived from what is there', async () => {
    const { stagingDir, outputPath } = await stage('minimal', `SELECT ${MINIMAL}`);

    const result = await canonicalizeGcpPeriod({ stagingDir, outputPath, connection: conn });

    expect(result.rows).toBe(1);
    // Every column the contract needs that this export lacks, in projection order.
    expect(result.synthesizedColumns).toEqual([
      'SubAccountName', 'ServiceCategory', 'RegionId', 'ResourceId', 'PricingCategory',
      'CommitmentDiscountStatus', 'ChargeDescription',
      'ListCost', 'ContractedCost', 'ConsumedQuantity',
      'x_ServiceCode', 'x_Operation', 'SkuMeter', 'Tags',
    ]);

    const [row] = await rowsOf(`SELECT
        strftime(ChargePeriodStart, '%Y-%m-%d %H:%M') AS ts,
        typeof(ChargePeriodStart) AS ts_type,
        SubAccountName, x_ServiceCode, SkuMeter,
        typeof(Tags) AS tags_type, cardinality(Tags) AS tag_count,
        BilledCost, typeof(BilledCost) AS cost_type
      FROM read_parquet('${outputPath}')`);
    // Already naive UTC: shifting it "to UTC" by the session offset would
    // read 22:30 here and could carry the row across a month boundary.
    expect(row?.['ts']).toBe('2026-01-31 23:30');
    expect(row?.['ts_type']).toBe('TIMESTAMP');
    // The id reads better in a group-by than a NULL name.
    expect(row?.['SubAccountName']).toBe('proj-a');
    // No x_ServiceId: the display name is the service code's last resort.
    expect(row?.['x_ServiceCode']).toBe('Cloud Storage');
    expect(row?.['SkuMeter']).toBeNull();
    // An export with no tag column at all still yields a real (empty) MAP.
    expect(row?.['tags_type']).toBe('MAP(VARCHAR, VARCHAR)');
    expect(Number(row?.['tag_count'])).toBe(0);
    expect(row?.['BilledCost']).toBe(2.5);
    expect(row?.['cost_type']).toBe('DOUBLE');
  });

  it('keeps an exported SkuMeter, falling back to the SKU id only where the meter is empty', async () => {
    const { stagingDir, outputPath } = await stage('sku-meter', `
      SELECT ${MINIMAL}, CAST(NULL AS VARCHAR) AS SkuMeter, 'sku-1' AS SkuId
      UNION ALL
      SELECT ${MINIMAL}, 'Storage Meter' AS SkuMeter, 'sku-2' AS SkuId`);

    const result = await canonicalizeGcpPeriod({ stagingDir, outputPath, connection: conn });

    expect(result.synthesizedColumns).not.toContain('SkuMeter');
    const rows = await rowsOf(`SELECT SkuMeter FROM read_parquet('${outputPath}') ORDER BY SkuMeter`);
    expect(rows.map(r => r['SkuMeter'])).toEqual(['Storage Meter', 'sku-1']);
    // SkuId was folded into SkuMeter, so it is not carried twice.
    const names = (await rowsOf(`DESCRIBE SELECT * FROM read_parquet('${outputPath}')`)).map(r => r['column_name']);
    expect(names).not.toContain('SkuId');
  });

  it('passes an exported SkuMeter through untouched when there is no SKU id to fall back to', async () => {
    const { stagingDir, outputPath } = await stage('sku-meter-only', `
      SELECT ${MINIMAL}, CAST(NULL AS VARCHAR) AS SkuMeter
      UNION ALL
      SELECT ${MINIMAL}, 'Storage Meter' AS SkuMeter`);

    const result = await canonicalizeGcpPeriod({ stagingDir, outputPath, connection: conn });

    expect(result.synthesizedColumns).not.toContain('SkuMeter');
    const rows = await rowsOf(`SELECT SkuMeter FROM read_parquet('${outputPath}') ORDER BY SkuMeter NULLS LAST`);
    expect(rows.map(r => r['SkuMeter'])).toEqual(['Storage Meter', null]);
  });

  it('drops a passthrough column whose name is not a plain identifier, with a warning, and keeps the rest', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const { stagingDir, outputPath } = await stage('unsafe-name', `
      SELECT ${MINIMAL}, 'kept' AS x_PreviewField, 'dropped' AS "x-Preview Field"`);

    await canonicalizeGcpPeriod({ stagingDir, outputPath, connection: conn });

    const names = (await rowsOf(`DESCRIBE SELECT * FROM read_parquet('${outputPath}')`)).map(r => r['column_name']);
    expect(names).toContain('x_PreviewField');
    expect(names).not.toContain('x-Preview Field');
    expect(warn).toHaveBeenCalledWith('Dropping GCP export column with an unsafe name: x-Preview Field');
  });

  it('releases its own engine and creates nothing when the engine settings are refused', async () => {
    // No caller connection: the module opens (and must close) its own
    // instance, and a bad setting fails before any file is touched.
    const outputPath = join(root, 'out', 'bad-threads', 'part-0.parquet');
    await expect(canonicalizeGcpPeriod({
      stagingDir: join(root, 'staging', 'never-read'),
      outputPath,
      threads: 0,
    })).rejects.toThrow('Must have at least 1 thread');
    await expect(stat(dirname(outputPath))).rejects.toThrow(/ENOENT/);
  });
});

// ---------------------------------------------------------------------------
// Scripted driver answers
// ---------------------------------------------------------------------------

type Rows = readonly (readonly unknown[])[];

function chunkOf(rows: Rows): CanonicalizeChunk {
  return {
    rowCount: rows.length,
    getColumnVector: (index: number) => ({ getItem: (row: number): unknown => rows[row]?.[index] }),
  };
}

function resultOf(...chunks: readonly (CanonicalizeChunk | null)[]): CanonicalizeResultSet {
  const pending = [...chunks];
  return { columnCount: 2, fetchChunk: () => Promise.resolve(pending.shift() ?? null) };
}

/** DESCRIBE rows for the six required source columns, as DuckDB names them. */
const SOURCE_SCHEMA: Rows = [
  ['ChargePeriodStart', 'TIMESTAMP WITH TIME ZONE'],
  ['SubAccountId', 'VARCHAR'],
  ['BilledCost', 'DECIMAL(38,9)'],
  ['EffectiveCost', 'DECIMAL(38,9)'],
  ['ServiceName', 'VARCHAR'],
  ['ChargeCategory', 'VARCHAR'],
];
const OUTPUT_SCHEMA: Rows = REQUIRED_FOCUS_COLUMNS.map(name => [name, 'VARCHAR']);

interface Script {
  readonly source?: () => Promise<CanonicalizeResultSet>;
  readonly count?: () => Promise<CanonicalizeResultSet>;
  readonly output?: Rows;
}

/** A connection that answers the module's four statements from a script and
 *  records them, so a case can read back the COPY it was asked to run. */
class ScriptedConnection implements CanonicalizeConnection {
  readonly statements: string[] = [];
  private readonly script: Script;

  constructor(script: Script) {
    this.script = script;
  }

  run(sql: string): Promise<CanonicalizeResultSet> {
    this.statements.push(sql);
    if (sql.startsWith('DESCRIBE') && sql.includes('union_by_name=true')) {
      return this.script.source?.() ?? Promise.resolve(resultOf(chunkOf(SOURCE_SCHEMA), null));
    }
    if (sql.startsWith('DESCRIBE')) return Promise.resolve(resultOf(chunkOf(this.script.output ?? OUTPUT_SCHEMA), null));
    if (sql.startsWith('SELECT COUNT(*)')) {
      return this.script.count?.() ?? Promise.resolve(resultOf(chunkOf([[3n]])));
    }
    return Promise.resolve(resultOf(null));
  }

  copyStatement(): string {
    const copy = this.statements.find(s => s.includes('COPY ('));
    if (copy === undefined) throw new Error('no COPY was issued');
    return copy;
  }
}

function isErrorShaped(value: unknown): value is Error {
  return typeof value === 'object' && value !== null && 'message' in value && typeof value.message === 'string';
}

async function stagedShardDir(name: string): Promise<{ stagingDir: string; outputPath: string }> {
  const stagingDir = join(root, 'scripted', name);
  await mkdir(stagingDir, { recursive: true });
  // Never read: the scripted connection answers in its place.
  await writeFile(join(stagingDir, 'shard-0.parquet'), '');
  return { stagingDir, outputPath: join(root, 'scripted-out', name, 'part-0.parquet') };
}

describe('canonicalizeGcpPeriod against unusual driver answers', () => {
  it.each([
    ['no chunk at all', (): Promise<CanonicalizeResultSet> => Promise.resolve(resultOf(null)), 0],
    ['an empty chunk', (): Promise<CanonicalizeResultSet> => Promise.resolve(resultOf(chunkOf([]))), 0],
    ['a plain number', (): Promise<CanonicalizeResultSet> => Promise.resolve(resultOf(chunkOf([[5]]))), 5],
    ['a bigint', (): Promise<CanonicalizeResultSet> => Promise.resolve(resultOf(chunkOf([[6n]]))), 6],
    ['a value that is no number', (): Promise<CanonicalizeResultSet> => Promise.resolve(resultOf(chunkOf([['7']]))), 0],
  ])('reads the row count from %s', async (label, count, expected) => {
    const { stagingDir, outputPath } = await stagedShardDir(`count-${label.replaceAll(' ', '-')}`);
    const connection = new ScriptedConnection({ count });

    const result = await canonicalizeGcpPeriod({ stagingDir, outputPath, connection });

    expect(result.rows).toBe(expected);
  });

  it('ignores schema rows whose name is not text, and treats an untyped column as a naive timestamp', async () => {
    const { stagingDir, outputPath } = await stagedShardDir('null-schema-cells');
    const connection = new ScriptedConnection({
      source: () => Promise.resolve(resultOf(chunkOf([
        ['ChargePeriodStart', null],
        ...SOURCE_SCHEMA.slice(1),
        // `String(null)` would be the perfectly safe identifier "null".
        [null, 'VARCHAR'],
      ]), null)),
    });

    await canonicalizeGcpPeriod({ stagingDir, outputPath, connection });

    const copy = connection.copyStatement();
    expect(copy).toContain('CAST("ChargePeriodStart" AS TIMESTAMP) AS "ChargePeriodStart"');
    expect(copy).not.toContain('AT TIME ZONE');
    expect(copy).not.toContain('"null"');
  });

  it('wraps a DESCRIBE failure in the typed error, even one raised in another realm', async () => {
    const { stagingDir, outputPath } = await stagedShardDir('describe-fails');
    // An Error built in another V8 context (a worker, a vm sandbox) is no
    // `instanceof Error` here, so only its string form carries the text.
    const foreign: unknown = runInNewContext('new Error("IO Error: No files found that match the pattern")');
    if (!isErrorShaped(foreign)) throw new Error('the vm context did not produce an error object');
    expect(foreign instanceof Error).toBe(false);

    const local = new ScriptedConnection({ source: () => Promise.reject(new Error('IO Error: Invalid Parquet file')) });
    const remote = new ScriptedConnection({ source: () => Promise.reject(foreign) });

    const localFailure = await canonicalizeGcpPeriod({ stagingDir, outputPath, connection: local })
      .then(() => null, (err: unknown) => err);
    const remoteFailure = await canonicalizeGcpPeriod({ stagingDir, outputPath, connection: remote })
      .then(() => null, (err: unknown) => err);

    expect(localFailure).toBeInstanceOf(GcpCanonicalizeError);
    expect(localFailure).toMatchObject({
      message: 'Could not read the downloaded export for this period: IO Error: Invalid Parquet file',
      missingColumns: [],
    });
    expect(remoteFailure).toBeInstanceOf(GcpCanonicalizeError);
    expect(remoteFailure).toMatchObject({
      message: 'Could not read the downloaded export for this period: Error: IO Error: No files found that match the pattern',
      missingColumns: [],
    });
    // Nothing is written for a period whose shards could not be read.
    expect(remote.statements.some(s => s.includes('COPY ('))).toBe(false);
    await expect(stat(dirname(outputPath))).rejects.toThrow(/ENOENT/);
  });

  it('fails the period when the written file came back without contract columns', async () => {
    const { stagingDir, outputPath } = await stagedShardDir('output-lost-columns');
    const lost = new Set(['Tags', 'x_Operation']);
    const connection = new ScriptedConnection({ output: OUTPUT_SCHEMA.filter(([name]) => typeof name === 'string' && !lost.has(name)) });

    const failure = await canonicalizeGcpPeriod({ stagingDir, outputPath, connection }).then(() => null, (err: unknown) => err);

    expect(failure).toBeInstanceOf(GcpCanonicalizeError);
    expect(failure).toMatchObject({
      message: 'Canonicalized output is missing required column(s) Tags, x_Operation',
      missingColumns: ['Tags', 'x_Operation'],
    });
  });
});
