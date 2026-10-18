import { asDateString, asDollars } from '@costgoblin/core/browser';
import type { BaselineDailyPoint, BaselineDetail, BaselineRecord, BaselineSnapshot, BaselineSpec } from '@costgoblin/core/browser';

/** Shared builders for the baseline view and detail-modal tests. */

export function baselineSpec(overrides: Partial<BaselineSpec> = {}): BaselineSpec {
  return {
    id: 'b-1',
    source: 'discovered',
    scope: { kind: 'filter', filters: {} },
    basis: { costMetric: 'effective', rules: [] },
    basisSnapshotAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** A record whose current run-rate ($25/day) sits above its $10–$20 band. */
export function baselineRecord(overrides: Partial<BaselineRecord> = {}): BaselineRecord {
  return {
    spec: baselineSpec(),
    stats: null,
    current: null,
    savings: { potentialDaily: asDollars(0), realizedDaily: asDollars(0), potentialMonthly: asDollars(0), realizedMonthly: asDollars(0) },
    status: 'over',
    triageStatus: 'new',
    effectiveLower: asDollars(10),
    effectiveUpper: asDollars(20),
    currentDaily: asDollars(25),
    potentialDaily: asDollars(0),
    realizedDaily: asDollars(0),
    bestAchieved: null,
    scopeLabel: 'Amazon RDS',
    triage: { notes: [] },
    ...overrides,
  };
}

/** Consecutive daily points starting at `start` (YYYY-MM-DD, UTC). */
export function dailySeries(start: string, costs: readonly number[]): BaselineDailyPoint[] {
  const day = new Date(`${start}T00:00:00Z`);
  return costs.map((cost) => {
    const date = asDateString(day.toISOString().slice(0, 10));
    day.setUTCDate(day.getUTCDate() + 1);
    return { date, cost: asDollars(cost) };
  });
}

export function point(date: string, cost: number): BaselineDailyPoint {
  return { date: asDateString(date), cost: asDollars(cost) };
}

export function baselineDetail(
  record: BaselineRecord,
  dailyHistory: readonly BaselineDailyPoint[] = dailySeries('2026-01-01', [10, 20, 30, 40, 50]),
  windowDays = 1,
  snapshots: readonly BaselineSnapshot[] = [],
): BaselineDetail {
  return { record, dailyHistory, snapshots, windowDays };
}

export function snapshot(date: string, current: number): BaselineSnapshot {
  return {
    date: asDateString(date),
    lower: asDollars(10),
    upper: asDollars(20),
    current: asDollars(current),
    potential: asDollars(0),
    realized: asDollars(0),
    status: 'over',
  };
}
