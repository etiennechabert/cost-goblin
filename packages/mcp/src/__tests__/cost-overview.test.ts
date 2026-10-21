import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSource, loadConfig, loadCostScope, loadDimensions } from '@costgoblin/core';
import type { McpContext, RawRow } from '../context.js';
import { formatDollars } from '../formatters/cost.js';
import { getCostOverview } from '../tools/get-cost-overview.js';
import { fetchRows, fetchRowsPrepared } from './helpers/duckdb-rows.js';
import { parseJsonResult, resultText } from './helpers/json-result.js';
import type { JsonResult, JsonTable } from './helpers/json-result.js';

// get_cost_overview's figures over the synthetic fixtures, checked against
// plain SUMs over the same normalized source. The overview reads
// buildCostQuery, which returns one row per (entity, top service) and repeats
// the entity's total on each of them.

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, '..', '..', '..', 'core', 'src', '__fixtures__');
const SYNTHETIC_DIR = join(FIXTURES_DIR, 'synthetic');
const CONFIG_DIR = join(FIXTURES_DIR, 'config');

const JAN = { start: '2026-01-01', end: '2026-01-31' };

// Two accounts share a display name, as org data can (a rename, a name-strip
// pattern); the others are shown by id.
const ACCOUNT_NAMES: ReadonlyMap<string, string> = new Map([
  ['100000000000', 'Acme Corp Main'],
  ['100000000001', 'Production'],
  ['100000000002', 'Production'],
]);

interface Named {
  readonly name: string;
  readonly cost: number;
}

function toNamed(rows: readonly RawRow[], key: string): Named[] {
  return rows.map((r): Named => {
    const name = r[key];
    const cost = r['cost'];
    if (typeof name !== 'string' || typeof cost !== 'number') throw new Error(`unexpected oracle row ${JSON.stringify(r)}`);
    return { name, cost };
  });
}

function sum(rows: readonly Named[]): number {
  return rows.reduce((total, r) => total + r.cost, 0);
}

function tableOf(result: JsonResult, title: string): JsonTable {
  const table = result.tables.find(t => t.title === title);
  if (table === undefined) throw new Error(`no table "${title}"; have ${JSON.stringify(result.tables.map(t => t.title))}`);
  return table;
}

/** The footer of a table listing all but `hidden`. */
function hiddenFooter(hidden: readonly number[]): string {
  return `*...and ${String(hidden.length)} more totaling ${formatDollars(hidden.reduce((a, b) => a + b, 0))}*`;
}

function num(v: unknown): number {
  if (typeof v !== 'number') throw new Error(`not a number: ${JSON.stringify(v)}`);
  return v;
}

describe('get_cost_overview over the synthetic fixtures', () => {
  let db: DuckDBInstance;
  let conn: DuckDBConnection;
  let ctx: McpContext;
  /** The overview's normalized source, for the oracle SUMs. */
  let source: string;

  beforeAll(async () => {
    db = await DuckDBInstance.create();
    conn = await db.connect();

    const config = await loadConfig(join(CONFIG_DIR, 'costgoblin.yaml'));
    const dimensions = await loadDimensions(join(CONFIG_DIR, 'dimensions.yaml'));
    const costScope = await loadCostScope(join(CONFIG_DIR, 'cost-scope.yaml'));
    // The fixture's exclusion rules are all off, so the oracle needs none.
    expect(costScope.rules.filter(r => r.enabled)).toEqual([]);
    source = buildSource({
      dataDir: SYNTHETIC_DIR,
      tier: 'daily',
      dimensions,
      providers: config.providers.map(p => ({ name: p.name, type: p.type })),
      costMetric: costScope.costMetric,
      marketplaceAttribution: costScope.marketplaceAttribution,
    });

    ctx = {
      dataDir: SYNTHETIC_DIR,
      stateDir: FIXTURES_DIR,
      runQuery: (sql) => fetchRows(conn, sql),
      runPreparedQuery: (sql, params) => fetchRowsPrepared(conn, sql, params),
      getConfig: () => Promise.resolve(config),
      getDimensions: () => Promise.resolve(dimensions),
      getQueryDimensions: () => Promise.resolve(dimensions),
      getCostScope: () => Promise.resolve(costScope),
      getAccountMap: () => Promise.resolve(new Map(ACCOUNT_NAMES)),
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

  async function overview(): Promise<JsonResult> {
    return parseJsonResult(resultText(await getCostOverview(ctx, { dateRange: JAN, format: 'json' })));
  }

  /** Each `key`'s January cost, largest first. */
  async function janCostBy(key: 'service' | 'account_id'): Promise<Named[]> {
    const rows = await fetchRowsPrepared(conn, `
      SELECT ${key}, SUM(cost) AS cost FROM ${source}
      WHERE usage_date BETWEEN $1 AND $2
      GROUP BY ${key}
      ORDER BY cost DESC
    `, [JAN.start, JAN.end]);
    return toNamed(rows, key);
  }

  it('totals every service, not only the ten it lists, and takes each share of that total', async () => {
    const services = await janCostBy('service');
    // Services past the top ten carry cost in this window.
    expect(services.length).toBeGreaterThan(10);
    const total = sum(services);
    expect(total - sum(services.slice(0, 10))).toBeGreaterThan(1);

    const result = await overview();

    expect(num(result.meta.get('Total Cost'))).toBeCloseTo(total, 4);
    const table = tableOf(result, 'Top Services');
    expect(table.rows.map(r => r['service'])).toEqual(services.slice(0, 10).map(s => s.name));
    table.rows.forEach((row, i) => {
      const expected = services[i]?.cost ?? Number.NaN;
      expect(num(row['cost'])).toBeCloseTo(expected, 4);
      expect(num(row['pct'])).toBeCloseTo((expected / total) * 100, 4);
    });
    expect(table.footer).toBe(hiddenFooter(services.slice(10).map(s => s.cost)));
  });

  it("gives each account the sum of its services' cost, merging accounts that share a name", async () => {
    // Per account, the sum over its services: the oracle groups by service first.
    const rows = await fetchRowsPrepared(conn, `
      SELECT account_id, SUM(service_cost) AS cost FROM (
        SELECT account_id, service, SUM(cost) AS service_cost FROM ${source}
        WHERE usage_date BETWEEN $1 AND $2
        GROUP BY account_id, service
      )
      GROUP BY account_id
    `, [JAN.start, JAN.end]);
    const byName = new Map<string, number>();
    for (const { name: id, cost } of toNamed(rows, 'account_id')) {
      const name = ACCOUNT_NAMES.get(id) ?? id;
      byName.set(name, (byName.get(name) ?? 0) + cost);
    }
    const ranked = [...byName.entries()].sort((a, b) => b[1] - a[1]);
    const expected = ranked.slice(0, 5);
    // The shared name is the merged pair, not either account alone.
    const accounts = await janCostBy('account_id');
    const pair = accounts.filter(a => ACCOUNT_NAMES.get(a.name) === 'Production');
    expect(pair).toHaveLength(2);
    expect(byName.get('Production')).toBeCloseTo(sum(pair), 4);

    const table = tableOf(await overview(), 'Top Accounts');

    expect(table.rows.map(r => r['account'])).toEqual(expected.map(([name]) => name));
    table.rows.forEach((row, i) => {
      expect(num(row['cost'])).toBeCloseTo(expected[i]?.[1] ?? Number.NaN, 4);
    });
    // Eight accounts under seven names: two names past the top five.
    expect(ranked).toHaveLength(7);
    expect(table.footer).toBe(hiddenFooter(ranked.slice(5).map(([, cost]) => cost)));
  });
});
