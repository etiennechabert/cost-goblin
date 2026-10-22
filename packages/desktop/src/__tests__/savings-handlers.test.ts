import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sqlEscapeString } from '@costgoblin/core';
import { registerQueryHandlers } from '../main/handlers/query.js';
import { at, createHarness, FIXTURE_AWS_PROVIDER, list, num, str, type Harness } from './helpers/ipc-harness.js';

/** query:savings over Cost Optimization Hub snapshots written into a fresh
 *  workspace: which snapshot is read, and what the deduplicated total counts.
 *  The rows use the column names and details JSON of a real COH export. */

vi.mock('electron', async () => (await import('./helpers/electron-fake.js')).fakeElectronModule);
vi.mock('@sentry/electron/main', async () => (await import('./helpers/electron-fake.js')).fakeSentryModule);

const harnesses: Harness[] = [];

afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.dispose();
});

async function savingsApp(): Promise<Harness> {
  const h = await createHarness({ data: 'none' });
  registerQueryHandlers(h.app);
  harnesses.push(h);
  return h;
}

interface CohRow {
  readonly id: string;
  readonly action: string;
  readonly type: string;
  readonly savings: number;
  readonly cost: number;
  readonly arn?: string;
  readonly recommended?: unknown;
}

/** A typed NULL: the export declares these columns VARCHAR even when a file
 *  has no value in them, and an untyped all-NULL column would be INTEGER. */
const NULL_TEXT = 'NULL::VARCHAR';

function sqlText(value: string): string {
  return `'${sqlEscapeString(value)}'`;
}

/** One COH export file at raw/cost-opt-<date>/. */
async function writeSnapshot(h: Harness, dirName: string, rows: readonly CohRow[]): Promise<void> {
  const dir = join(h.ws.dataDir, FIXTURE_AWS_PROVIDER, 'raw', dirName);
  await mkdir(dir, { recursive: true });
  const values = rows.map(r => `(${[
    sqlText(r.id), sqlText('123456789012'), sqlText('Demo'), sqlText(r.action), sqlText(r.type), sqlText(`${r.action} ${r.id}`),
    sqlText('eu-west-1'), String(r.savings), String(r.cost), String(r.cost > 0 ? (r.savings / r.cost) * 100 : 0), sqlText('VeryLow'),
    r.arn === undefined ? NULL_TEXT : sqlText(r.arn), NULL_TEXT, r.recommended === undefined ? NULL_TEXT : sqlText(JSON.stringify(r.recommended)),
    NULL_TEXT, 'false', 'true', sqlText('CostExplorer'),
  ].join(', ')})`).join(',\n');
  await h.db.runQuery(`
    COPY (SELECT * FROM (VALUES ${values}) t(
      recommendation_id, account_id, account_name, action_type, current_resource_type, recommended_resource_summary,
      region, estimated_monthly_savings_after_discount, estimated_monthly_cost_after_discount,
      estimated_savings_percentage_after_discount, implementation_effort, resource_arn, current_resource_details,
      recommended_resource_details, current_resource_summary, restart_needed, rollback_possible, recommendation_source
    )) TO ${sqlText(join(dir, 'cost_optimization-00001.snappy.parquet'))} (FORMAT PARQUET)`);
}

function computeSp(term: string, paymentOption: string): unknown {
  return {
    computeSavingsPlans: {
      configuration: { accountScope: 'Payer', term, paymentOption, hourlyCommitment: '0.382' },
      costCalculation: { pricing: { monthlySavingsPlansEligibleCost: 529.36 } },
    },
  };
}

function ec2Ri(term: string, paymentOption: string): unknown {
  return {
    ec2ReservedInstances: {
      configuration: {
        accountScope: 'Payer', term, paymentOption, offeringClass: 'Standard', reservedInstancesRegion: 'eu-west-1',
        instanceFamily: 't2', instanceType: 't2.nano', platform: 'Linux/UNIX', tenancy: 'Shared', sizeFlexEligible: true,
      },
      costCalculation: { pricing: { monthlyReservationEligibleCost: 154.41 } },
    },
  };
}

const VOLUME = 'arn:aws:ec2:eu-west-1:123456789012:volume/vol-1';

const OCT_12: readonly CohRow[] = [
  { id: 'sp-3y', action: 'PurchaseSavingsPlans', type: 'ComputeSavingsPlans', savings: 240, cost: 529.36, recommended: computeSp('ThreeYears', 'AllUpfront') },
  { id: 'ri-1y', action: 'PurchaseReservedInstances', type: 'Ec2ReservedInstances', savings: 44.25, cost: 154.41, recommended: ec2Ri('OneYear', 'NoUpfront') },
  // Implemented on Oct 12: gone from the next export.
  { id: 'ri-3y-old', action: 'PurchaseReservedInstances', type: 'Ec2ReservedInstances', savings: 83.03, cost: 154.41, recommended: ec2Ri('ThreeYears', 'AllUpfront') },
  { id: 'vol-delete', action: 'Delete', type: 'EbsVolume', savings: 1.62, cost: 1.62, arn: VOLUME },
];

const OCT_13: readonly CohRow[] = [
  { id: 'sp-3y', action: 'PurchaseSavingsPlans', type: 'ComputeSavingsPlans', savings: 244.32, cost: 529.36, recommended: computeSp('ThreeYears', 'AllUpfront') },
  { id: 'sp-1y', action: 'PurchaseSavingsPlans', type: 'ComputeSavingsPlans', savings: 80.93, cost: 529.36, recommended: computeSp('OneYear', 'NoUpfront') },
  { id: 'ri-1y', action: 'PurchaseReservedInstances', type: 'Ec2ReservedInstances', savings: 44.25, cost: 154.41, recommended: ec2Ri('OneYear', 'NoUpfront') },
  { id: 'vol-delete', action: 'Delete', type: 'EbsVolume', savings: 1.62, cost: 1.62, arn: VOLUME },
  { id: 'vol-upgrade', action: 'Upgrade', type: 'EbsVolume', savings: 0.4, cost: 1.62, arn: VOLUME },
];

function ids(result: unknown): string[] {
  return list(at(result, 'recommendations')).map(r => str(at(r, 'recommendationId'))).sort();
}

describe('query:savings', () => {
  it('reads only the latest snapshot: a recommendation missing from it is gone', async () => {
    const h = await savingsApp();
    await writeSnapshot(h, 'cost-opt-2026-10-12', OCT_12);
    await writeSnapshot(h, 'cost-opt-2026-10-13', OCT_13);

    const result = await h.ipc.invoke('query:savings');
    expect(ids(result)).toEqual(['ri-1y', 'sp-1y', 'sp-3y', 'vol-delete', 'vol-upgrade']);
    expect(at(result, 'snapshots')).toEqual([{ providerName: FIXTURE_AWS_PROVIDER, date: '2026-10-13' }]);
    // The newest values win too.
    const plan = list(at(result, 'recommendations')).find(r => at(r, 'recommendationId') === 'sp-3y');
    expect(num(at(plan, 'monthlySavings'))).toBe(244.32);
  });

  it('counts one option per commitment pool and one action per resource', async () => {
    const h = await savingsApp();
    await writeSnapshot(h, 'cost-opt-2026-10-13', OCT_13);
    const result = await h.ipc.invoke('query:savings');
    // The 3-year plan (the EC2 RI is covered by it), and the deletion of the
    // volume rather than its upgrade. Listed: $371.52.
    expect(num(at(result, 'totalMonthlySavings'))).toBeCloseTo(244.32 + 1.62, 6);
    const pool = list(at(result, 'recommendations')).find(r => at(r, 'recommendationId') === 'ri-1y');
    expect(at(at(pool, 'commitment'), 'poolLabel')).toBe('EC2 Reserved Instances · t2 · eu-west-1 · Linux/UNIX');
  });

  it('skips a newer directory with no Parquet in it and names that are not snapshot dates', async () => {
    const h = await savingsApp();
    await writeSnapshot(h, 'cost-opt-2026-10-12', OCT_12);
    const raw = join(h.ws.dataDir, FIXTURE_AWS_PROVIDER, 'raw');
    await mkdir(join(raw, 'cost-opt-2026-10-13'), { recursive: true });
    await writeFile(join(raw, 'cost-opt-2026-10-13', '.sync-in-progress'), '');
    await writeSnapshot(h, 'cost-opt-latest', OCT_13);

    const result = await h.ipc.invoke('query:savings');
    expect(at(result, 'snapshots')).toEqual([{ providerName: FIXTURE_AWS_PROVIDER, date: '2026-10-12' }]);
    expect(ids(result)).toEqual(['ri-1y', 'ri-3y-old', 'sp-3y', 'vol-delete']);
  });

  it('reads a snapshot synced into a month directory by older versions', async () => {
    const h = await savingsApp();
    await writeSnapshot(h, 'cost-opt-2026-02', OCT_12);
    expect(at(await h.ipc.invoke('query:savings'), 'snapshots')).toEqual([{ providerName: FIXTURE_AWS_PROVIDER, date: '2026-02' }]);
  });

  it('is empty, not failed, when the latest snapshot cannot be read', async () => {
    const h = await savingsApp();
    const dir = join(h.ws.dataDir, FIXTURE_AWS_PROVIDER, 'raw', 'cost-opt-2026-10-13');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'broken.parquet'), 'not parquet');
    expect(await h.ipc.invoke('query:savings')).toEqual({ recommendations: [], totalMonthlySavings: 0, snapshots: [] });
  });
});
