import { join } from 'node:path';
import { FIXTURE_AWS_PROVIDER, type Harness } from './ipc-harness.js';

/**
 * Line items filed under another month than the one they are dated in, added
 * to a harness's copy of the synthetic tree (January and February 2026): a
 * billing period's files hold days of other months, as real exports do.
 *
 * Each has a service, a resource and a description of its own, and a cost
 * that is a different power of two, so a total names the rows it counts.
 */

export const STRAY_SERVICE = 'Stray Charges';

/** Whose line item a stray row is shaped like: one with a service code, so
 *  the fixture's marketplace attribution leaves the stray service's name. */
const TEMPLATE_SERVICE = 'Amazon Elastic Compute Cloud';

export interface StrayRow {
  /** The billing period whose directory holds the row. */
  readonly period: string;
  /** The UTC day the row is dated. */
  readonly day: string;
  readonly cost: number;
}

export const STRAY_ROWS: readonly StrayRow[] = [
  // December has no file of its own: only its neighbours hold it.
  { period: '2026-01', day: '2025-12-30', cost: 1 },
  { period: '2026-01', day: '2026-02-10', cost: 2 },
  { period: '2026-02', day: '2026-01-15', cost: 4 },
  { period: '2026-02', day: '2026-01-31', cost: 8 },
  { period: '2026-02', day: '2025-12-30', cost: 16 },
];

/** The resource id of the stray row costing `cost`. */
export function strayResource(cost: number): string {
  return `arn:test:stray-${String(cost)}`;
}

/** `day → cost` of the stray rows dated in the range, from every file. */
export function strayCostByDay(range: { readonly start: string; readonly end: string }): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of STRAY_ROWS) {
    if (row.day >= range.start && row.day <= range.end) out[row.day] = (out[row.day] ?? 0) + row.cost;
  }
  return out;
}

/** Writes `STRAY_ROWS` as a `stray.parquet` beside each month's data, shaped
 *  like one of that month's own line items. */
export async function addStrayRows(h: Harness): Promise<void> {
  await Promise.all([...new Set(STRAY_ROWS.map(r => r.period))].map((period) => {
    const dir = join(h.ws.dataDir, FIXTURE_AWS_PROVIDER, 'raw', `daily-${period}`);
    const rows = STRAY_ROWS.filter(r => r.period === period)
      .map(r => `(TIMESTAMP '${r.day} 00:00:00', ${String(r.cost)}::DOUBLE)`)
      .join(', ');
    return h.db.runQuery(`COPY (
      SELECT template.* REPLACE (
        stray.day AS ChargePeriodStart,
        '${STRAY_SERVICE}' AS ServiceName,
        'arn:test:stray-' || CAST(stray.cost AS INTEGER) AS ResourceId, 'stray ' || CAST(stray.cost AS INTEGER) AS ChargeDescription,
        stray.cost AS EffectiveCost, stray.cost AS BilledCost, stray.cost AS ListCost, stray.cost AS ContractedCost)
      FROM (SELECT * FROM read_parquet('${join(dir, 'data.parquet')}')
            WHERE ServiceName = '${TEMPLATE_SERVICE}' AND PricingCategory = 'Standard' ORDER BY ChargePeriodStart, ResourceId LIMIT 1) AS template,
           (VALUES ${rows}) AS stray(day, cost)
    ) TO '${join(dir, 'stray.parquet')}' (FORMAT PARQUET)`);
  }));
}
