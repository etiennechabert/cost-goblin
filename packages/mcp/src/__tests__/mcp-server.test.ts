import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadConfig,
  loadDimensions,
  loadCostScope,
  listLocalMonths,
} from '@costgoblin/core';
import type { McpContext, RawRow } from '../context.js';
import { createMcpHttpServer } from '../http-server.js';
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

// ---------- MCP HTTP client ----------

interface McpClient {
  sessionId: string;
  callTool(name: string, args?: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  listTools(): Promise<{ name: string; description: string }[]>;
  close(): Promise<void>;
}

async function createMcpClient(port: number): Promise<McpClient> {
  const base = `http://127.0.0.1:${String(port)}/mcp`;
  let nextId = 1;

  async function rpc(method: string, params?: Record<string, unknown>): Promise<{ sessionId: string | null; result: unknown }> {
    const id = nextId++;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
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

  beforeAll(async () => {
    db = await DuckDBInstance.create();
    conn = await db.connect();

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

    const available = await listLocalMonths(SYNTHETIC_DIR, 'daily');
    const glob = `${SYNTHETIC_DIR}/aws/raw/daily-${String(available.at(-1))}/*.parquet`;
    const colRows = await queryAll(conn, `DESCRIBE SELECT * FROM read_parquet('${glob}') LIMIT 0`);
    const columns = new Set(colRows.map(r => String(r['column_name'])));

    const ctx: McpContext = {
      dataDir: SYNTHETIC_DIR,
      runQuery: (sql) => queryAll(conn, sql),
      runPreparedQuery: (sql, params) => queryAll(conn, substituteParams(sql, params)),
      getConfig: () => Promise.resolve(config),
      getDimensions: () => Promise.resolve(dimensions),
      getQueryDimensions: () => Promise.resolve(dimensions),
      getCostScope: () => Promise.resolve(costScope),
      getAccountMap: () => Promise.resolve(accountMap),
      getAccountReverseMap: () => Promise.resolve(reverseMap),
      getOrgAccountsPath: () => Promise.resolve(undefined),
      getAvailableColumns: () => Promise.resolve(columns),
      materializedBase: { getSource: () => undefined },
      warmup: () => Promise.resolve(),
    };

    server = await createMcpHttpServer(ctx, port);
    client = await createMcpClient(port);
  }, 30_000);

  afterAll(async () => {
    await client.close();
    await server.close();
  });

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
    expect(names).toContain('ai_query');
    expect(tools.length).toBe(11);
  });

  it('supports multiple concurrent sessions', async () => {
    const client2 = await createMcpClient(port);
    expect(client2.sessionId).not.toBe(client.sessionId);
    const tools = await client2.listTools();
    expect(tools.length).toBe(11);
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
    expect(text).toContain('AmazonEC2');
    expect(text).toContain('AmazonRDS');
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
    expect(text).toContain('AmazonEC2');
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
      entity: 'AmazonEC2',
      dimension: 'service',
      dateRange: { start: '2026-01-01', end: '2026-01-31' },
    });
    expect(text).toContain('AmazonEC2');
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
    expect(text).toContain('AmazonEC2');
    expect(text).toContain('eu-central-1');
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

  it('run_sql rejects non-SELECT queries', async () => {
    const { text, isError } = await client.callTool('run_sql', {
      sql: 'DROP TABLE costs',
    });
    expect(isError).toBe(true);
    expect(text).toMatch(/error|select|not allowed/i);
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
