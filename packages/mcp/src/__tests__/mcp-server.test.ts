import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildDuckDbSandboxStatements,
  loadConfig,
  loadDimensions,
  loadCostScope,
} from '@costgoblin/core';
import type { McpContext, RawRow } from '../context.js';
import { createMcpHttpServer, MCP_MIN_TOKEN_LENGTH } from '../http-server.js';
import type { McpHttpServer } from '../http-server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, '..', '..', '..', 'core', 'src', '__fixtures__');
const SYNTHETIC_DIR = join(FIXTURES_DIR, 'synthetic');
const CONFIG_DIR = join(FIXTURES_DIR, 'config');

// ---------- DuckDB helpers ----------

type DuckDBConn = Awaited<ReturnType<Awaited<ReturnType<typeof DuckDBInstance.create>>['connect']>>;

async function queryAll(conn: DuckDBConn, sql: string): Promise<RawRow[]> {
  const result = await conn.run(sql);
  const cols = result.columnCount;
  const names: string[] = [];
  for (let i = 0; i < cols; i++) names.push(result.columnName(i));
  const rows: RawRow[] = [];
  let chunk = await result.fetchChunk();
  while (chunk !== null && chunk.rowCount > 0) {
    for (let r = 0; r < chunk.rowCount; r++) {
      const row: Record<string, unknown> = {};
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

// ---------- JSON response narrowing ----------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

interface RunSqlJson {
  readonly columnKeys: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
  readonly rowsMeta: unknown;
  readonly notes: readonly string[];
}

/** Narrow a run_sql format=json response to the parts the cap tests check. */
function runSqlJson(text: string): RunSqlJson {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error('response is not an object');
  const tables = parsed['tables'];
  const table: unknown = Array.isArray(tables) ? tables[0] : undefined;
  if (!isRecord(table)) throw new Error('response has no table');
  const columns = table['columns'];
  const rows = table['rows'];
  if (!Array.isArray(columns) || !Array.isArray(rows)) throw new Error('table has no columns/rows');
  const columnKeys = columns.map((c: unknown) => (isRecord(c) && typeof c['key'] === 'string' ? c['key'] : ''));
  const narrowedRows = rows.map((r: unknown) => {
    if (!Array.isArray(r)) throw new Error('row is not an array');
    const cells: unknown[] = r;
    return cells;
  });
  const meta = parsed['meta'];
  const rowsField: unknown = Array.isArray(meta)
    ? meta.find((m: unknown) => isRecord(m) && m['label'] === 'Rows')
    : undefined;
  const notesField = parsed['notes'];
  const notes = Array.isArray(notesField)
    ? notesField.filter((n: unknown): n is string => typeof n === 'string')
    : [];
  return {
    columnKeys,
    rows: narrowedRows,
    rowsMeta: isRecord(rowsField) ? rowsField['value'] : undefined,
    notes,
  };
}

// ---------- MCP HTTP client ----------

interface McpClient {
  sessionId: string;
  callTool(name: string, args?: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  listTools(): Promise<{ name: string; description: string }[]>;
  close(): Promise<void>;
}

async function createMcpClient(port: number, token: string): Promise<McpClient> {
  const base = `http://127.0.0.1:${String(port)}/mcp`;
  let nextId = 1;

  async function rpc(method: string, params?: Record<string, unknown>): Promise<{ sessionId: string | null; result: unknown }> {
    const id = nextId++;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${token}`,
    };
    if (client.sessionId.length > 0) {
      headers['Mcp-Session-Id'] = client.sessionId;
      headers['Mcp-Protocol-Version'] = '2025-03-26';
    }

    const body: Record<string, unknown> = { jsonrpc: '2.0', method, id };
    if (params !== undefined) body['params'] = params;

    const response = await fetch(base, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await response.text();

    const sessionHeader = response.headers.get('mcp-session-id');

    const dataLine = text.split('\n').find(l => l.startsWith('data: '));
    if (dataLine === undefined) throw new Error(`No data line in response: ${text}`);
    const parsed: unknown = JSON.parse(dataLine.slice(6));
    if (typeof parsed !== 'object' || parsed === null || !('result' in parsed)) {
      throw new Error(`Unexpected response: ${JSON.stringify(parsed)}`);
    }
    return { sessionId: sessionHeader, result: parsed.result };
  }

  async function notify(method: string): Promise<void> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${token}`,
    };
    if (client.sessionId.length > 0) {
      headers['Mcp-Session-Id'] = client.sessionId;
      headers['Mcp-Protocol-Version'] = '2025-03-26';
    }
    await fetch(base, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', method }),
    });
  }

  const client: McpClient = {
    sessionId: '',

    async callTool(name: string, args?: Record<string, unknown>) {
      const { result } = await rpc('tools/call', { name, arguments: args ?? {} });
      const r = result as { content: { type: string; text: string }[]; isError?: boolean };
      const first = r.content[0];
      if (first === undefined) throw new Error('No content in tool result');
      return { text: first.text, isError: r.isError === true };
    },

    async listTools() {
      const { result } = await rpc('tools/list');
      const r = result as { tools: { name: string; description: string }[] };
      return r.tools;
    },

    async close() {
      if (client.sessionId.length > 0) {
        await fetch(base, {
          method: 'DELETE',
          headers: {
            'Mcp-Session-Id': client.sessionId,
            'Mcp-Protocol-Version': '2025-03-26',
            'Authorization': `Bearer ${token}`,
          },
        });
      }
    },
  };

  const { sessionId, result } = await rpc('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'test', version: '0.1.0' },
  });
  if (sessionId !== null) client.sessionId = sessionId;

  const initResult = result as { serverInfo: { name: string } };
  if (initResult.serverInfo.name !== 'costgoblin') {
    throw new Error(`Unexpected server name: ${initResult.serverInfo.name}`);
  }

  await notify('notifications/initialized');
  return client;
}

// ---------- Test suite ----------

describe('MCP server E2E', () => {
  let db: Awaited<ReturnType<typeof DuckDBInstance.create>>;
  let conn: DuckDBConn;
  let server: McpHttpServer;
  let client: McpClient;
  const port = 19599; // avoid conflict with running dev server
  // Production tokens are 43 chars (32 random bytes, base64url); the server
  // refuses to start with fewer than MCP_MIN_TOKEN_LENGTH.
  const TEST_TOKEN = 'test-secret-token-0123456789abcdefghij';
  // Outside the sandbox grants: a fake credentials file (#594 canary) and the
  // target of the stacked-write payload. The instance's spill dir lives here too
  // (granted), in its own subdirectory.
  let scratchDir: string;
  let outsideDir: string;
  const CANARY = 'CANARY-MCP-E2E-SECRET-594';
  let ctx: McpContext;

  beforeAll(async () => {
    scratchDir = realpathSync(await mkdtemp(join(tmpdir(), 'cg-mcp-e2e-'))).replaceAll('\\', '/');
    outsideDir = `${scratchDir}/outside`;
    const spillDir = `${scratchDir}/spill`;
    await mkdir(outsideDir, { recursive: true });
    await mkdir(spillDir, { recursive: true });
    await writeFile(`${outsideDir}/creds.txt`, `[default]\naws_secret_access_key = ${CANARY}\n`);
    await writeFile(`${outsideDir}/adc.json`, JSON.stringify({ type: 'authorized_user', client_secret: CANARY }));

    db = await DuckDBInstance.create();
    conn = await db.connect();
    // Every tool in this suite runs on a sandboxed, locked instance — the same
    // configuration the desktop app gives its dedicated MCP worker.
    for (const stmt of buildDuckDbSandboxStatements({
      allowedDirectories: [realpathSync(SYNTHETIC_DIR), spillDir],
      allowedPaths: [],
      tempDirectory: spillDir,
      memoryLimitGB: 1,
      threads: 2,
    })) {
      await conn.run(stmt);
    }

    const config = await loadConfig(join(CONFIG_DIR, 'costgoblin.yaml'));
    const dimensions = await loadDimensions(join(CONFIG_DIR, 'dimensions.yaml'));
    const costScope = await loadCostScope(join(CONFIG_DIR, 'cost-scope.yaml'));

    const accountMap = new Map<string, string>([
      ['100000000000', 'Acme Corp Main'],
      ['100000000001', 'Payments Production'],
      ['100000000002', 'Cards Production'],
      ['100000000003', 'Identity Production'],
      ['100000000004', 'Platform Engineering'],
      ['100000000005', 'Security Operations'],
      ['100000000006', 'Data Analytics'],
      ['100000000007', 'CI/CD Platform'],
    ]);

    const reverseMap = new Map<string, readonly string[]>();
    for (const [id, name] of accountMap) {
      const existing = reverseMap.get(name);
      if (existing !== undefined) {
        reverseMap.set(name, [...existing, id]);
      } else {
        reverseMap.set(name, [id]);
      }
    }

    const providerName = config.providers[0]?.name;
    if (providerName === undefined) throw new Error('fixture config has no providers');

    ctx = {
      dataDir: SYNTHETIC_DIR,
      stateDir: FIXTURES_DIR,
      runQuery: (sql) => queryAll(conn, sql),
      runPreparedQuery: (sql, params) => queryAll(conn, substituteParams(sql, params)),
      getConfig: () => Promise.resolve(config),
      getDimensions: () => Promise.resolve(dimensions),
      getQueryDimensions: () => Promise.resolve(dimensions),
      getCostScope: () => Promise.resolve(costScope),
      getAccountMap: () => Promise.resolve(accountMap),
      getAccountReverseMap: () => Promise.resolve(reverseMap),
      getOrgAccountsPath: () => Promise.resolve(undefined),
      materializedBase: { getSource: () => undefined },
      warmup: () => Promise.resolve(),
    };

    server = await createMcpHttpServer(ctx, { port, authToken: TEST_TOKEN });
    client = await createMcpClient(port, TEST_TOKEN);
  }, 30_000);

  afterAll(async () => {
    await client.close();
    await server.close();
    conn.disconnectSync();
    db.closeSync();
    await rm(scratchDir, { recursive: true, force: true });
  });

  const mcpUrl = (): string => `http://127.0.0.1:${String(port)}/mcp`;

  /** POST an MCP initialize to `url` with the given extra headers. */
  function postInitialize(url: string, headers: Record<string, string>): Promise<Response> {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        id: 1,
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'q', version: '0.0.0' } },
      }),
    });
  }

  /** GET /health on `probePort`: the HTTP status, or the connection error code. */
  function probeHealth(probePort: number): Promise<string> {
    return new Promise<string>((resolve) => {
      const req = httpRequest(
        { host: '127.0.0.1', port: probePort, path: '/health', method: 'GET' },
        (res) => { res.resume(); resolve(`HTTP ${String(res.statusCode)}`); },
      );
      req.on('error', (err: NodeJS.ErrnoException) => { resolve(err.code ?? err.message); });
      req.end();
    });
  }

  // ---------- Protocol ----------

  it('lists all tools', async () => {
    const tools = await client.listTools();
    const names = tools.map(t => t.name);
    expect(names).toContain('get_cost_overview');
    expect(names).toContain('list_dimensions');
    expect(names).toContain('get_filter_values');
    expect(names).toContain('query_costs');
    expect(names).toContain('query_daily_costs');
    expect(names).toContain('query_trends');
    expect(names).toContain('query_entity_detail');
    expect(names).toContain('query_missing_tags');
    expect(names).toContain('explore_data');
    expect(names).toContain('run_sql');
    expect(names).toContain('list_baselines');
    expect(names).toContain('get_baseline_drift');
    expect(tools).toHaveLength(12);
  });

  it('supports multiple concurrent sessions', async () => {
    const client2 = await createMcpClient(port, TEST_TOKEN);
    expect(client2.sessionId).not.toBe(client.sessionId);
    const tools = await client2.listTools();
    expect(tools).toHaveLength(12);
    await client2.close();
  });

  // ---------- get_cost_overview ----------

  it('get_cost_overview returns total spend and top services', async () => {
    const { text } = await client.callTool('get_cost_overview', {
      dateRange: { start: '2026-01-01', end: '2026-01-31' },
    });
    expect(text).toContain('Cost Overview');
    expect(text).toContain('Total Cost');
    expect(text).toContain('Top Services');
    expect(text).toContain('Top Accounts');
    expect(text).toContain('$');
  });

  it('get_cost_overview works with only dateRange (no other params)', async () => {
    const { text } = await client.callTool('get_cost_overview', {
      dateRange: { start: '2026-01-15', end: '2026-02-15' },
    });
    expect(text).toContain('Cost Overview');
  });

  // ---------- list_dimensions ----------

  it('list_dimensions returns built-in and tag dimensions', async () => {
    const { text } = await client.callTool('list_dimensions');
    expect(text).toContain('account');
    expect(text).toContain('service');
    expect(text).toContain('region');
    expect(text).toContain('team');
    expect(text).toContain('environment');
  });

  // ---------- get_filter_values ----------

  it('get_filter_values returns values for service dimension', async () => {
    const { text } = await client.callTool('get_filter_values', {
      dimensionId: 'service',
      dateRange: { start: '2026-01-01', end: '2026-01-31' },
    });
    expect(text).toContain('Amazon Elastic Compute Cloud');
    expect(text).toContain('Amazon Relational Database Service');
  });

  it('get_filter_values returns values for account dimension', async () => {
    const { text } = await client.callTool('get_filter_values', {
      dimensionId: 'account',
      dateRange: { start: '2026-01-01', end: '2026-01-31' },
    });
    expect(text).toContain('Acme Corp Main');
  });

  // ---------- query_costs ----------

  it('query_costs by service returns table with cost breakdown', async () => {
    const { text } = await client.callTool('query_costs', {
      groupBy: 'service',
      dateRange: { start: '2026-01-01', end: '2026-01-31' },
    });
    expect(text).toContain('Amazon Elastic Compute Cloud');
    expect(text).toContain('$');
    expect(text).toContain('%');
  });

  it('query_costs by account shows account names', async () => {
    const { text } = await client.callTool('query_costs', {
      groupBy: 'account',
      dateRange: { start: '2026-01-01', end: '2026-01-31' },
    });
    expect(text).toContain('Acme Corp Main');
  });

  it('query_costs with filter narrows results', async () => {
    const { text } = await client.callTool('query_costs', {
      groupBy: 'service',
      dateRange: { start: '2026-01-01', end: '2026-01-31' },
      filters: { region: ['eu-central-1'] },
    });
    expect(text).toContain('$');
  });

  // ---------- query_daily_costs ----------

  it('query_daily_costs returns time series', async () => {
    const { text } = await client.callTool('query_daily_costs', {
      dateRange: { start: '2026-01-01', end: '2026-01-07' },
    });
    expect(text).toContain('2026-01');
    expect(text).toContain('$');
  });

  it('query_daily_costs aggregates weekly for long ranges', async () => {
    const { text } = await client.callTool('query_daily_costs', {
      dateRange: { start: '2026-01-01', end: '2026-02-28' },
    });
    expect(text).toMatch(/Week|Total/);
  });

  // ---------- query_trends ----------

  it('query_trends shows period comparison', async () => {
    const { text } = await client.callTool('query_trends', {
      groupBy: 'service',
      dateRange: { start: '2026-02-01', end: '2026-02-28' },
    });
    expect(text).toMatch(/increase|saving|delta|change|Trend|vs/i);
  });

  // ---------- query_entity_detail ----------

  it('query_entity_detail drills into a service', async () => {
    const { text } = await client.callTool('query_entity_detail', {
      entity: 'Amazon Elastic Compute Cloud',
      dimension: 'service',
      dateRange: { start: '2026-01-01', end: '2026-01-31' },
    });
    expect(text).toContain('Amazon Elastic Compute Cloud');
    expect(text).toContain('$');
  });

  it('query_entity_detail drills into an account', async () => {
    const { text } = await client.callTool('query_entity_detail', {
      entity: 'Acme Corp Main',
      dimension: 'account',
      dateRange: { start: '2026-01-01', end: '2026-01-31' },
    });
    expect(text).toContain('Acme Corp Main');
  });

  // ---------- query_missing_tags ----------

  it('query_missing_tags finds untagged resources', async () => {
    const { text } = await client.callTool('query_missing_tags', {
      tagDimension: 'tag_team',
      dateRange: { start: '2026-01-01', end: '2026-01-31' },
      minCost: 0,
    });
    expect(text).toMatch(/missing|untagged|tag/i);
  });

  it('query_missing_tags shows default placeholder patterns in response', async () => {
    const { text } = await client.callTool('query_missing_tags', {
      tagDimension: 'tag_team',
      dateRange: { start: '2026-01-01', end: '2026-01-31' },
      minCost: 0,
    });
    expect(text).toContain('Placeholder Patterns Treated As Missing');
    expect(text).toContain('unknown-%');
    expect(text).toContain('none');
  });

  it('query_missing_tags accepts custom placeholderPatterns', async () => {
    const { text } = await client.callTool('query_missing_tags', {
      tagDimension: 'tag_team',
      dateRange: { start: '2026-01-01', end: '2026-01-31' },
      minCost: 0,
      placeholderPatterns: ['todo-%', 'placeholder'],
    });
    expect(text).toContain('todo-%');
    expect(text).toContain('placeholder');
    expect(text).not.toContain('unknown-%');
  });

  it('query_missing_tags accepts empty placeholderPatterns array', async () => {
    const { text } = await client.callTool('query_missing_tags', {
      tagDimension: 'tag_team',
      dateRange: { start: '2026-01-01', end: '2026-01-31' },
      minCost: 0,
      placeholderPatterns: [],
    });
    expect(text).toContain('Placeholder Patterns Treated As Missing');
    expect(text).toContain('(none)');
  });

  // ---------- explore_data ----------

  it('explore_data returns raw rows', async () => {
    const { text } = await client.callTool('explore_data', {
      dateRange: { start: '2026-01-01', end: '2026-01-07' },
      limit: 5,
    });
    expect(text).toContain('|');
  });

  it('explore_data aggregates with groupByColumns', async () => {
    const { text } = await client.callTool('explore_data', {
      dateRange: { start: '2026-01-01', end: '2026-01-31' },
      groupByColumns: ['service', 'region'],
      limit: 10,
    });
    expect(text).toContain('Amazon Elastic Compute Cloud');
    expect(text).toContain('eu-central-1');
  });

  it('explore_data rejects a tag_-prefixed sort column that is not a bare identifier', async () => {
    // The tag_ pass-through must stay identifier-shaped: a bare prefix check
    // would interpolate this straight into ORDER BY and execute read_csv.
    const { text, isError } = await client.callTool('explore_data', {
      dateRange: { start: '2026-01-01', end: '2026-01-07' },
      sort: { column: "tag_x = read_csv('no-such-file.csv')", direction: 'asc' },
      groupByColumns: ["tag_y, read_csv('no-such-file.csv')"],
      limit: 5,
    });
    // Both hostile columns are dropped: the group-by list empties (raw mode)
    // and the sort falls back to the default, so the query still succeeds.
    expect(isError).toBe(false);
    expect(text).toContain('Raw Data');
  });

  // ---------- run_sql ----------

  it('run_sql executes ad-hoc query with explicit date range', async () => {
    const { text, isError } = await client.callTool('run_sql', {
      sql: 'SELECT service, SUM(cost) as total FROM costs GROUP BY service ORDER BY total DESC LIMIT 5',
      dateRange: { start: '2026-01-01', end: '2026-01-31' },
    });
    expect(isError).toBe(false);
    expect(text).toContain('Query Result');
    expect(text).toContain('|');
  });

  it('run_sql accepts a trailing semicolon and LIMIT ... OFFSET inside the capped wrapper', async () => {
    // The validator tolerates one trailing ';' — the wrapper must strip it too,
    // or the `) AS _costgoblin_q LIMIT n` that closes the subquery lands after
    // the ';' and DuckDB rejects the statement. A user LIMIT/OFFSET stays inside
    // the subquery, where it is legal.
    for (const sql of [
      'SELECT service, SUM(cost) as total FROM costs GROUP BY service ORDER BY total DESC LIMIT 5;',
      'SELECT service, SUM(cost) as total FROM costs GROUP BY service ORDER BY total DESC LIMIT 5 OFFSET 1',
      'SELECT service FROM costs GROUP BY service;',
    ]) {
      const { text, isError } = await client.callTool('run_sql', {
        sql,
        dateRange: { start: '2026-01-01', end: '2026-01-31' },
      });
      expect(isError).toBe(false);
      expect(text).toContain('Query Result');
    }
  });

  // #601 / VULN-048: the row cap is an unconditional ceiling, not opt-out.
  const JAN = { start: '2026-01-01', end: '2026-01-31' };

  it('run_sql caps a query that ends in its own larger LIMIT', async () => {
    const { text, isError } = await client.callTool('run_sql', {
      sql: 'SELECT * FROM costs LIMIT 100000',
      dateRange: JAN,
      limit: 5,
      format: 'json',
    });
    expect(isError).toBe(false);
    const res = runSqlJson(text);
    expect(res.rows).toHaveLength(5);
    expect(res.rowsMeta).toBe(5);
    expect(res.notes.join(' ')).toMatch(/truncated to 5 rows/);
  });

  it('run_sql caps a query whose LIMIT is only inside a trailing comment', async () => {
    const { text, isError } = await client.callTool('run_sql', {
      sql: 'SELECT * FROM costs -- LIMIT 1',
      dateRange: JAN,
      format: 'json',
    });
    expect(isError).toBe(false);
    const res = runSqlJson(text);
    expect(res.rows).toHaveLength(100);
    expect(res.notes.join(' ')).toMatch(/truncated to 100 rows/);
  });

  it('run_sql runs a WITH query over costs and keeps its ORDER BY', async () => {
    const { text, isError } = await client.callTool('run_sql', {
      sql: 'WITH t AS (SELECT service, SUM(cost) c FROM costs GROUP BY 1) SELECT * FROM t ORDER BY c DESC',
      dateRange: JAN,
      format: 'json',
    });
    expect(isError).toBe(false);
    const res = runSqlJson(text);
    const cIdx = res.columnKeys.indexOf('c');
    expect(cIdx).toBeGreaterThanOrEqual(0);
    const values = res.rows.map(r => r[cIdx]);
    expect(values.length).toBeGreaterThan(1);
    for (let i = 1; i < values.length; i++) {
      const prev = values[i - 1];
      const cur = values[i];
      if (typeof prev !== 'number' || typeof cur !== 'number') throw new Error('non-numeric c');
      expect(cur).toBeLessThanOrEqual(prev);
    }
  });

  it('run_sql adds no truncation note when the result is exactly the limit', async () => {
    const { text, isError } = await client.callTool('run_sql', {
      sql: 'SELECT service FROM costs GROUP BY service ORDER BY service LIMIT 3',
      dateRange: JAN,
      limit: 3,
      format: 'json',
    });
    expect(isError).toBe(false);
    const res = runSqlJson(text);
    expect(res.rows).toHaveLength(3);
    expect(res.notes).toHaveLength(0);
  });

  it('run_sql keeps a trailing LIMIT ... OFFSET ...; working', async () => {
    const { text, isError } = await client.callTool('run_sql', {
      sql: 'SELECT service FROM costs GROUP BY service ORDER BY service LIMIT 3 OFFSET 1;',
      dateRange: JAN,
      format: 'json',
    });
    expect(isError).toBe(false);
    expect(runSqlJson(text).rows).toHaveLength(3);
  });

  it('run_sql stays capped when the query tries to close the wrapper subquery', async () => {
    const { text, isError } = await client.callTool('run_sql', {
      sql: 'SELECT * FROM costs) AS a UNION ALL SELECT * FROM (SELECT * FROM costs',
      dateRange: JAN,
      limit: 5,
      format: 'json',
    });
    expect(isError).toBe(false);
    expect(runSqlJson(text).rows.length).toBeLessThanOrEqual(5);
  });

  it.each([
    'SELECT * FROM costs /*',
    'SELECT * FROM costs) /*',
  ])('run_sql rejects %s (an unterminated comment cannot swallow the cap)', async (sql) => {
    const { isError } = await client.callTool('run_sql', { sql, dateRange: JAN });
    expect(isError).toBe(true);
  });

  it('run_sql truncates an oversized cell instead of blowing up the markdown table', async () => {
    const { text, isError } = await client.callTool('run_sql', {
      sql: "SELECT CASE WHEN row_number() OVER () = 1 THEN repeat('x', 6000000) ELSE 'y' END AS a FROM costs",
      dateRange: JAN,
    });
    expect(isError).toBe(false);
    expect(text).toContain('…[+');
    expect(text.length).toBeLessThan(1_000_000);
  });

  it.each([
    ['run_sql', { sql: 'SELECT 1 AS x FROM costs' }],
    ['explore_data', {}],
  ])('%s rejects a non-integer or non-positive limit', async (tool, extra) => {
    for (const limit of [-1, 0, 2.5]) {
      const { isError } = await client.callTool(tool, { ...extra, dateRange: JAN, limit });
      expect(isError).toBe(true);
    }
  });

  it('run_sql rejects non-SELECT queries', async () => {
    const { text, isError } = await client.callTool('run_sql', {
      sql: 'DROP TABLE costs',
    });
    expect(isError).toBe(true);
    expect(text).toMatch(/error|select|not allowed/i);
  });

  it('run_sql blocks reading local files via DuckDB file functions', async () => {
    const { text, isError } = await client.callTool('run_sql', {
      sql: "SELECT * FROM read_text('/etc/hostname')",
      dateRange: { start: '2026-01-01', end: '2026-01-31' },
    });
    expect(isError).toBe(true);
    expect(text).toMatch(/not allowed|read_text/i);
  });

  // #594 / VULN-003: payloads that slip past validateRunSqlQuery. The sandboxed
  // instance must refuse them — the canary never comes back, nothing is written.
  it.each([
    ['a quote-desynced alias hiding read_text', () => `SELECT 1 AS "a'b", * FROM read_text('${outsideDir}/creds.txt')`],
    ['a comma join onto a JSON path', () => `SELECT * FROM (SELECT 1 AS x) AS costs, '${outsideDir}/adc.json'`],
    ['a quoted read_text name', () => `SELECT * FROM "read_text"('${outsideDir}/creds.txt')`],
    [
      'a quoted json_execute_serialized_sql wrapper',
      () => `SELECT * FROM "json_execute_serialized_sql"(json_serialize_sql('SELECT content FROM read_text(''${outsideDir}/creds.txt'')'))`,
    ],
  ])('run_sql cannot read an outside file via %s', async (_label, sql) => {
    const { text, isError } = await client.callTool('run_sql', {
      sql: sql(),
      dateRange: { start: '2026-01-01', end: '2026-01-31' },
    });
    expect(isError).toBe(true);
    expect(text).toMatch(/Permission Error/);
    expect(text).not.toContain(CANARY);
  });

  it('run_sql cannot stack a COPY that writes outside the workspace', async () => {
    const target = `${outsideDir}/stacked.csv`;
    const { text, isError } = await client.callTool('run_sql', {
      sql: `SELECT 1 AS "a'b"; COPY (SELECT 42) TO '${target}'; SELECT 1 LIMIT 1`,
      dateRange: { start: '2026-01-01', end: '2026-01-31' },
    });
    expect(isError).toBe(true);
    expect(text).not.toContain(CANARY);
    expect(existsSync(target)).toBe(false);
  });

  it('run_sql still answers with a coverage latest day on the sandboxed instance', async () => {
    const { text, isError } = await client.callTool('run_sql', {
      sql: 'SELECT COUNT(*) AS n FROM costs',
      dateRange: { start: '2026-01-01', end: '2026-01-31' },
      format: 'json',
    });
    expect(isError).toBe(false);
    const parsed: unknown = JSON.parse(text);
    const latestDay = typeof parsed === 'object' && parsed !== null && 'coverage' in parsed
      && typeof parsed.coverage === 'object' && parsed.coverage !== null && 'latestDay' in parsed.coverage
      ? parsed.coverage.latestDay
      : undefined;
    expect(latestDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('rejects requests with a non-loopback Host header (anti DNS-rebinding)', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port, path: '/health', method: 'GET', headers: { Host: 'evil.example.com' } },
        (res) => { res.resume(); resolve(res.statusCode ?? 0); },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it('rejects /mcp requests without the auth token', async () => {
    const res = await fetch(`http://127.0.0.1:${String(port)}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects /mcp requests with the wrong auth token', async () => {
    const res = await fetch(`http://127.0.0.1:${String(port)}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Authorization': 'Bearer not-the-real-token',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
    });
    expect(res.status).toBe(401);
  });

  it('uses a test token at least as long as the server requires', () => {
    expect(TEST_TOKEN.length).toBeGreaterThanOrEqual(MCP_MIN_TOKEN_LENGTH);
    expect(MCP_MIN_TOKEN_LENGTH).toBe(32);
  });

  it('rejects a ?token= query param without an Authorization header', async () => {
    const res = await postInitialize(`${mcpUrl()}?token=${TEST_TOKEN}`, {});
    expect(res.status).toBe(401);
  });

  it('accepts a valid Bearer header and ignores a bogus ?token= param', async () => {
    const res = await postInitialize(`${mcpUrl()}?token=garbage`, { 'Authorization': `Bearer ${TEST_TOKEN}` });
    expect(res.status).toBe(200);
  });

  it('rejects a non-Bearer Authorization scheme even alongside a valid ?token=', async () => {
    const res = await postInitialize(`${mcpUrl()}?token=${TEST_TOKEN}`, { 'Authorization': 'Basic x' });
    expect(res.status).toBe(401);
  });

  it('checks the token on every request, including on an established session', async () => {
    const sessionHeaders = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Mcp-Session-Id': client.sessionId,
      'Mcp-Protocol-Version': '2025-03-26',
    };
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 99 });
    const noHeader = await fetch(mcpUrl(), { method: 'POST', headers: sessionHeaders, body });
    expect(noHeader.status).toBe(401);
    const wrongToken = await fetch(mcpUrl(), {
      method: 'POST',
      headers: { ...sessionHeaders, 'Authorization': 'Bearer not-the-real-token' },
      body,
    });
    expect(wrongToken.status).toBe(401);
    const queryToken = await fetch(`${mcpUrl()}?token=${TEST_TOKEN}`, { method: 'POST', headers: sessionHeaders, body });
    expect(queryToken.status).toBe(401);
    // The session itself is untouched: the real client still works.
    expect(await client.listTools()).toHaveLength(12);
  });

  it.each([
    ['an empty token', ''],
    ['a 16-char token', 'x'.repeat(16)],
  ])('refuses to start with %s and never listens', async (_label, authToken) => {
    const shortPort = 19598;
    await expect(createMcpHttpServer(ctx, { port: shortPort, authToken })).rejects.toThrow(/at least 32 characters/);
    expect(await probeHealth(shortPort)).toBe('ECONNREFUSED');
  });

  it('leaves /health open (unauthenticated liveness probe)', async () => {
    const res = await fetch(`http://127.0.0.1:${String(port)}/health`);
    expect(res.status).toBe(200);
  });

  // ---------- data-coverage banner ----------

  it('every response includes a data-coverage banner', async () => {
    const { text } = await client.callTool('query_costs', {
      groupBy: 'service',
      dateRange: { start: '2026-01-01', end: '2026-01-31' },
    });
    expect(text).toMatch(/\*Data coverage:/);
    expect(text).toMatch(/Latest day: \d{4}-\d{2}-\d{2}/);
  });

  it('coverage banner makes missing requested periods explicit on partial overlap', async () => {
    // 2025-12 is missing, 2026-01 is present in fixtures — banner should call this out
    const { text } = await client.callTool('query_costs', {
      groupBy: 'service',
      dateRange: { start: '2025-12-01', end: '2026-01-31' },
    });
    expect(text).toMatch(/Missing periods in your requested range: 2025-12/);
  });

  it('coverage is included as a structured field when format=json', async () => {
    const { text } = await client.callTool('query_costs', {
      groupBy: 'service',
      dateRange: { start: '2026-01-01', end: '2026-01-31' },
      format: 'json',
    });
    const parsed = JSON.parse(text) as { coverage: { latestDay: string; lagDays: number; availableMonths: string[]; missingPeriods: string[]; missingInRange: string[] } };
    expect(parsed.coverage).toBeDefined();
    expect(parsed.coverage.latestDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Array.isArray(parsed.coverage.availableMonths)).toBe(true);
    expect(parsed.coverage.availableMonths.length).toBeGreaterThan(0);
    expect(typeof parsed.coverage.lagDays).toBe('number');
  });

  it('coverage is included as a CSV comment when format=csv', async () => {
    const { text } = await client.callTool('query_costs', {
      groupBy: 'service',
      dateRange: { start: '2026-01-01', end: '2026-01-31' },
      format: 'csv',
    });
    expect(text).toMatch(/^# Data coverage:/m);
  });

  // ---------- format parameter ----------

  it('format=json returns a JSON-parseable response with meta and tables', async () => {
    const { text } = await client.callTool('query_costs', {
      groupBy: 'service',
      dateRange: { start: '2026-01-01', end: '2026-01-31' },
      format: 'json',
    });
    const parsed = JSON.parse(text) as { title: string; meta: { label: string; value: unknown; type: string }[]; tables: { columns: { key: string; type: string }[]; rows: unknown[][] }[] };
    expect(parsed.title).toMatch(/Costs by/);
    expect(parsed.meta.find(m => m.label === 'Total')?.type).toBe('currency');
    expect(typeof parsed.meta.find(m => m.label === 'Total')?.value).toBe('number');
    expect(parsed.tables[0]?.columns.find(c => c.key === 'cost')?.type).toBe('currency');
    expect(parsed.tables[0]?.rows.length).toBeGreaterThan(0);
    const firstRow = parsed.tables[0]?.rows[0];
    expect(Array.isArray(firstRow)).toBe(true);
    expect(typeof firstRow?.[1]).toBe('number');
  });

  it('format=csv returns CSV with header and data rows', async () => {
    const { text } = await client.callTool('query_costs', {
      groupBy: 'service',
      dateRange: { start: '2026-01-01', end: '2026-01-31' },
      format: 'csv',
    });
    const lines = text.split('\n');
    const dataLines = lines.filter(l => !l.startsWith('#') && l.length > 0);
    expect(dataLines[0]).toContain('Service');
    expect(dataLines[0]).toContain('Cost');
    expect(dataLines.length).toBeGreaterThan(1);
    expect(dataLines[1]).toMatch(/^[^,]+,[\d.]+,/);
  });

  it('format=markdown is the default and matches no-format behavior', async () => {
    const { text: defaultText } = await client.callTool('query_costs', {
      groupBy: 'service',
      dateRange: { start: '2026-01-01', end: '2026-01-31' },
    });
    const { text: mdText } = await client.callTool('query_costs', {
      groupBy: 'service',
      dateRange: { start: '2026-01-01', end: '2026-01-31' },
      format: 'markdown',
    });
    expect(defaultText).toBe(mdText);
    expect(defaultText).toContain('|');
    expect(defaultText).toMatch(/## Costs by/);
  });

  it('format=json on get_cost_overview includes multiple tables', async () => {
    const { text } = await client.callTool('get_cost_overview', {
      dateRange: { start: '2026-01-01', end: '2026-01-31' },
      format: 'json',
    });
    const parsed = JSON.parse(text) as { tables: { title?: string }[] };
    expect(parsed.tables.length).toBeGreaterThanOrEqual(1);
    expect(parsed.tables.some(t => t.title === 'Top Services')).toBe(true);
  });

  // ---------- Error handling ----------

  it('returns error for invalid dimension', async () => {
    const { text, isError } = await client.callTool('query_costs', {
      groupBy: 'nonexistent_dimension',
      dateRange: { start: '2026-01-01', end: '2026-01-31' },
    });
    expect(isError).toBe(true);
    expect(text).toContain('Error');
  });

  // ---------- Health endpoint ----------

  it('health endpoint returns ok', async () => {
    const response = await fetch(`http://127.0.0.1:${String(port)}/health`);
    const body = await response.json() as { status: string };
    expect(response.status).toBe(200);
    expect(body.status).toBe('ok');
  });
});
