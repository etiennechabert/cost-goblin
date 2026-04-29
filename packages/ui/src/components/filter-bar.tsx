import { useEffect, useRef, useState } from 'react';
import type { Dimension, DimensionId, FilterMap } from '@costgoblin/core/browser';
import { asTagValue } from '@costgoblin/core/browser';
import { getDimensionId } from '../lib/dimensions.js';
import { formatDollars } from './format.js';

interface FilterValue {
  value: string;
  label: string;
  count: number;
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
}

export function FilterBar({ dimensions, filters, onFilterChange, getFilterValues }: Readonly<FilterBarProps>) {
  const [openDimId, setOpenDimId] = useState<DimensionId | null>(null);
  const [dropdown, setDropdown] = useState<DropdownState>({ status: 'closed' });
  const [search, setSearch] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [labelMap, setLabelMap] = useState<Record<string, string>>({});
  const containerRef = useRef<HTMLDivElement>(null);
  const requestIdRef = useRef(0);
  const itemRefs = useRef(new Map<number, HTMLButtonElement>());

  const hasActiveFilters = Object.keys(filters).length > 0;

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current !== null && !containerRef.current.contains(e.target as Node)) {
        setOpenDimId(null);
        setDropdown({ status: 'closed' });
        setSearch('');
        setHighlightedIndex(-1);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => { document.removeEventListener('mousedown', handleClickOutside); };
  }, []);

  useEffect(() => {
    setHighlightedIndex(-1);
  }, [search]);

  useEffect(() => {
    if (highlightedIndex >= 0) {
      const item = itemRefs.current.get(highlightedIndex);
      if (item !== undefined) {
        item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }, [highlightedIndex]);

  function withoutFilter(dimId: DimensionId): FilterMap {
    const next: Partial<Record<DimensionId, ReturnType<typeof asTagValue>>> = {};
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
      setHighlightedIndex(-1);
      return;
    }

    setOpenDimId(dimId);
    setSearch('');
    setHighlightedIndex(-1);
    setDropdown({ status: 'loading' });

    const filtersWithoutThis = withoutFilter(dimId);
    const thisRequestId = ++requestIdRef.current;

    getFilterValues(dimId, filtersWithoutThis).then(
      (values) => {
        if (thisRequestId !== requestIdRef.current) return;
        setDropdown({
          status: 'ready',
          values: [...values].sort((a, b) => b.count - a.count),
        });
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

  function handleSelectValue(dimId: DimensionId, value: string, label: string) {
    setLabelMap(prev => ({ ...prev, [value]: label }));
    onFilterChange({ ...filters, [dimId]: asTagValue(value) });
    setOpenDimId(null);
    setDropdown({ status: 'closed' });
    setSearch('');
    setHighlightedIndex(-1);
  }

  function handleClearAll() {
    onFilterChange({});
  }

  return (
    <div ref={containerRef} className="relative flex flex-wrap items-center gap-2">
      {dimensions.map((dim) => {
        const dimId = getDimensionId(dim);
        const activeValue = filters[dimId];
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
                activeValue === undefined
                  ? 'border-border bg-bg-tertiary/30 text-text-secondary hover:border-border hover:text-text-primary'
                  : 'border-accent bg-accent-muted text-accent',
              ].join(' ')}
            >
              <button
                type="button"
                onClick={() => { handleChipClick(dimId); }}
                className="bg-transparent border-none p-0 text-inherit font-inherit cursor-pointer"
              >
                {activeValue === undefined ? dim.label : `${dim.label}: ${labelMap[activeValue] ?? activeValue}`}
              </button>
              {activeValue !== undefined && (
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
              <div className="absolute left-0 top-full z-50 mt-1 w-64 rounded-lg border border-border bg-bg-secondary shadow-lg">
                <div className="border-b border-border p-2">
                  <input
                    autoFocus
                    type="text"
                    value={search}
                    placeholder={`Search ${dim.label}…`}
                    onChange={(e) => { setSearch(e.target.value); }}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        setOpenDimId(null);
                        setDropdown({ status: 'closed' });
                        setSearch('');
                        setHighlightedIndex(-1);
                        return;
                      }

                      if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        setHighlightedIndex((prev) => {
                          const next = prev + 1;
                          if (next >= filteredValues.length) return 0;
                          return next;
                        });
                        return;
                      }

                      if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        setHighlightedIndex((prev) => {
                          const next = prev - 1;
                          if (next < 0) return filteredValues.length - 1;
                          return next;
                        });
                        return;
                      }

                      if (e.key === 'Home') {
                        e.preventDefault();
                        setHighlightedIndex(0);
                        return;
                      }

                      if (e.key === 'End') {
                        e.preventDefault();
                        setHighlightedIndex(filteredValues.length - 1);
                        return;
                      }

                      if (e.key === 'Enter' && highlightedIndex >= 0 && highlightedIndex < filteredValues.length) {
                        e.preventDefault();
                        const item = filteredValues[highlightedIndex];
                        if (item !== undefined) {
                          handleSelectValue(dimId, item.value, item.label);
                        }
                        return;
                      }
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

                  {dropdown.status === 'ready' && filteredValues.map((item, index) => {
                    const isHighlighted = index === highlightedIndex;
                    return (
                      <button
                        key={item.value}
                        ref={(el) => {
                          if (el !== null) {
                            itemRefs.current.set(index, el);
                          } else {
                            itemRefs.current.delete(index);
                          }
                        }}
                        type="button"
                        onClick={() => { handleSelectValue(dimId, item.value, item.label); }}
                        className={[
                          'flex w-full items-center justify-between px-3 py-1.5 text-left text-xs text-text-primary',
                          isHighlighted ? 'bg-accent-muted' : 'hover:bg-bg-tertiary',
                        ].join(' ')}
                      >
                        <span className="truncate">{item.label}</span>
                        <span className="ml-2 shrink-0 text-text-muted">{formatDollars(item.count)}</span>
                      </button>
                    );
                  })}
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
    </div>
  );
}
