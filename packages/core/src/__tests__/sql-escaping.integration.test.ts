import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSource, sqlEscapeString } from '../query/builder.js';
import type { DimensionsConfig } from '../types/config.js';
import { asProviderName } from '../types/branded.js';

/**
 * Behavioral lock on `sqlEscapeString` and the escaping applied to config
 * literals interpolated into buildSource's SQL (tagName, accountTagFallback,
 * missingValueTemplate). These values come from a git-shareable YAML config,
 * so a single quote must never break out of its SQL string position. Locked
 * the Layer-2 way: the generated SQL runs against a real Parquet file in
 * DuckDB — an unescaped quote fails the parse, a mis-escaped key returns the
 * wrong value.
 */

const PROVIDER = asProviderName('aws');
// The tag key and account-tag key both contain a single quote on purpose.
const QUOTED_TAG_KEY = "o'brien team";
const QUOTED_FALLBACK_KEY = "cost'center";

type Conn = Awaited<ReturnType<Awaited<ReturnType<typeof DuckDBInstance.create>>['connect']>>;

interface QueryRow {
  [key: string]: unknown;
}

async function queryAll(conn: Conn, sql: string): Promise<QueryRow[]> {
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

describe('SQL escaping of config literals (DuckDB execution)', () => {
  let db: Awaited<ReturnType<typeof DuckDBInstance.create>>;
  let conn: Conn;
  let dataDir: string;
  let orgAccountsPath: string;

  beforeAll(async () => {
    // Normalize to forward slashes so the dataDir that lands in the
    // read_parquet glob matches the (also-normalized) parquet/org-accounts
    // paths on Windows; a no-op on POSIX.
    dataDir = (await mkdtemp(join(tmpdir(), 'cg-sql-escaping-'))).replaceAll('\\', '/');
    const monthDir = join(dataDir, 'aws', 'raw', 'daily-2026-01');
    await mkdir(monthDir, { recursive: true });

    db = await DuckDBInstance.create();
    conn = await db.connect();

    // Two rows covering every column buildSource reads. acct-1 carries the
    // quoted resource tag; acct-2 lacks it, so its value must come from the
    // org-accounts fallback formatted through missingValueTemplate.
    const parquetPath = join(monthDir, 'data.parquet').replaceAll('\\', '/');
    await conn.run(`
      COPY (
        SELECT * FROM (VALUES
          (TIMESTAMP '2026-01-05 00:00:00', 'acct-1', 'Account One', 'eu-west-1',
           'Amazon Elastic Compute Cloud', 'AmazonEC2', 'Compute', 'instance usage',
           10.0, 12.0, 'arn:aws:ec2:res-1', 10.0, 'Usage', 'Standard', '',
           'RunInstances', 'BoxUsage', MAP {'o''brien team': 'Platform'}),
          (TIMESTAMP '2026-01-06 00:00:00', 'acct-2', 'Account Two', 'eu-west-1',
           'Amazon Simple Storage Service', 'AmazonS3', 'Storage', 'storage usage',
           5.0, 6.0, 'arn:aws:s3:res-2', 5.0, 'Usage', 'Standard', '',
           'PutObject', 'TimedStorage', MAP {'unrelated': 'x'})
        ) AS t(ChargePeriodStart, SubAccountId, SubAccountName, RegionId,
               ServiceName, x_ServiceCode, ServiceCategory, ChargeDescription,
               ConsumedQuantity, ListCost, ResourceId, EffectiveCost,
               ChargeCategory, PricingCategory, CommitmentDiscountStatus,
               x_Operation, SkuMeter, Tags)
      ) TO '${parquetPath}' (FORMAT PARQUET)
    `);

    orgAccountsPath = join(dataDir, 'org-accounts.json').replaceAll('\\', '/');
    await writeFile(orgAccountsPath, JSON.stringify([
      { id: 'acct-1', tags: { [QUOTED_FALLBACK_KEY]: 'cc-one' } },
      { id: 'acct-2', tags: { [QUOTED_FALLBACK_KEY]: 'cc-two' } },
    ]));
  });

  afterAll(async () => {
    conn.disconnectSync();
    db.closeSync();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('locks sqlEscapeString: doubles single quotes, leaves everything else alone', () => {
    expect(sqlEscapeString("O'Brien's")).toBe("O''Brien''s");
    expect(sqlEscapeString('no quotes')).toBe('no quotes');
    expect(sqlEscapeString('')).toBe('');
    expect(sqlEscapeString("'; DROP TABLE costs; --")).toBe("''; DROP TABLE costs; --");
  });

  it('escapes a single quote in tagName inside the element_at key', async () => {
    const dimensions: DimensionsConfig = {
      builtIn: [],
      tags: [{ tagName: QUOTED_TAG_KEY, label: "O'Brien Team" }],
    };
    const source = buildSource({ dataDir, tier: 'daily', dimensions, providers: [{ name: PROVIDER }] });

    // The quote arrives doubled in the generated SQL...
    expect(source).toContain("element_at(Tags, 'o''brien team')");

    // ...and DuckDB extracts the value under the original quoted key.
    const rows = await queryAll(conn, `SELECT account_id, tag_o_brien_team AS v FROM ${source} ORDER BY account_id`);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.['v']).toBe('Platform');
    expect(rows[1]?.['v']).toBeNull();
  });

  it('escapes single quotes in accountTagFallback and missingValueTemplate', async () => {
    const dimensions: DimensionsConfig = {
      builtIn: [],
      tags: [{
        tagName: QUOTED_TAG_KEY,
        label: "O'Brien Team",
        accountTagFallback: QUOTED_FALLBACK_KEY,
        missingValueTemplate: "don't know ({fallback})",
      }],
    };
    const source = buildSource({ dataDir, tier: 'daily', dimensions, orgAccountsPath, providers: [{ name: PROVIDER }] });

    // Both config literals arrive escaped in the generated SQL.
    expect(source).toContain("tags->>'cost''center'");
    expect(source).toContain("'don''t know ('");

    // acct-1 has the resource tag, acct-2 falls back to the org-accounts
    // value formatted through the quoted template.
    const rows = await queryAll(conn, `SELECT account_id, tag_o_brien_team AS v FROM ${source} ORDER BY account_id`);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.['v']).toBe('Platform');
    expect(rows[1]?.['v']).toBe("don't know (cc-two)");
  });
});
