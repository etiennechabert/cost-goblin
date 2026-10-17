import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpContext } from '../context.js';
import { registerTools } from '../tools/index.js';

// registerTools wires each tool to the MCP server and turns anything the tool
// throws into an `Error: …` tool result (isError) instead of a protocol error.
// Driven over an in-memory transport: the real SDK client and server, no HTTP.

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

interface ToolOutcome {
  readonly text: string;
  readonly isError: boolean;
}

interface Connection {
  readonly client: Client;
  close(): Promise<void>;
}

async function connect(ctx: McpContext): Promise<Connection> {
  const server = new McpServer({ name: 'costgoblin', version: 'test' }, { capabilities: { tools: {} } });
  registerTools(server, ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'tool-registry-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const result: unknown = await client.callTool({ name, arguments: args });
  if (!isRecord(result)) throw new Error('tool result is not an object');
  const content: unknown = result['content'];
  const first: unknown = Array.isArray(content) ? content[0] : undefined;
  if (!isRecord(first) || first['type'] !== 'text' || typeof first['text'] !== 'string') {
    throw new Error(`tool ${name} returned no text content`);
  }
  return { text: first['text'], isError: result['isError'] === true };
}

/** A context on which every access fails with `reason` — thrown synchronously,
 *  so it escapes the tools' own `.catch()` fallbacks and reaches the registry. */
function failingCtx(reason: unknown): McpContext {
  const fail = (): never => { throw reason; };
  return {
    get dataDir(): string { throw reason; },
    get stateDir(): string { throw reason; },
    runQuery: fail,
    runPreparedQuery: fail,
    getConfig: fail,
    getDimensions: fail,
    getQueryDimensions: fail,
    getCostScope: fail,
    getAccountMap: fail,
    getAccountReverseMap: fail,
    getOrgAccountsPath: fail,
    materializedBase: { getSource: fail },
    warmup: fail,
    now: fail,
  };
}

/** Minimal valid arguments per tool; none passes a dateRange, so every tool
 *  touches the context before doing anything else. */
const TOOL_ARGS: readonly (readonly [name: string, args: Record<string, unknown>])[] = [
  ['get_cost_overview', {}],
  ['list_dimensions', {}],
  ['get_filter_values', { dimensionId: 'service' }],
  ['query_costs', { groupBy: 'service' }],
  ['query_daily_costs', {}],
  ['query_trends', { groupBy: 'service' }],
  ['query_entity_detail', { entity: 'Amazon S3', dimension: 'service' }],
  ['query_missing_tags', { tagDimension: 'tag_team' }],
  ['explore_data', {}],
  ['run_sql', { sql: 'SELECT service FROM costs' }],
  ['list_baselines', {}],
  ['get_baseline_drift', { id: 'b1' }],
];

describe('registerTools error handling', () => {
  it('registers exactly the tools the error cases cover', async () => {
    const conn = await connect(failingCtx(new Error('unused')));
    const { tools } = await conn.client.listTools();
    expect(tools.map(t => t.name).sort((a, b) => a.localeCompare(b)))
      .toEqual(TOOL_ARGS.map(([name]) => name).sort((a, b) => a.localeCompare(b)));
    await conn.close();
  });

  describe.each([
    ['an Error', new Error('workspace state is unavailable'), 'Error: workspace state is unavailable'],
    ['a thrown string', 'plain failure', 'Error: plain failure'],
    ['a thrown number', 503, 'Error: 503'],
  ])('when the context throws %s', (_label, reason, expected) => {
    let conn: Connection;
    beforeAll(async () => {
      conn = await connect(failingCtx(reason));
    });
    afterAll(async () => {
      await conn.close();
    });

    it.each(TOOL_ARGS)('%s returns an error result with the message', async (name, args) => {
      expect(await callTool(conn.client, name, args)).toEqual({ text: expected, isError: true });
    });
  });

  it('puts a multi-line error message on one line', async () => {
    const conn = await connect(failingCtx(new Error('first line\n## Forged heading')));
    const outcome = await callTool(conn.client, 'list_dimensions', {});
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toBe('Error: first line\\n## Forged heading');
    await conn.close();
  });
});

describe('registerTools baseline tools', () => {
  let stateDir: string;
  let conn: Connection;

  beforeAll(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'cg-mcp-registry-'));
    const unused = (): never => { throw new Error('not used by the baseline tools'); };
    conn = await connect({
      dataDir: stateDir,
      stateDir,
      runQuery: unused,
      runPreparedQuery: unused,
      getConfig: unused,
      getDimensions: unused,
      getQueryDimensions: unused,
      getCostScope: unused,
      getAccountMap: unused,
      getAccountReverseMap: unused,
      getOrgAccountsPath: unused,
      materializedBase: { getSource: () => undefined },
      warmup: () => Promise.resolve(),
      now: () => Date.UTC(2026, 2, 1),
    });
  });

  afterAll(async () => {
    await conn.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  it('list_baselines answers from the state dir', async () => {
    expect(await callTool(conn.client, 'list_baselines', { status: 'actionable', limit: 5, format: 'json' })).toEqual({
      text: 'No baselines found. They are discovered after a sync; ask the user to open the Baselines page and Recompute.',
      isError: false,
    });
  });

  it('get_baseline_drift passes its arguments through', async () => {
    expect(await callTool(conn.client, 'get_baseline_drift', { match: 'rds' })).toEqual({
      text: 'No matching baseline. Use list_baselines to see available scopes.',
      isError: false,
    });
  });

  it('list_baselines rejects a status outside the schema before the tool runs', async () => {
    const outcome = await callTool(conn.client, 'list_baselines', { status: 'acting' });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toMatch(/status/);
  });
});
