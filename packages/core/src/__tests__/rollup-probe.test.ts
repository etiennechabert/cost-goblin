import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGrainProbeQuery } from '../query/builder.js';
import { rollupGrainColumns } from '../rollup/grain.js';
import { computeRollupEstimate } from '../rollup/estimator.js';
import type { DimensionsConfig } from '../types/config.js';
import type { CostScopeConfig } from '../types/cost-scope.js';
import { asDimensionId } from '../types/branded.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYNTHETIC_DIR = join(__dirname, '..', '__fixtures__', 'synthetic');
const PERIOD = '2026-01';

const scope: CostScopeConfig = { costMetric: 'unblended', costPerspective: 'gross', rules: [] };

const stableGrain: DimensionsConfig = {
  builtIn: [
    { name: asDimensionId('account'), label: 'Account', field: 'account_id', displayField: 'account_name' },
    { name: asDimensionId('service'), label: 'Service', field: 'service' },
    { name: asDimensionId('region'), label: 'Region', field: 'region' },
  ],
  tags: [
    { tagName: 'team', label: 'Team', concept: 'owner' },
    { tagName: 'environment', label: 'Environment', concept: 'environment' },
  ],
};

// Same grain + the high-cardinality resource_id built-in enabled.
const resourceGrain: DimensionsConfig = {
  ...stableGrain,
  builtIn: [...stableGrain.builtIn, { name: asDimensionId('resource_id'), label: 'Resource', field: 'resource_id' }],
};

interface Row { [k: string]: unknown }

async function queryAll(conn: Awaited<ReturnType<Awaited<ReturnType<typeof DuckDBInstance.create>>['connect']>>, sql: string): Promise<Row[]> {
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

function toNum(v: unknown): number {
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'number') return v;
  return 0;
}

/** Run the probe and return line_items, grain_rows, a column→cardinality map and
 *  a column→leave-one-out-grain map (mirroring the desktop handler's card_<i> /
 *  loo_<i> decoding). */
async function probe(
  conn: Awaited<ReturnType<Awaited<ReturnType<typeof DuckDBInstance.create>>['connect']>>,
  dimensions: DimensionsConfig,
): Promise<{ lineItems: number; grainRows: number; cards: Map<string, number>; loo: Map<string, number> }> {
  const grain = rollupGrainColumns(dimensions);
  const cardCols = grain.filter(c => c !== 'usage_date');
  const sql = buildGrainProbeQuery(PERIOD, grain, { dataDir: SYNTHETIC_DIR, dimensions, costScope: scope });
  const row = (await queryAll(conn, sql))[0];
  const cards = new Map<string, number>();
  const loo = new Map<string, number>();
  cardCols.forEach((col, i) => {
    cards.set(col, toNum(row?.[`card_${String(i)}`]));
    loo.set(col, toNum(row?.[`loo_${String(i)}`]));
  });
  return { lineItems: toNum(row?.['line_items']), grainRows: toNum(row?.['grain_rows']), cards, loo };
}

function dimInputs(cards: Map<string, number>, loo: Map<string, number>): { column: string; cardinality: number; leaveOneOutGrainRows: number }[] {
  return [...cards].map(([column, cardinality]) => ({ column, cardinality, leaveOneOutGrainRows: loo.get(column) ?? 0 }));
}

describe('buildGrainProbeQuery', () => {
  let db: Awaited<ReturnType<typeof DuckDBInstance.create>>;
  let conn: Awaited<ReturnType<typeof db.connect>>;

  beforeAll(async () => {
    db = await DuckDBInstance.create();
    conn = await db.connect();
  });
  afterAll(async () => { /* in-memory db, nothing to clean */ });

  it('a stable grain aggregates well below the line-item count', async () => {
    const { lineItems, grainRows, cards, loo } = await probe(conn, stableGrain);
    expect(lineItems).toBeGreaterThan(0);
    expect(grainRows).toBeGreaterThan(0);
    // Pre-aggregation must collapse rows — the stable grain compresses raw.
    expect(grainRows).toBeLessThan(lineItems);

    const estimate = computeRollupEstimate({
      probePeriod: PERIOD, months: 1, probeGrainRows: grainRows, probeLineItems: lineItems, rawBytes: 0,
      current: null, dimCardinalities: dimInputs(cards, loo),
    });
    expect(estimate.compressionRate).toBeGreaterThan(1);
    expect(estimate.dims.find(d => d.column === 'resource_id')).toBeUndefined();
    expect(estimate.dims.every(d => !d.rawOnly)).toBe(true);
    // No single navigational dim dominates a balanced grain.
    expect(estimate.dims.every(d => !d.outlier)).toBe(true);
    expect(estimate.dims.every(d => d.marginalMultiplier >= 1)).toBe(true);
  });

  it('flags resource_id raw-only: it is near-unique per line item', async () => {
    const withResource = await probe(conn, resourceGrain);

    // resource_id is ~unique per row, so its distinct count dwarfs every other
    // dimension and approaches the line-item count — no aggregation to be had.
    const resourceCard = withResource.cards.get('resource_id') ?? 0;
    const serviceCard = withResource.cards.get('service') ?? 0;
    expect(resourceCard).toBeGreaterThan(withResource.lineItems * 0.5);
    expect(resourceCard).toBeGreaterThan(serviceCard * 10);

    const estimate = computeRollupEstimate({
      probePeriod: PERIOD, months: 1, probeGrainRows: withResource.grainRows, probeLineItems: withResource.lineItems, rawBytes: 0,
      current: null,
      dimCardinalities: dimInputs(withResource.cards, withResource.loo),
    });
    // The data-driven verdict: resource_id is raw-only, the others are not.
    expect(estimate.dims.find(d => d.column === 'resource_id')?.rawOnly).toBe(true);
    expect(estimate.dims.find(d => d.column === 'service')?.rawOnly).toBe(false);
    expect(estimate.dims.find(d => d.column === 'account_id')?.rawOnly).toBe(false);
    // The leave-one-out SQL columns flow through to valid per-dim marginals
    // (multipliers clamped ≥ 1, shares in [0,1] and summing to 1). On this tiny,
    // dense fixture the other dims already near-uniquely identify each row, so
    // resource_id's *marginal* multiplier stays modest even though its
    // *cardinality* flags it raw-only — the cardinality-vs-LOO distinction.
    const resource = estimate.dims.find(d => d.column === 'resource_id');
    expect(resource).toBeDefined();
    expect(estimate.dims.every(d => d.marginalMultiplier >= 1 && d.impactShare >= 0 && d.impactShare <= 1)).toBe(true);
    expect(estimate.dims.reduce((sum, d) => sum + d.impactShare, 0)).toBeCloseTo(1, 5);
  });
});
