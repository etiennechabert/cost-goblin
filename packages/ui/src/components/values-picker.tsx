import { useEffect, useState } from 'react';
import type { ExplorerFilterValue } from '@costgoblin/core/browser';
import { formatDollars } from './format.js';

export type DropdownState =
  | { status: 'closed' }
  | { status: 'loading'; dimId: string }
  | { status: 'ready'; dimId: string; values: readonly ExplorerFilterValue[] }
  | { status: 'error'; dimId: string; message: string };

export type ValuesPickerMode =
  | { kind: 'multi'; selected: readonly string[]; onApply: (next: readonly string[]) => void }
  | { kind: 'single'; selected: string | null; onSelect: (value: string) => void };

interface ValuesPickerProps {
  readonly dropdown: DropdownState;
  readonly mode: ValuesPickerMode;
  readonly onClose: () => void;
  readonly excludeValues?: readonly string[] | undefined;
  readonly placeholder?: string | undefined;
}

export function ValuesPicker({ dropdown, mode, onClose, excludeValues, placeholder }: ValuesPickerProps): React.JSX.Element {
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<readonly string[]>(mode.kind === 'multi' ? mode.selected : []);

  // Reset draft when the multi-mode selection changes (e.g., user re-opens a different dim).
  useEffect(() => {
    if (mode.kind === 'multi') {
      setDraft(mode.selected);
    }
    setSearch('');
  }, [mode.kind === 'multi' ? mode.selected : null, mode.kind]);

  function toggle(value: string): void {
    if (mode.kind === 'multi') {
      setDraft(prev => prev.includes(value) ? prev.filter(v => v !== value) : [...prev, value]);
    } else {
      mode.onSelect(value);
      onClose();
    }
  }

  function apply(): void {
    if (mode.kind === 'multi') {
      mode.onApply(draft);
      onClose();
    }
  }

  function clear(): void {
    setDraft([]);
  }

  const excludeSet = new Set(excludeValues ?? []);

  const filteredValues = dropdown.status === 'ready'
    ? dropdown.values.filter(v =>
        !excludeSet.has(v.value)
        && (search.length === 0 || v.label.toLowerCase().includes(search.toLowerCase())),
      )
    : [];

  return (
    <div className="absolute left-0 top-full z-50 mt-1 w-72 rounded-lg border border-border bg-bg-secondary shadow-lg">
      <div className="border-b border-border p-2">
        <input
          autoFocus
          type="text"
          value={search}
          placeholder={placeholder ?? 'Search values…'}
          onChange={(e) => { setSearch(e.target.value); }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'Enter' && mode.kind === 'multi') apply();
          }}
          className="w-full rounded border border-border bg-bg-primary px-2 py-1 text-xs text-text-primary outline-none focus:border-accent"
        />
      </div>
      <div className="max-h-64 overflow-y-auto">
        {dropdown.status === 'loading' && (
          <div className="flex items-center justify-center gap-2 py-6 text-xs text-text-muted">
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-border border-t-accent" />
            <span>Loading…</span>
          </div>
        )}
        {dropdown.status === 'error' && (
          <div className="px-3 py-4 text-xs text-negative">Failed to load: {dropdown.message}</div>
        )}
        {dropdown.status === 'ready' && filteredValues.length === 0 && (
          <div className="px-3 py-4 text-xs text-text-muted">No matching values.</div>
        )}
        {dropdown.status === 'ready' && filteredValues.map(v => {
          const checked = mode.kind === 'multi' ? draft.includes(v.value) : mode.selected === v.value;
          return (
            <label
              key={v.value}
              className={[
                'flex items-center justify-between gap-2 px-3 py-1.5 text-xs cursor-pointer select-none',
                checked ? 'bg-accent-muted/50 text-text-primary' : 'text-text-secondary hover:bg-bg-tertiary',
              ].join(' ')}
            >
              <span className="flex items-center gap-2 min-w-0 flex-1">
                {mode.kind === 'multi' && (
                  <input
                    type="checkbox"
                    className="accent-accent shrink-0"
                    checked={checked}
                    onChange={() => { toggle(v.value); }}
                  />
                )}
                {mode.kind === 'single' && (
                  <input
                    type="radio"
                    className="accent-accent shrink-0"
                    checked={checked}
                    onChange={() => { toggle(v.value); }}
                  />
                )}
                <span className="truncate">{v.label}</span>
              </span>
              <span className="shrink-0 text-text-muted tabular-nums">{formatDollars(v.cost)}</span>
            </label>
          );
        })}
      </div>
      {mode.kind === 'multi' && (
        <div className="flex items-center justify-between border-t border-border p-2 gap-2">
          <button
            type="button"
            onClick={clear}
            className="text-xs text-text-secondary hover:text-text-primary"
            disabled={draft.length === 0}
          >
            Clear
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-2 py-1 text-xs text-text-secondary hover:bg-bg-tertiary"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={apply}
              className="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-bg-primary hover:bg-accent/90"
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
