import { ipcMain } from 'electron';
import { asBudgetId, asDimensionId, asDollars, asEntityRef, isFiscalYearStartMonth, isStringRecord } from '@costgoblin/core';
import type { Budget, BudgetId } from '@costgoblin/core';
import { type AppContext, prefsPath } from './context.js';

function parseBudget(value: unknown): Budget | null {
  if (!isStringRecord(value)) return null;
  const { id, entity, dimension, annualAmount, fiscalYearStart, createdAt, updatedAt } = value;
  if (
    typeof id !== 'string' ||
    typeof entity !== 'string' ||
    typeof dimension !== 'string' ||
    typeof annualAmount !== 'number' ||
    typeof fiscalYearStart !== 'number' ||
    typeof createdAt !== 'string' ||
    typeof updatedAt !== 'string' ||
    !isFiscalYearStartMonth(fiscalYearStart)
  ) {
    return null;
  }
  return {
    id: asBudgetId(id),
    entity: asEntityRef(entity),
    dimension: asDimensionId(dimension),
    annualAmount: asDollars(annualAmount),
    fiscalYearStart,
    createdAt,
    updatedAt,
  };
}

export function registerBudgetsHandlers(app: AppContext): void {
  const { ctx } = app;

  const budgetsFile = () => prefsPath(ctx.dataDir, 'budgets');

  async function loadAll(): Promise<Budget[]> {
    const fs = await import('node:fs/promises');
    try {
      const raw = await fs.readFile(await budgetsFile(), 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const result: Budget[] = [];
      for (const entry of parsed) {
        const b = parseBudget(entry);
        if (b !== null) result.push(b);
      }
      return result;
    } catch {
      return [];
    }
  }

  async function writeAll(budgets: readonly Budget[]): Promise<void> {
    const fs = await import('node:fs/promises');
    await fs.writeFile(await budgetsFile(), JSON.stringify(budgets, null, 2));
  }

  ipcMain.handle('budgets:get', async (): Promise<readonly Budget[]> => loadAll());

  ipcMain.handle('budgets:save', async (_event, budget: Budget): Promise<void> => {
    const all = await loadAll();
    const idx = all.findIndex(b => b.id === budget.id);
    if (idx >= 0) {
      all[idx] = budget;
    } else {
      all.push(budget);
    }
    await writeAll(all);
  });

  ipcMain.handle('budgets:delete', async (_event, budgetId: BudgetId): Promise<void> => {
    const all = await loadAll();
    await writeAll(all.filter(b => b.id !== budgetId));
  });
}
