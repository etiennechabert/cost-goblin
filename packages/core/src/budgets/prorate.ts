import { asDollars, type Dollars } from '../types/branded.js';
import type { Budget, BudgetProgress, FiscalYearStartMonth } from '../types/budgets.js';
import type { DateRange } from '../types/query.js';

export interface ProrateInput {
  readonly annualAmount: Dollars;
  readonly fiscalYearStart: FiscalYearStartMonth;
  readonly dateRange: DateRange;
}

export interface ProrateResult {
  readonly proratedBudget: Dollars;
  readonly elapsedFraction: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function parseUtcDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function fiscalYearWindow(rangeStart: Date, fiscalYearStart: FiscalYearStartMonth): { start: Date; end: Date } {
  const startYear = rangeStart.getUTCFullYear();
  let start = new Date(Date.UTC(startYear, fiscalYearStart - 1, 1));
  if (start.getTime() > rangeStart.getTime()) {
    start = new Date(Date.UTC(startYear - 1, fiscalYearStart - 1, 1));
  }
  const end = new Date(Date.UTC(start.getUTCFullYear() + 1, start.getUTCMonth(), start.getUTCDate()));
  return { start, end };
}

export function prorateBudget(input: ProrateInput): ProrateResult {
  const rangeStart = parseUtcDate(input.dateRange.start);
  // dateRange.end is an inclusive day — treat its "end of day" as exclusive upper bound.
  const rangeEndExclusive = parseUtcDate(input.dateRange.end).getTime() + DAY_MS;
  const fy = fiscalYearWindow(rangeStart, input.fiscalYearStart);

  const totalMs = fy.end.getTime() - fy.start.getTime();
  const elapsedEnd = Math.min(rangeEndExclusive, fy.end.getTime());
  const elapsedMs = Math.max(0, elapsedEnd - fy.start.getTime());
  const elapsedFraction = totalMs === 0 ? 0 : elapsedMs / totalMs;

  return {
    proratedBudget: asDollars(input.annualAmount * elapsedFraction),
    elapsedFraction,
  };
}

export function computeBudgetProgress(budget: Budget, actualCost: Dollars, dateRange: DateRange): BudgetProgress {
  const { proratedBudget, elapsedFraction } = prorateBudget({
    annualAmount: budget.annualAmount,
    fiscalYearStart: budget.fiscalYearStart,
    dateRange,
  });
  const percentUsed = proratedBudget > 0 ? (actualCost / proratedBudget) * 100 : 0;
  return {
    budget,
    actualCost,
    proratedBudget,
    elapsedFraction,
    percentUsed,
    isOverBudget: actualCost > proratedBudget,
    dateRange,
  };
}
