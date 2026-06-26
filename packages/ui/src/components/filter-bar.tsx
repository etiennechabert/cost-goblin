import { useEffect, useRef, useState } from 'react';
import type { Dimension, DimensionId, FilterMap, TagValue } from '@costgoblin/core/browser';
import { asTagValue } from '@costgoblin/core/browser';
import { getDimensionId } from '../lib/dimensions.js';
import { formatDollars } from './format.js';

interface FilterValue {
  value: string;
  label: string;
  count: number;
}

function filterMapsEqual(a: FilterMap, b: FilterMap): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    const va = a[k as DimensionId];
    const vb = b[k as DimensionId];
    if (va === undefined || vb === undefined) return false;
    if (va.length !== vb.length) return false;
    const sortedA = [...va].sort((x, y) => x.localeCompare(y));
    const sortedB = [...vb].sort((x, y) => x.localeCompare(y));
    for (let i = 0; i < sortedA.length; i++) {
      if (sortedA[i] !== sortedB[i]) return false;
    }
  }
  return true;
}

type DropdownState =
  | { status: 'closed' }
  | { status: 'loading' }
  | { status: 'ready'; values: FilterValue[] }
  | { status: 'error'; error: Error };

interface FilterBarProps {
  dimensions: Dimension[];
  filters: FilterMap;
  onFilterChange: (filters: FilterMap) => void;
  getFilterValues: (dimensionId: DimensionId, currentFilters: FilterMap) => Promise<FilterValue[]>;
  /** Per-dim default values pre-applied on view open. Exposed here so the
   *  filter bar can show a "Reset defaults" affordance once the user's
   *  current selection has drifted away from the defaults. */
  defaults?: FilterMap | undefined;
}

export function FilterBar({ dimensions, filters, onFilterChange, getFilterValues, defaults }: Readonly<FilterBarProps>) {
  const [openDimId, setOpenDimId] = useState<DimensionId | null>(null);
  const [dropdown, setDropdown] = useState<DropdownState>({ status: 'closed' });
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<readonly string[]>([]);
  const [labelMap, setLabelMap] = useState<Record<string, string>>({});
  const containerRef = useRef<HTMLDivElement>(null);
  const requestIdRef = useRef(0);

  const hasActiveFilters = Object.keys(filters).length > 0;
  const defaultsAvailable = defaults !== undefined && Object.keys(defaults).length > 0;
  const matchesDefaults = defaultsAvailable && filterMapsEqual(filters, defaults);
  const canResetDefaults = defaultsAvailable && !matchesDefaults;

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current !== null && !containerRef.current.contains(e.target as Node)) {
        setOpenDimId(null);
        setDropdown({ status: 'closed' });
        setSearch('');
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => { document.removeEventListener('mousedown', handleClickOutside); };
  }, []);

  function withoutFilter(dimId: DimensionId): FilterMap {
    const next: Partial<Record<DimensionId, readonly TagValue[]>> = {};
    for (const dim of dimensions) {
      const id = getDimensionId(dim);
      if (id === dimId) continue;
      const val = filters[id];
      if (val !== undefined) next[id] = val;
    }
    return next;
  }

  function handleChipClick(dimId: DimensionId) {
    if (openDimId === dimId) {
      setOpenDimId(null);
      setDropdown({ status: 'closed' });
      setSearch('');
      return;
    }

    setOpenDimId(dimId);
    setSearch('');
    setDraft([...(filters[dimId] ?? [])]);
    setDropdown({ status: 'loading' });

    const filtersWithoutThis = withoutFilter(dimId);
    const thisRequestId = ++requestIdRef.current;

    const noActiveFilter = filters[dimId] === undefined || filters[dimId].length === 0;
    getFilterValues(dimId, filtersWithoutThis).then(
      (values) => {
        if (thisRequestId !== requestIdRef.current) return;
        const newLabels: Record<string, string> = {};
        for (const v of values) newLabels[v.value] = v.label;
        setLabelMap(prev => ({ ...prev, ...newLabels }));
        const sorted = [...values].sort((a, b) => b.count - a.count);
        if (noActiveFilter) setDraft(sorted.map(v => v.value));
        setDropdown({ status: 'ready', values: sorted });
      },
      (err: unknown) => {
        if (thisRequestId !== requestIdRef.current) return;
        setDropdown({
          status: 'error',
          error: err instanceof Error ? err : new Error(String(err)),
        });
      },
    );
  }

  function handleClearFilter(dimId: DimensionId, e: React.MouseEvent) {
    e.stopPropagation();
    onFilterChange(withoutFilter(dimId));
  }

  function handleClearFilterKey(dimId: DimensionId, e: React.KeyboardEvent) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.stopPropagation();
    onFilterChange(withoutFilter(dimId));
  }

  function handleApply(dimId: DimensionId) {
    if (draft.length === 0) {
      onFilterChange(withoutFilter(dimId));
    } else {
      onFilterChange({ ...filters, [dimId]: draft.map(v => asTagValue(v)) });
    }
    setOpenDimId(null);
    setDropdown({ status: 'closed' });
    setSearch('');
  }

  function handleClose() {
    setOpenDimId(null);
    setDropdown({ status: 'closed' });
    setSearch('');
  }

  function toggleValue(value: string) {
    setDraft(prev => prev.includes(value) ? prev.filter(v => v !== value) : [...prev, value]);
  }

  function handleOnly(value: string) {
    setDraft([value]);
  }

  function handleClearAll() {
    onFilterChange({});
  }

  function handleResetDefaults() {
    if (defaults === undefined) return;
    onFilterChange(defaults);
  }

  function chipLabel(dim: Dimension, active: readonly TagValue[] | undefined): string {
    if (active === undefined || active.length === 0) return dim.label;
    if (active.length === 1) {
      const first = active[0];
      if (first === undefined) return dim.label;
      return `${dim.label}: ${labelMap[first] ?? first}`;
    }
    return `${dim.label} \u00b7 ${String(active.length)}`;
  }

  return (
    <div ref={containerRef} className="relative flex flex-wrap items-center gap-2">
      {dimensions.map((dim) => {
        const dimId = getDimensionId(dim);
        const activeValues = filters[dimId];
        const isActive = activeValues !== undefined && activeValues.length > 0;
        const isOpen = openDimId === dimId;

        const filteredValues =
          dropdown.status === 'ready'
            ? dropdown.values.filter((v) =>
                search.length === 0 || v.label.toLowerCase().includes(search.toLowerCase()),
              )
            : [];

        return (
          <div key={dimId} className="relative">
            <div
              className={[
                'flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                isActive
                  ? 'border-accent bg-accent-muted text-accent'
                  : 'border-border bg-bg-tertiary/30 text-text-secondary hover:border-border hover:text-text-primary',
              ].join(' ')}
            >
              <button
                type="button"
                onClick={() => { handleChipClick(dimId); }}
                className="bg-transparent border-none p-0 text-inherit font-inherit cursor-pointer"
              >
                {chipLabel(dim, activeValues)}
              </button>
              {isActive && (
                <button
                  type="button"
                  aria-label={`Clear ${dim.label} filter`}
                  onClick={(e) => { handleClearFilter(dimId, e); }}
                  onKeyDown={(e) => { handleClearFilterKey(dimId, e); }}
                  className="ml-0.5 rounded-full p-0.5 hover:bg-accent-muted"
                >
                  ×
                </button>
              )}
            </div>

            {isOpen && (
              <div className="absolute left-0 top-full z-50 mt-1 w-72 rounded-lg border border-border bg-bg-secondary shadow-lg">
                <div className="border-b border-border p-2">
                  <input
                    autoFocus
                    type="text"
                    value={search}
                    placeholder={`Search ${dim.label}…`}
                    onChange={(e) => { setSearch(e.target.value); }}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') handleClose();
                      if (e.key === 'Enter') handleApply(dimId);
                    }}
                    className="w-full rounded border border-border bg-bg-primary px-2 py-1 text-xs text-text-primary outline-none focus:border-accent"
                  />
                </div>

                <div className="max-h-60 overflow-y-auto">
                  {dropdown.status === 'loading' && (
                    <div className="flex items-center justify-center gap-2 py-6 text-xs text-text-secondary">
                      <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-border border-t-accent" />
                      <span>Loading…</span>
                    </div>
                  )}

                  {dropdown.status === 'error' && (
                    <div className="px-3 py-4 text-xs text-negative">
                      Failed to load values
                    </div>
                  )}

                  {dropdown.status === 'ready' && filteredValues.length === 0 && (
                    <div className="px-3 py-4 text-xs text-text-muted">
                      No values found
                    </div>
                  )}

                  {dropdown.status === 'ready' && filteredValues.map((item) => {
                    const checked = draft.includes(item.value);
                    return (
                      <label
                        key={item.value}
                        className={[
                          'group flex items-center justify-between gap-2 px-3 py-1.5 text-xs cursor-pointer select-none',
                          checked ? 'bg-accent-muted/50 text-text-primary' : 'text-text-secondary hover:bg-bg-tertiary',
                        ].join(' ')}
                      >
                        <span className="flex items-center gap-2 min-w-0 flex-1">
                          <input
                            type="checkbox"
                            className="accent-accent shrink-0"
                            checked={checked}
                            onChange={() => { toggleValue(item.value); }}
                            aria-label={item.label}
                          />
                          <span className="truncate">{item.label}</span>
                        </span>
                        <span className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleOnly(item.value); }}
                            className="text-text-muted hover:text-accent opacity-0 group-hover:opacity-100 text-[10px] font-medium uppercase tracking-wide"
                          >
                            only
                          </button>
                          <span className="text-text-muted tabular-nums">{formatDollars(item.count)}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>

                <div className="flex items-center justify-between border-t border-border p-2 gap-2">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => { setDraft([]); }}
                      className="text-xs text-text-secondary hover:text-accent"
                      disabled={draft.length === 0}
                    >
                      Clear
                    </button>
                    <button
                      type="button"
                      onClick={() => { setDraft(filteredValues.map(v => v.value)); }}
                      className="text-xs text-text-secondary hover:text-accent"
                      disabled={filteredValues.length === 0 || draft.length === filteredValues.length}
                    >
                      All
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleClose}
                      className="rounded-md px-2 py-1 text-xs text-text-secondary hover:bg-bg-tertiary"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => { handleApply(dimId); }}
                      className="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-bg-primary hover:bg-accent/90"
                    >
                      Apply
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {hasActiveFilters && (
        <button
          type="button"
          onClick={handleClearAll}
          className="rounded-full px-3 py-1 text-xs text-text-secondary underline-offset-2 hover:text-text-primary hover:underline"
        >
          Clear all
        </button>
      )}
      {canResetDefaults && (
        <button
          type="button"
          onClick={handleResetDefaults}
          className="rounded-full px-3 py-1 text-xs text-text-secondary underline-offset-2 hover:text-text-primary hover:underline"
        >
          Reset defaults
        </button>
      )}
    </div>
  );
}
