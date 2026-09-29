import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSource } from '../query/builder.js';
import { buildDuckDbSandboxStatements } from '../query/duckdb-sandbox.js';
import type { DimensionsConfig } from '../types/config.js';
import { asProviderName } from '../types/branded.js';

/**
 * Layer-2 proof of the MCP DuckDB sandbox (#594): a real instance configured
 * with buildDuckDbSandboxStatements still serves the queries MCP legitimately
 * runs (the costs CTE over Parquet + the org-accounts JSON join, and the
 * coverage MAX() probe) while refusing every reproduced read/write bypass of
 * the run_sql guard. A control block shows the same payloads DO read / write
 * on an unsandboxed instance, so the denials are the sandbox's doing.
 */

type Instance = Awaited<ReturnType<typeof DuckDBInstance.create>>;
type Conn = Awaited<ReturnType<Instance['connect']>>;
type Row = Record<string, unknown>;

const PROVIDER = asProviderName('aws');
const CREDS_CANARY = 'CANARY-AWS-SECRET-594';
const ADC_CANARY = 'CANARY-ADC-CLIENT-SECRET-594';
const DECOY_CANARY = 'CANARY-TELEMETRY-OUTBOX-594';
const SIBLING_CANARY = 'CANARY-PREFIX-SIBLING-594';

async function queryAll(conn: Conn, sql: string): Promise<Row[]> {
  const result = await conn.run(sql);
  const cols = result.columnCount;
  const names: string[] = [];
  for (let i = 0; i < cols; i++) names.push(result.columnName(i));
  const rows: Row[] = [];
  let chunk = await result.fetchChunk();
  while (chunk !== null && chunk.rowCount > 0) {
    for (let r = 0; r < chunk.rowCount; r++) {
      const row: Row = {};
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

/** Runs `sql` and returns either the serialised rows or the error message, so
 *  a test can assert BOTH that it failed and that no canary leaked anywhere. */
async function attempt(conn: Conn, sql: string): Promise<{ ok: true; text: string } | { ok: false; text: string }> {
  try {
    const rows = await queryAll(conn, sql);
    return { ok: true, text: JSON.stringify(rows, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v)) };
  } catch (err: unknown) {
    return { ok: false, text: err instanceof Error ? err.message : String(err) };
  }
}

const ALL_CANARIES = [CREDS_CANARY, ADC_CANARY, DECOY_CANARY, SIBLING_CANARY];

function expectDenied(res: { ok: boolean; text: string }): void {
  expect(res.ok).toBe(false);
  expect(res.text).toMatch(/Permission Error/);
  for (const canary of ALL_CANARIES) expect(res.text).not.toContain(canary);
}

describe('DuckDB sandbox (real DuckDB)', () => {
  let root: string;
  let dataDir: string;
  let stateDir: string;
  let tempDir: string;
  let outsideDir: string;
  let orgAccountsPath: string;
  let sandboxDb: Instance;
  let sandbox: Conn;

  // Read-bypass payloads that passed validateRunSqlQuery (VULN-003), keyed by
  // the target file they try to read.
  const readPayloads = (): readonly (readonly [string, string, string])[] => [
    ['double-quoted alias desyncs the scrubber', `SELECT 1 AS "a'b", * FROM read_text('${outsideDir}/creds.txt')`, CREDS_CANARY],
    ['comma join onto a replacement-scan path', `SELECT * FROM (SELECT 1 AS x) AS costs, '${outsideDir}/adc.json'`, ADC_CANARY],
    ['quoted function name', `SELECT * FROM "read_text"('${outsideDir}/creds.txt')`, CREDS_CANARY],
    [
      'json_execute_serialized_sql wrapper',
      `SELECT * FROM json_execute_serialized_sql(json_serialize_sql('SELECT content FROM read_text(''${outsideDir}/creds.txt'')'))`,
      CREDS_CANARY,
    ],
  ];

  const stackedWrite = (target: string): string =>
    `SELECT 1 AS "a'b"; COPY (SELECT 42 AS v) TO '${target}' (FORMAT CSV); SELECT 1 LIMIT 1`;

  beforeAll(async () => {
    // realpath: on macOS the tmpdir resolves under /var -> /private/var, and
    // DuckDB matches the canonical path, so the allow-list must be canonical.
    // Forward slashes keep the read_parquet glob and the paths consistent on
    // Windows (a no-op on POSIX).
    root = (await realpath(await mkdtemp(join(tmpdir(), 'cg-duckdb-sandbox-')))).replaceAll('\\', '/');
    dataDir = `${root}/data`;
    stateDir = `${root}/state`;
    tempDir = `${root}/tmp`;
    outsideDir = `${root}/outside`;
    const monthDir = `${dataDir}/aws/raw/daily-2026-01`;
    for (const d of [monthDir, stateDir, tempDir, outsideDir, `${dataDir}/links`, `${root}/data2`]) {
      await mkdir(d, { recursive: true });
    }

    // Fixture data is written through an UNRESTRICTED instance.
    const setupDb = await DuckDBInstance.create();
    const setup = await setupDb.connect();
    await setup.run(`
      COPY (
        SELECT * FROM (VALUES
          (TIMESTAMP '2026-01-05 00:00:00', 'acct-1', 'Account One', 'eu-west-1',
           'Amazon Elastic Compute Cloud', 'AmazonEC2', 'Compute', 'instance usage',
           10.0, 12.0, 'arn:aws:ec2:res-1', 10.0, 'Usage', 'Standard', '',
           'RunInstances', 'BoxUsage', MAP {'team': 'Platform'}),
          (TIMESTAMP '2026-01-06 00:00:00', 'acct-2', 'Account Two', 'eu-west-1',
           'Amazon Simple Storage Service', 'AmazonS3', 'Storage', 'storage usage',
           5.0, 6.0, 'arn:aws:s3:res-2', 5.0, 'Usage', 'Standard', '',
           'PutObject', 'TimedStorage', MAP {'unrelated': 'x'})
        ) AS t(ChargePeriodStart, SubAccountId, SubAccountName, RegionId,
               ServiceName, x_ServiceCode, ServiceCategory, ChargeDescription,
               ConsumedQuantity, ListCost, ResourceId, EffectiveCost,
               ChargeCategory, PricingCategory, CommitmentDiscountStatus,
               x_Operation, SkuMeter, Tags)
      ) TO '${monthDir}/data.parquet' (FORMAT PARQUET)
    `);
    setup.disconnectSync();
    setupDb.closeSync();

    orgAccountsPath = `${stateDir}/org-account-tags.json`;
    await writeFile(orgAccountsPath, JSON.stringify([
      { id: 'acct-1', tags: { 'cost-center': 'cc-one' } },
      { id: 'acct-2', tags: { 'cost-center': 'cc-two' } },
    ]));
    await writeFile(`${stateDir}/telemetry-outbox.jsonl`, `{"event":"${DECOY_CANARY}"}\n`);
    await writeFile(`${outsideDir}/creds.txt`, `[default]\naws_secret_access_key = ${CREDS_CANARY}\n`);
    await writeFile(`${outsideDir}/adc.json`, JSON.stringify({ type: 'authorized_user', client_secret: ADC_CANARY }));
    await writeFile(`${root}/data2/secret.txt`, SIBLING_CANARY);
    await symlink(`${outsideDir}/creds.txt`, `${dataDir}/links/creds.txt`);

    sandboxDb = await DuckDBInstance.create();
    sandbox = await sandboxDb.connect();
    for (const stmt of buildDuckDbSandboxStatements({
      allowedDirectories: [dataDir, tempDir],
      allowedPaths: [orgAccountsPath],
      tempDirectory: tempDir,
      memoryLimitGB: 1,
      threads: 2,
    })) {
      await sandbox.run(stmt);
    }
  });

  afterAll(async () => {
    sandbox.disconnectSync();
    sandboxDb.closeSync();
    await rm(root, { recursive: true, force: true });
  });

  describe('legitimate MCP reads still work', () => {
    it('runs the costs source with the org-accounts JSON join', async () => {
      const dimensions: DimensionsConfig = {
        builtIn: [],
        tags: [{ tagName: 'team', label: 'Team', accountTagFallback: 'cost-center' }],
      };
      const source = buildSource({ dataDir, tier: 'daily', dimensions, orgAccountsPath, providers: [{ name: PROVIDER }] });
      // The org-accounts join reads with an explicit-schema read_json (#603);
      // it must still resolve inside the sandbox's allowed_paths.
      expect(source).toContain(`read_json('${orgAccountsPath}', format='array'`);
      const rows = await queryAll(sandbox, `SELECT account_id, tag_team AS v FROM ${source} ORDER BY account_id`);
      expect(rows).toHaveLength(2);
      expect(rows[0]?.['v']).toBe('Platform');
      expect(rows[1]?.['v']).toBe('cc-two');
    });

    it('runs the coverage MAX(ChargePeriodStart) probe', async () => {
      const rows = await queryAll(
        sandbox,
        `SELECT MAX(ChargePeriodStart::DATE)::VARCHAR AS d FROM read_parquet(['${dataDir}/aws/raw/daily-2026-01/*.parquet'])`,
      );
      expect(rows[0]?.['d']).toBe('2026-01-06');
    });
  });

  describe('reproduced run_sql bypasses are refused', () => {
    it.each([0, 1, 2, 3])('read payload #%i is denied and leaks nothing', async (i) => {
      const payload = readPayloads()[i];
      if (payload === undefined) throw new Error(`no payload ${String(i)}`);
      expectDenied(await attempt(sandbox, payload[1]));
    });

    it('a stacked COPY ending in its own LIMIT is denied and writes nothing', async () => {
      const target = `${outsideDir}/stacked.csv`;
      expectDenied(await attempt(sandbox, stackedWrite(target)));
      expect(existsSync(target)).toBe(false);
    });

    it('a stacked ATTACH is denied and creates nothing', async () => {
      const target = `${outsideDir}/attached.db`;
      expectDenied(await attempt(sandbox, `SELECT 1 AS "a'b"; ATTACH '${target}' AS x; SELECT 1 LIMIT 1`));
      expect(existsSync(target)).toBe(false);
    });
  });

  describe('everything outside the grants is denied', () => {
    it('another stateDir file (telemetry outbox)', async () => {
      expectDenied(await attempt(sandbox, `SELECT content FROM read_text('${stateDir}/telemetry-outbox.jsonl')`));
    });

    it('.. traversal out of the data dir', async () => {
      expectDenied(await attempt(sandbox, `SELECT content FROM read_text('${dataDir}/../outside/creds.txt')`));
    });

    it('an outward symlink inside the data dir', async () => {
      expectDenied(await attempt(sandbox, `SELECT content FROM read_text('${dataDir}/links/creds.txt')`));
    });

    it('a prefix-sibling directory of the data dir', async () => {
      expectDenied(await attempt(sandbox, `SELECT content FROM read_text('${root}/data2/secret.txt')`));
    });

    it('an http:// URL', async () => {
      expectDenied(await attempt(sandbox, `SELECT * FROM read_csv('http://127.0.0.1:9/x.csv')`));
    });

    it('loading an extension from disk', async () => {
      const res = await attempt(sandbox, `LOAD '${outsideDir}/evil.duckdb_extension'`);
      expect(res.ok).toBe(false);
    });
  });

  describe('the configuration is locked', () => {
    it.each([
      'SET enable_external_access = true',
      'SET memory_limit = \'3GB\'',
      'SET lock_configuration = false',
    ])('%s fails', async (stmt) => {
      const res = await attempt(sandbox, stmt);
      expect(res.ok).toBe(false);
      expect(res.text).toMatch(/locked/);
    });

    it('a new allowed_directories grant fails', async () => {
      const res = await attempt(sandbox, `SET allowed_directories = ['${outsideDir}']`);
      expect(res.ok).toBe(false);
      expectDenied(await attempt(sandbox, `SELECT content FROM read_text('${outsideDir}/creds.txt')`));
    });

    it('a second connection inherits the sandbox', async () => {
      const second = await sandboxDb.connect();
      try {
        expectDenied(await attempt(second, `SELECT content FROM read_text('${outsideDir}/creds.txt')`));
        const rows = await queryAll(second, `SELECT count(*)::INTEGER AS n FROM read_parquet('${dataDir}/aws/raw/daily-*/*.parquet')`);
        expect(rows[0]?.['n']).toBe(2);
      } finally {
        second.disconnectSync();
      }
    });

    it('an allowed_paths file created after the lock is readable', async () => {
      const lateDb = await DuckDBInstance.create();
      const late = await lateDb.connect();
      const latePath = `${stateDir}/late-org-account-tags.json`;
      try {
        for (const stmt of buildDuckDbSandboxStatements({
          allowedDirectories: [dataDir], allowedPaths: [latePath], tempDirectory: tempDir, memoryLimitGB: 1, threads: 1,
        })) {
          await late.run(stmt);
        }
        await writeFile(latePath, JSON.stringify([{ id: 'acct-9', tags: {} }]));
        const rows = await queryAll(late, `SELECT id FROM read_json_auto('${latePath}')`);
        expect(rows[0]?.['id']).toBe('acct-9');
      } finally {
        late.disconnectSync();
        lateDb.closeSync();
      }
    });
  });

  describe('control: an unsandboxed instance is exposed to the same payloads', () => {
    let openDb: Instance;
    let open: Conn;

    beforeAll(async () => {
      openDb = await DuckDBInstance.create();
      open = await openDb.connect();
    });

    afterAll(() => {
      open.disconnectSync();
      openDb.closeSync();
    });

    it.each([0, 1, 2, 3])('read payload #%i reads the canary', async (i) => {
      const payload = readPayloads()[i];
      if (payload === undefined) throw new Error(`no payload ${String(i)}`);
      const res = await attempt(open, payload[1]);
      expect(res.ok).toBe(true);
      expect(res.text).toContain(payload[2]);
    });

    it('the stacked COPY writes the file', async () => {
      const target = `${outsideDir}/control-stacked.csv`;
      const res = await attempt(open, stackedWrite(target));
      expect(res.ok).toBe(true);
      expect(existsSync(target)).toBe(true);
    });
  });
});
