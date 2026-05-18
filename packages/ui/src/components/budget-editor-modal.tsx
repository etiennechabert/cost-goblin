import { useState } from 'react';
import type { Budget, DimensionId, EntityRef, FiscalYearStartMonth } from '@costgoblin/core/browser';
import { asBudgetId, asDollars, asEntityRef, isFiscalYearStartMonth } from '@costgoblin/core/browser';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { Button } from './ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog.js';
import { ValuesPicker, type DropdownState } from './values-picker.js';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

interface CreateProps {
  readonly mode: 'create';
  readonly dimension: DimensionId;
  readonly dateRange: { start: string; end: string };
  readonly budgetedEntities: readonly string[];
  readonly onClose: () => void;
  readonly onSaved: () => void;
}

interface EditProps {
  readonly mode: 'edit';
  readonly budget: Budget;
  readonly onClose: () => void;
  readonly onSaved: () => void;
  readonly onDeleted: () => void;
}

export type BudgetEditorModalProps = CreateProps | EditProps;

export function BudgetEditorModal(props: Readonly<BudgetEditorModalProps>): React.JSX.Element {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) props.onClose(); }}>
      <DialogContent>
        {props.mode === 'edit'
          ? <EditForm {...props} />
          : <CreateForm {...props} />
        }
      </DialogContent>
    </Dialog>
  );
}

function CreateForm({ dimension, dateRange, budgetedEntities, onClose, onSaved }: Readonly<CreateProps>): React.JSX.Element {
  const api = useCostApi();
  const [entity, setEntity] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [fiscalMonth, setFiscalMonth] = useState<FiscalYearStartMonth>(1);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filterValuesQuery = useQuery(
    () => api.getFilterValues(dimension, {}, dateRange),
    [dimension, dateRange.start, dateRange.end],
  );

  const dropdown: DropdownState = filterValuesQuery.status === 'loading' || filterValuesQuery.status === 'idle'
    ? { status: 'loading', dimId: dimension }
    : filterValuesQuery.status === 'error'
      ? { status: 'error', dimId: dimension, message: filterValuesQuery.error.message }
      : { status: 'ready', dimId: dimension, values: filterValuesQuery.data.map(v => ({ value: v.value, label: v.label, cost: v.count, rows: v.count })) };

  const parsedAmount = Number(amount);
  const canSave = entity !== null && Number.isFinite(parsedAmount) && parsedAmount > 0;

  function handleSave(): void {
    if (entity === null || !canSave) return;
    setSaving(true);
    setError(null);
    const now = new Date().toISOString();
    const budget: Budget = {
      id: asBudgetId(`budget-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`),
      entity: asEntityRef(entity),
      dimension,
      annualAmount: asDollars(parsedAmount),
      fiscalYearStart: fiscalMonth,
      createdAt: now,
      updatedAt: now,
    };
    api.saveBudget(budget)
      .then(onSaved)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setSaving(false);
      });
  }

  return (
    <>
      <DialogTitle>Add Budget</DialogTitle>
      <DialogDescription>Track annual spending for one entity.</DialogDescription>

      <div className="mt-4 flex flex-col gap-4">
        <div>
          <label className="block text-xs text-text-secondary mb-1">Entity</label>
          <div className="relative">
            <button
              type="button"
              onClick={() => { setPickerOpen(o => !o); }}
              className="w-full text-left rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary hover:border-accent"
            >
              {entity ?? 'Select an entity…'}
            </button>
            {pickerOpen && (
              <ValuesPicker
                dropdown={dropdown}
                mode={{
                  kind: 'single',
                  selected: entity,
                  onSelect: (value) => { setEntity(value); },
                }}
                onClose={() => { setPickerOpen(false); }}
                excludeValues={budgetedEntities}
                placeholder="Search entities…"
              />
            )}
          </div>
        </div>

        <AmountInput amount={amount} onChange={setAmount} />
        <FiscalMonthSelect value={fiscalMonth} onChange={setFiscalMonth} />
      </div>

      {error !== null && (
        <p className="mt-4 text-xs text-negative">Failed to save: {error}</p>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
        <Button size="sm" onClick={handleSave} disabled={!canSave || saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </>
  );
}

function EditForm({ budget, onClose, onSaved, onDeleted }: Readonly<EditProps>): React.JSX.Element {
  const api = useCostApi();
  const [amount, setAmount] = useState(String(budget.annualAmount));
  const [fiscalMonth, setFiscalMonth] = useState<FiscalYearStartMonth>(budget.fiscalYearStart);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsedAmount = Number(amount);
  const canSave = Number.isFinite(parsedAmount) && parsedAmount > 0;

  function handleSave(): void {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    const updated: Budget = {
      ...budget,
      annualAmount: asDollars(parsedAmount),
      fiscalYearStart: fiscalMonth,
      updatedAt: new Date().toISOString(),
    };
    api.saveBudget(updated)
      .then(onSaved)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setSaving(false);
      });
  }

  function handleDelete(): void {
    setDeleting(true);
    setError(null);
    api.deleteBudget(budget.id)
      .then(onDeleted)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setDeleting(false);
      });
  }

  return (
    <>
      <DialogTitle>Edit Budget</DialogTitle>
      <DialogDescription>{toEntityLabel(budget.entity)}</DialogDescription>

      <div className="mt-4 flex flex-col gap-4">
        <AmountInput amount={amount} onChange={setAmount} />
        <FiscalMonthSelect value={fiscalMonth} onChange={setFiscalMonth} />
      </div>

      {error !== null && (
        <p className="mt-4 text-xs text-negative">{error}</p>
      )}

      <div className="mt-5 flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={handleDelete} disabled={deleting || saving}>
          {deleting ? 'Deleting…' : 'Delete'}
        </Button>
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
        <Button size="sm" onClick={handleSave} disabled={!canSave || saving || deleting}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </>
  );
}

function toEntityLabel(entity: EntityRef): string {
  return entity;
}

function AmountInput({ amount, onChange }: Readonly<{ amount: string; onChange: (next: string) => void }>): React.JSX.Element {
  return (
    <div>
      <label className="block text-xs text-text-secondary mb-1" htmlFor="budget-amount">Annual budget ($)</label>
      <input
        id="budget-amount"
        type="number"
        value={amount}
        onChange={(e) => { onChange(e.target.value); }}
        min="0"
        step="1000"
        placeholder="500000"
        className="w-full rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
      />
    </div>
  );
}

function FiscalMonthSelect({ value, onChange }: Readonly<{ value: FiscalYearStartMonth; onChange: (next: FiscalYearStartMonth) => void }>): React.JSX.Element {
  return (
    <div>
      <label className="block text-xs text-text-secondary mb-1" htmlFor="budget-fiscal">Fiscal year starts</label>
      <select
        id="budget-fiscal"
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (isFiscalYearStartMonth(n)) onChange(n);
        }}
        className="w-full rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
      >
        {MONTHS.map((m, i) => (
          <option key={m} value={i + 1}>{m}</option>
        ))}
      </select>
    </div>
  );
}

