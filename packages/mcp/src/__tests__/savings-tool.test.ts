import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import { loadConfig, sqlEscapeString } from '@costgoblin/core';
import type { CostGoblinConfig } from '@costgoblin/core';
import type { McpContext } from '../context.js';
import { listSavingsRecommendations } from '../tools/savings.js';
import { fetchRows } from './helpers/duckdb-rows.js';
import { parseJsonResult, resultText } from './helpers/json-result.js';

// list_savings_recommendations over Cost Optimization Hub snapshots written
// into a temp data dir: the latest snapshot only, one option per pool and per
// resource, and the Savings view's saved preferences applied.

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(HERE, '..', '..', '..', 'core', 'src', '__fixtures__', 'config', 'costgoblin.yaml');
const PROVIDER = 'aws-main';

interface CohRow {
  readonly id: string;
  readonly action: string;
  readonly type: string;
  readonly savings: number;
  readonly cost: number;
  readonly arn?: string;
  readonly recommended?: unknown;
}

function text(value: string): string {
  return `'${sqlEscapeString(value)}'`;
}

const NULL_TEXT = 'NULL::VARCHAR';

function computeSp(term: string, paymentOption: string): unknown {
  return { computeSavingsPlans: { configuration: { accountScope: 'Payer', term, paymentOption }, costCalculation: { pricing: { monthlySavingsPlansEligibleCost: 500 } } } };
}

const VOLUME = 'arn:aws:ec2:eu-west-1:123456789012:volume/vol-1';
const OLD: readonly CohRow[] = [
  { id: 'stale-sp', action: 'PurchaseSavingsPlans', type: 'ComputeSavingsPlans', savings: 400, cost: 500, recommended: computeSp('ThreeYears', 'AllUpfront') },
];
const LATEST: readonly CohRow[] = [
  { id: 'sp-3y', action: 'PurchaseSavingsPlans', type: 'ComputeSavingsPlans', savings: 240, cost: 500, recommended: computeSp('ThreeYears', 'AllUpfront') },
  { id: 'sp-1y', action: 'PurchaseSavingsPlans', type: 'ComputeSavingsPlans', savings: 80, cost: 500, recommended: computeSp('OneYear', 'NoUpfront') },
  { id: 'vol-delete', action: 'Delete', type: 'EbsVolume', savings: 1.62, cost: 1.62, arn: VOLUME },
  { id: 'vol-upgrade', action: 'Upgrade', type: 'EbsVolume', savings: 0.4, cost: 1.62, arn: VOLUME },
  { id: 'lambda', action: 'Rightsize', type: 'LambdaFunction', savings: 0, cost: 0, arn: 'arn:aws:lambda:eu-west-1:123456789012:function:f' },
];

let root: string;
let db: DuckDBInstance;
let conn: DuckDBConnection;
let config: CostGoblinConfig;
let counter = 0;

async function writeSnapshot(dataDir: string, date: string, rows: readonly CohRow[]): Promise<void> {
  const dir = join(dataDir, PROVIDER, 'raw', `cost-opt-${date}`);
  await mkdir(dir, { recursive: true });
  const values = rows.map(r => `(${[
    text(r.id), text('123456789012'), text('Demo'), text(r.action), text(r.type), text(`${r.action} ${r.id}`),
    text('eu-west-1'), String(r.savings), String(r.cost), String(r.cost > 0 ? (r.savings / r.cost) * 100 : 0), text('Low'),
    r.arn === undefined ? NULL_TEXT : text(r.arn), NULL_TEXT, r.recommended === undefined ? NULL_TEXT : text(JSON.stringify(r.recommended)),
    NULL_TEXT, 'false', 'true', text('CostExplorer'),
  ].join(', ')})`).join(',\n');
  await conn.run(`
    COPY (SELECT * FROM (VALUES ${values}) t(
      recommendation_id, account_id, account_name, action_type, current_resource_type, recommended_resource_summary,
      region, estimated_monthly_savings_after_discount, estimated_monthly_cost_after_discount,
      estimated_savings_percentage_after_discount, implementation_effort, resource_arn, current_resource_details,
      recommended_resource_details, current_resource_summary, restart_needed, rollback_possible, recommendation_source
    )) TO ${text(join(dir, 'cost_optimization-00001.snappy.parquet'))} (FORMAT PARQUET)`);
}

const unused = (): never => { throw new Error('not used by list_savings_recommendations'); };

/** A workspace with both snapshots and, when given, a saved preferences file. */
async function workspace(prefs?: unknown): Promise<McpContext> {
  counter += 1;
  const dir = join(root, `ws-${String(counter)}`);
  const dataDir = join(dir, 'data');
  const stateDir = join(dir, 'state');
  await mkdir(stateDir, { recursive: true });
  await writeSnapshot(dataDir, '2026-10-12', OLD);
  await writeSnapshot(dataDir, '2026-10-13', LATEST);
  if (prefs !== undefined) await writeFile(join(stateDir, 'savings-preferences.json'), JSON.stringify(prefs));
  return {
    dataDir,
    stateDir,
    runQuery: (sql) => fetchRows(conn, sql),
    runPreparedQuery: unused,
    getConfig: () => Promise.resolve(config),
    getDimensions: unused,
    getQueryDimensions: unused,
    getCostScope: unused,
    getAccountMap: unused,
    getAccountReverseMap: unused,
    getOrgAccountsPath: unused,
    materializedBase: { getSource: () => undefined },
    warmup: () => Promise.resolve(),
    now: () => Date.UTC(2026, 9, 21),
  };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'cg-mcp-savings-'));
  db = await DuckDBInstance.create();
  conn = await db.connect();
  config = await loadConfig(CONFIG_PATH);
});

afterAll(async () => {
  conn.closeSync();
  db.closeSync();
  await rm(root, { recursive: true, force: true });
});

describe('list_savings_recommendations', () => {
  it('counts one option per pool and per resource from the latest snapshot', async () => {
    const result = parseJsonResult(resultText(await listSavingsRecommendations(await workspace(), { format: 'json' })));
    expect(result.title).toBe('Cost optimization recommendations (3)');
    expect(result.meta.get('Counted savings/mo')).toBeCloseTo(241.62, 6);
    expect(result.meta.get('Alternatives not counted')).toBe(2);
    expect(result.meta.get('Commitments counted at')).toBe('the highest-savings option');
    expect(result.meta.get('Snapshot')).toBe('aws-main 2026-10-13');
    expect(result.meta.get('Hidden in the Savings view')).toBe('none');
    const [table] = result.tables;
    expect(table?.rows.map(r => [r['action'], r['target'], r['option'], r['savingsPerMonth'], r['alternatives']])).toEqual([
      ['PurchaseSavingsPlans', 'Compute Savings Plans', '3-year, all upfront', 240, 1],
      ['Delete', VOLUME, '', 1.62, 1],
      ['Rightsize', 'arn:aws:lambda:eu-west-1:123456789012:function:f', '', 0, 0],
    ]);
  });

  it('applies the term and the hidden types saved in the Savings view', async () => {
    const ctx = await workspace({ hiddenActionTypes: ['Delete'], preferredCommitment: { term: 'OneYear', paymentOption: 'NoUpfront' } });
    const result = parseJsonResult(resultText(await listSavingsRecommendations(ctx, { format: 'json' })));
    // The upgrade counts once the deletion is hidden.
    expect(result.meta.get('Counted savings/mo')).toBeCloseTo(80.4, 6);
    expect(result.meta.get('Commitments counted at')).toBe('1-year, no upfront');
    expect(result.meta.get('Hidden in the Savings view')).toBe('Delete');
    expect(result.tables[0]?.rows.map(r => r['option'])).toEqual(['1-year, no upfront', '', '']);
  });

  it('filters to one action type and says when the limit cut rows', async () => {
    const ctx = await workspace();
    const filtered = parseJsonResult(resultText(await listSavingsRecommendations(ctx, { actionType: 'Delete', format: 'json' })));
    expect(filtered.title).toBe('Cost optimization recommendations (1) — Delete');
    expect(filtered.meta.get('Counted savings/mo')).toBeCloseTo(1.62, 6);

    const limited = parseJsonResult(resultText(await listSavingsRecommendations(ctx, { limit: 1, format: 'json' })));
    expect(limited.tables[0]?.rows).toHaveLength(1);
    expect(limited.notes).toContain('Showing 1 of 3 actions, highest savings first; pass a larger limit to see more.');
  });

  it('says how to get recommendations when none are synced', async () => {
    const ctx = { ...(await workspace()), dataDir: join(root, 'empty') };
    expect(resultText(await listSavingsRecommendations(ctx, {}))).toMatch(/^No Cost Optimization Hub recommendations are synced\./);
  });

  it('renders a markdown table by default', async () => {
    const text = resultText(await listSavingsRecommendations(await workspace(), {}));
    expect(text).toContain('Cost optimization recommendations (3)');
    expect(text).toMatch(/\| PurchaseSavingsPlans \| Compute Savings Plans +\| 3-year, all upfront \|/);
  });
});
