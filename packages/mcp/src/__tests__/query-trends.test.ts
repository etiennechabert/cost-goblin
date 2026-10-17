import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadCostScope, loadDimensions } from '@costgoblin/core';
import type { McpContext } from '../context.js';
import { queryTrends } from '../tools/query-trends.js';
import { fetchRows, fetchRowsPrepared } from './helpers/duckdb-rows.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, '..', '..', '..', 'core', 'src', '__fixtures__');
const SYNTHETIC_DIR = join(FIXTURES_DIR, 'synthetic');
const CONFIG_DIR = join(FIXTURES_DIR, 'config');

// The monthly Tax charge and EC2 credit land on the 1st, so over 1–2 Feb
// neither has any cost in the previous period (30–31 Jan).
const NEW_SPEND_WINDOW = { start: '2026-02-01', end: '2026-02-02' };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

interface TrendLine {
  readonly entity: unknown;
  readonly current: unknown;
  readonly previous: unknown;
  readonly delta: unknown;
  readonly change: unknown;
}

interface TrendResponse {
  readonly increases: readonly TrendLine[];
  readonly savings: readonly TrendLine[];
  readonly notes: readonly string[];
}

/** The rows of the format=json table whose title starts with `prefix`. */
function tableRows(tables: readonly unknown[], prefix: string): TrendLine[] {
  const table = tables.find(t => isRecord(t) && typeof t['title'] === 'string' && t['title'].startsWith(prefix));
  if (!isRecord(table)) return [];
  const rows = table['rows'];
  if (!Array.isArray(rows)) throw new Error(`${prefix} table has no rows`);
  return rows.map((r: unknown): TrendLine => {
    if (!Array.isArray(r)) throw new Error('row is not an array');
    const cells: unknown[] = r;
    return { entity: cells[0], current: cells[1], previous: cells[2], delta: cells[3], change: cells[4] };
  });
}

function parseTrends(text: string): TrendResponse {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error('response is not an object');
  const tables = Array.isArray(parsed['tables']) ? parsed['tables'] : [];
  const notesField = parsed['notes'];
  const notes = Array.isArray(notesField)
    ? notesField.filter((n: unknown): n is string => typeof n === 'string')
    : [];
  return { increases: tableRows(tables, 'Top Increases'), savings: tableRows(tables, 'Top Savings'), notes };
}

function line(lines: readonly TrendLine[], entity: string): TrendLine | undefined {
  return lines.find(l => l.entity === entity);
}

describe('query_trends', () => {
  let db: DuckDBInstance;
  let conn: DuckDBConnection;
  let ctx: McpContext;

  beforeAll(async () => {
    db = await DuckDBInstance.create();
    conn = await db.connect();

    const config = await loadConfig(join(CONFIG_DIR, 'costgoblin.yaml'));
    const dimensions = await loadDimensions(join(CONFIG_DIR, 'dimensions.yaml'));
    const costScope = await loadCostScope(join(CONFIG_DIR, 'cost-scope.yaml'));

    ctx = {
      dataDir: SYNTHETIC_DIR,
      stateDir: FIXTURES_DIR,
      runQuery: (sql) => fetchRows(conn, sql),
      runPreparedQuery: (sql, params) => fetchRowsPrepared(conn, sql, params),
      getConfig: () => Promise.resolve(config),
      getDimensions: () => Promise.resolve(dimensions),
      getQueryDimensions: () => Promise.resolve(dimensions),
      getCostScope: () => Promise.resolve(costScope),
      getAccountMap: () => Promise.resolve(new Map<string, string>()),
      getAccountReverseMap: () => Promise.resolve(new Map<string, readonly string[]>()),
      getOrgAccountsPath: () => Promise.resolve(undefined),
      materializedBase: { getSource: () => undefined },
      warmup: () => Promise.resolve(),
      now: () => Date.UTC(2026, 2, 2, 12),
    };
  });

  afterAll(() => {
    conn.disconnectSync();
    db.closeSync();
  });

  async function trends(params: Partial<Parameters<typeof queryTrends>[1]>): Promise<TrendResponse> {
    const result = await queryTrends(ctx, { groupBy: 'service', dateRange: NEW_SPEND_WINDOW, format: 'json', ...params });
    return parseTrends(result.content[0].text);
  }

  it('reports spend that is new this period at the default thresholds', async () => {
    const { increases, savings } = await trends({});

    // Tax is the largest change of the window, all of it new.
    expect(increases[0]).toEqual({ entity: 'Tax', current: 250, previous: 0, delta: 250, change: 100 });
    const cloudTrail = line(increases, 'AWS CloudTrail');
    expect(cloudTrail?.previous).toBe(0);
    expect(cloudTrail?.change).toBe(100);

    // An entity WITH previous spend is still held to the 5% default: EC2 moved
    // -1.4%, above the $1 delta but below the percent threshold.
    expect(line([...increases, ...savings], 'Amazon Elastic Compute Cloud')).toBeUndefined();
  });

  it('reports a credit that is new this period as a saving of -100%', async () => {
    const { increases, savings } = await trends({ groupBy: 'charge_category' });
    expect(line(savings, 'Credit')).toEqual({ entity: 'Credit', current: -75, previous: 0, delta: -75, change: -100 });
    expect(line(increases, 'Tax')?.change).toBe(100);
  });

  it('keeps new spend above any percent threshold, still applying it to everything else', async () => {
    const { increases, savings, notes } = await trends({ percentThreshold: 500 });
    // ECR grew +1903% and clears 500%; SQS (+189%) and RDS (+57%) do not.
    expect(increases.map(l => l.entity)).toEqual(['Tax', 'Amazon EC2 Container Registry', 'AWS CloudTrail']);
    expect(savings).toEqual([]);
    expect(notes).toContain('*No significant savings found.*');
  });

  it('still holds new spend to the delta threshold', async () => {
    const { increases } = await trends({ deltaThreshold: 2 });
    // AWS CloudTrail's $1.08 is all new, but under $2.
    expect(line(increases, 'Tax')?.change).toBe(100);
    expect(line(increases, 'AWS CloudTrail')).toBeUndefined();
  });

  it('explains the ±100% only when a reported entity is new', async () => {
    const withNew = await trends({});
    expect(withNew.notes.some(n => /previous period had no cost/.test(n))).toBe(true);

    // Mid-January to mid-February: the Tax and Credit lines fall in both
    // periods, so nothing reported is new.
    const withoutNew = await trends({ groupBy: 'charge_category', dateRange: { start: '2026-01-15', end: '2026-02-14' } });
    expect(withoutNew.increases.map(l => l.entity)).toEqual(['Usage']);
    expect(withoutNew.notes.some(n => /previous period had no cost/.test(n))).toBe(false);
  });
});
