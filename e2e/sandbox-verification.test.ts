import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeApp, launchApp, navigateTo } from './helpers.js';

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  app = await launchApp();
  page = await app.firstWindow();
  await expect(page).toHaveTitle('CostGoblin');
});

test.afterAll(async () => {
  await closeApp(app);
});

test('renderer is sandboxed', async () => {
  const sandboxed = await page.evaluate(() => {
    const debug = (window as { costgoblinDebug?: { isSandboxed: () => boolean } }).costgoblinDebug;
    return debug?.isSandboxed() ?? false;
  });
  expect(sandboxed).toBe(true);
});

// ---------------------------------------------------------------------------
// MCP DuckDB sandbox (#594): the embedded MCP server runs every query on a
// dedicated, locked-down DuckDB worker. Driven through the real app so the
// desktop wiring (canonical allow-list, spill dir, fail-closed start, the
// generic refusal message) is exercised, not just the core builder.
// ---------------------------------------------------------------------------

const MCP_PORT = 19631;
const MCP_BASE = `http://127.0.0.1:${String(MCP_PORT)}`;
const CANARY = 'CANARY-E2E-MCP-SECRET-594';
const REFUSAL = 'Query tried to read outside the CostGoblin workspace; only the costs data can be queried.';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

interface ToolText { text: string; isError: boolean }

async function waitForMcp(tokenFile: string): Promise<string> {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${MCP_BASE}/health`);
      if (res.ok && existsSync(tokenFile)) return readFileSync(tokenFile, 'utf-8').trim();
    } catch { /* not listening yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('MCP server did not come up');
}

async function openSession(token: string): Promise<(name: string, args: Record<string, unknown>) => Promise<ToolText>> {
  let sessionId = '';
  let nextId = 1;
  const headers = (): Record<string, string> => ({
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'Authorization': `Bearer ${token}`,
    ...(sessionId.length > 0 ? { 'Mcp-Session-Id': sessionId, 'Mcp-Protocol-Version': '2025-03-26' } : {}),
  });
  async function rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`${MCP_BASE}/mcp`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid !== null) sessionId = sid;
    const dataLine = (await res.text()).split('\n').find(l => l.startsWith('data: '));
    if (dataLine === undefined) throw new Error(`no data line for ${method}`);
    const parsed: unknown = JSON.parse(dataLine.slice(6));
    if (!isRecord(parsed)) throw new Error('bad response');
    return parsed['result'];
  }
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'e2e', version: '0.0.0' } });
  await fetch(`${MCP_BASE}/mcp`, { method: 'POST', headers: headers(), body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  return async (name, args) => {
    const result = await rpc('tools/call', { name, arguments: args });
    if (!isRecord(result) || !Array.isArray(result['content'])) throw new Error('bad tool result');
    const first: unknown = result['content'][0];
    const text = isRecord(first) && typeof first['text'] === 'string' ? first['text'] : '';
    return { text, isError: result['isError'] === true };
  };
}

test.describe('MCP queries run on a sandboxed DuckDB instance', () => {
  let mcpApp: ElectronApplication | undefined;
  let scratch: string;
  let callTool: (name: string, args: Record<string, unknown>) => Promise<ToolText>;
  const dateRange = { start: '2026-01-01', end: '2026-01-31' };

  test.beforeAll(async () => {
    test.setTimeout(60_000);
    scratch = mkdtempSync(join(tmpdir(), 'costgoblin-e2e-mcp-'));
    const userDataDir = join(scratch, 'userData');
    writeFileSync(join(scratch, 'creds.txt'), `aws_secret_access_key = ${CANARY}\n`);
    // The server is opt-in: a saved `mcp.enabled: true` is what starts it at launch.
    mcpApp = await launchApp({
      env: { COSTGOBLIN_USER_DATA_DIR: userDataDir, COSTGOBLIN_MCP_PORT: String(MCP_PORT) },
      stateFiles: { 'ui-preferences.json': JSON.stringify({ mcp: { enabled: true } }) },
    });
    await mcpApp.firstWindow();
    const token = await waitForMcp(join(userDataDir, 'mcp-auth-token'));
    callTool = await openSession(token);
  });

  test.afterAll(async () => {
    await closeApp(mcpApp);
    rmSync(scratch, { recursive: true, force: true });
  });

  test('run_sql still queries the costs data', async () => {
    const { text, isError } = await callTool('run_sql', { sql: 'SELECT COUNT(*) AS n FROM costs', dateRange });
    expect(isError).toBe(false);
    expect(text).toContain('Query Result');
    expect(text).toMatch(/Latest day: \d{4}-\d{2}-\d{2}/);
  });

  test('a guard-bypassing read gets the generic refusal and no file contents', async () => {
    const creds = join(scratch, 'creds.txt').replaceAll('\\', '/');
    const { text, isError } = await callTool('run_sql', {
      sql: `SELECT 1 AS "a'b", * FROM read_text('${creds}')`,
      dateRange,
    });
    expect(isError).toBe(true);
    expect(text).toContain(REFUSAL);
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain('Permission Error');
    expect(text).not.toContain(scratch);
  });

  test('a stacked COPY writes nothing', async () => {
    const target = join(scratch, 'stacked.csv').replaceAll('\\', '/');
    const { isError } = await callTool('run_sql', {
      sql: `SELECT 1 AS "a'b"; COPY (SELECT 42) TO '${target}'; SELECT 1 LIMIT 1`,
      dateRange,
    });
    expect(isError).toBe(true);
    expect(existsSync(target)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MCP opt-in (#599): a default launch leaves the MCP port closed; Enable in
// Settings → AI Assistant starts the server, Disable stops it. The token is
// accepted only from the Authorization header.
// ---------------------------------------------------------------------------

const OPT_IN_PORT = 19632;
const OPT_IN_BASE = `http://127.0.0.1:${String(OPT_IN_PORT)}`;

/** 'listening' when /health answers, 'refused' when nothing is on the port. */
async function probeHealth(): Promise<'listening' | 'refused'> {
  try {
    const res = await fetch(`${OPT_IN_BASE}/health`);
    return res.ok ? 'listening' : 'refused';
  } catch {
    return 'refused';
  }
}

test.describe('the MCP server is opt-in', () => {
  let optApp: ElectronApplication | undefined;
  let optPage: Page;
  let scratch: string;
  let tokenFile: string;

  test.beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'costgoblin-e2e-mcp-optin-'));
    const userDataDir = join(scratch, 'userData');
    tokenFile = join(userDataDir, 'mcp-auth-token');
    optApp = await launchApp({ env: { COSTGOBLIN_USER_DATA_DIR: userDataDir, COSTGOBLIN_MCP_PORT: String(OPT_IN_PORT) } });
    optPage = await optApp.firstWindow();
    await expect(optPage).toHaveTitle('CostGoblin');
  });

  test.afterAll(async () => {
    await closeApp(optApp);
    rmSync(scratch, { recursive: true, force: true });
  });

  test('nothing listens until Enable; Disable closes the port again', async () => {
    test.setTimeout(60_000);
    // main() runs its launch-time check right after the window loads, long
    // before the settings view below is on screen.
    await navigateTo(optPage, 'AI Assistant', 'AI Assistant');
    await expect(optPage.getByText('MCP server stopped')).toBeVisible();
    expect(await probeHealth()).toBe('refused');

    await optPage.getByRole('button', { name: 'Enable', exact: true }).click();
    await expect(optPage.getByText('MCP server running')).toBeVisible({ timeout: 25_000 });
    expect(await probeHealth()).toBe('listening');

    // Header-only auth: the valid token in the query string is refused.
    const token = readFileSync(tokenFile, 'utf-8').trim();
    const viaQuery = await fetch(`${OPT_IN_BASE}/mcp?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'e2e', version: '0.0.0' } },
      }),
    });
    expect(viaQuery.status).toBe(401);

    await optPage.getByRole('button', { name: 'Disable', exact: true }).click();
    await expect(optPage.getByText('MCP server stopped')).toBeVisible({ timeout: 15_000 });
    expect(await probeHealth()).toBe('refused');
  });
});
