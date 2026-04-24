import { useCallback, useEffect, useState } from 'react';
import { useCostApi } from './use-cost-api.js';

/**
 * Table column preferences - visibility and display order.
 *
 * Hidden columns are stored as "hidden" rather than "visible" so that newly
 * added columns appear by default without user intervention.
 *
 * Column order contains keys in display order. Columns not in this list
 * (e.g., newly added) are appended in their default order.
 */
export interface TablePreferences {
  readonly hiddenColumns: readonly string[];
  readonly columnOrder: readonly string[];
}

/**
 * Return value for useTablePreferences hook - provides state and callbacks
 * for managing table column preferences.
 */
export interface UseTablePreferencesReturn {
  readonly hiddenColumns: readonly string[];
  readonly columnOrder: readonly string[];
  readonly updateHiddenColumns: (columns: readonly string[]) => void;
  readonly updateColumnOrder: (order: readonly string[]) => void;
}

/**
 * Hook for managing table column visibility and order preferences.
 *
 * Loads preferences on mount and persists changes automatically. The UI
 * reflects changes immediately; persistence failures are silent (preference
 * won't survive reload, but this is a rare edge case not worth surfacing).
 *
 * Currently supports:
 * - 'explorer': Cost explorer table (uses ExplorerPreferences API)
 *
 * Other table identifiers return empty arrays and no-op persistence (can be
 * extended with additional API methods as needed).
 *
 * @param tableId - Unique identifier for the table (e.g., 'explorer', 'savings')
 * @returns Table preferences state and update callbacks
 *
 * @example
 * ```tsx
 * const { hiddenColumns, columnOrder, updateHiddenColumns, updateColumnOrder } =
 *   useTablePreferences('explorer');
 *
 * // Hide a column
 * updateHiddenColumns([...hiddenColumns, 'service_family']);
 *
 * // Reorder columns
 * updateColumnOrder(['usage_date', 'cost', 'service']);
 * ```
 */
export function useTablePreferences(tableId: string): UseTablePreferencesReturn {
  const api = useCostApi();
  const [hiddenColumns, setHiddenColumns] = useState<readonly string[]>([]);
  const [columnOrder, setColumnOrder] = useState<readonly string[]>([]);

  // Load preferences on mount. Falls back to empty arrays on error (no
  // persistence, but the table still renders with default column state).
  useEffect(() => {
    if (tableId === 'explorer') {
      api.getExplorerPreferences()
        .then(prefs => {
          setHiddenColumns(prefs.hiddenColumns);
          setColumnOrder(prefs.columnOrder);
        })
        .catch(() => {
          setHiddenColumns([]);
          setColumnOrder([]);
        });
    } else {
      // Other table types not yet supported — use empty defaults.
      // Future: add cases for 'savings', 'cost-overview', etc. with their
      // own API methods (getSavingsPreferences, etc.).
      setHiddenColumns([]);
      setColumnOrder([]);
    }
  }, [api, tableId]);

  // Persist preferences helper. Fire-and-forget — the UI already reflects
  // the new state locally, so write failures just mean the preference won't
  // survive a reload (rare, not worth error handling).
  const savePreferences = useCallback(
    (hidden: readonly string[], order: readonly string[]) => {
      if (tableId === 'explorer') {
        void api.saveExplorerPreferences({
          hiddenColumns: hidden,
          columnOrder: order,
        });
      }
      // Other table types: no-op until API support is added
    },
    [api, tableId],
  );

  // Update hidden columns and persist. One helper keeps both fields in sync
  // on every save to avoid stale reads between the two separate setters.
  const updateHiddenColumns = useCallback(
    (next: readonly string[]) => {
      setHiddenColumns(next);
      savePreferences(next, columnOrder);
    },
    [columnOrder, savePreferences],
  );

  // Update column order and persist
  const updateColumnOrder = useCallback(
    (next: readonly string[]) => {
      setColumnOrder(next);
      savePreferences(hiddenColumns, next);
    },
    [hiddenColumns, savePreferences],
  );

  return {
    hiddenColumns,
    columnOrder,
    updateHiddenColumns,
    updateColumnOrder,
  };
}
