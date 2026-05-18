import type { BudgetId, DimensionId, Dollars, EntityRef } from './branded.js';
import type { DateRange } from './query.js';

export type FiscalYearStartMonth = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

export function isFiscalYearStartMonth(value: number): value is FiscalYearStartMonth {
  return Number.isInteger(value) && value >= 1 && value <= 12;
}

export interface Budget {
  readonly id: BudgetId;
  readonly entity: EntityRef;
  readonly dimension: DimensionId;
  readonly annualAmount: Dollars;
  readonly fiscalYearStart: FiscalYearStartMonth;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BudgetProgress {
  readonly budget: Budget;
  readonly actualCost: Dollars;
  readonly proratedBudget: Dollars;
  readonly elapsedFraction: number;
  readonly percentUsed: number;
  readonly isOverBudget: boolean;
  readonly dateRange: DateRange;
}
