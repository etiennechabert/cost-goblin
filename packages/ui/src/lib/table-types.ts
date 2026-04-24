import type { SortingState, VisibilityState, ColumnPinningState } from '@tanstack/react-table';

/** Generic table column definition with CostGoblin-specific metadata.
 *  This interface wraps TanStack Table's column types and adds metadata for
 *  rendering, alignment, and dimension filtering. The generic TData parameter
 *  matches the row data type. Components convert this to TanStack Table's
 *  ColumnDef internally. */
export interface TableColumn<TData> {
  /** Unique column identifier. For accessor columns, this is the property
   *  key in TData. For display columns, this is a unique string. Used for
   *  persistence in TablePreferences.columnOrder and hiddenColumns. */
  readonly id: string;
  /** Human-readable column header label. */
  readonly label: string;
  /** Property key in TData to access the cell value. When present, this
   *  creates an accessor column. When null, this creates a display column
   *  (e.g. for action buttons) and requires a custom cell renderer. */
  readonly accessorKey?: keyof TData | null | undefined;
  /** Custom cell renderer. Receives the full row data and should return a
   *  React node. When omitted for accessor columns, TanStack Table renders
   *  the raw cell value as text. */
  readonly cell?: ((row: TData) => React.ReactNode) | undefined;
  /** Text alignment for this column's cells. Defaults to 'left'. Cost and
   *  numeric columns typically use 'right'. */
  readonly align?: 'left' | 'right' | 'center' | undefined;
  /** If true, render cell content in monospace font (e.g. resource IDs,
   *  usage dates, AWS regions). */
  readonly mono?: boolean | undefined;
  /** If true, truncate overflowing text with ellipsis and add a title
   *  tooltip. Useful for description and resource_id columns. */
  readonly truncate?: boolean | undefined;
  /** Dimension ID this column maps to for filtering. When non-null, clicking
   *  a cell value in the Explorer view adds that value to the filter bar.
   *  Null for derived columns like cost totals or computed percentages. */
  readonly dimId?: string | null | undefined;
  /** Whether this column can be pinned to the left edge. Entity / primary
   *  columns are typically pinnable so users never lose context during
   *  horizontal scroll. Defaults to false. */
  readonly pinnable?: boolean | undefined;
  /** Whether this column is sortable. Defaults to true for accessor columns,
   *  false for display columns. */
  readonly sortable?: boolean | undefined;
  /** Minimum column width in pixels. Defaults to undefined (no minimum). */
  readonly minWidth?: number | undefined;
  /** Maximum column width in pixels. Defaults to undefined (no maximum). */
  readonly maxWidth?: number | undefined;
}

/** Persisted user preferences for table column configuration. Stored as JSON
 *  in the userData directory (desktop app) or localStorage (web mode).
 *  Follows the same pattern as ExplorerPreferences — columns are stored as
 *  "hidden" not "visible" so new columns added in future updates appear
 *  automatically without requiring user re-enablement. */
export interface TablePreferences {
  /** Column IDs the user has hidden. Missing columns are visible by default. */
  readonly hiddenColumns: readonly string[];
  /** User-chosen display order for table columns. Column IDs present in this
   *  list render in the given order. Column IDs absent from this list (e.g.
   *  newly-added columns or columns the user hasn't reordered yet) are
   *  appended afterwards in their default order. */
  readonly columnOrder: readonly string[];
  /** Column IDs pinned to the left edge. Pinned columns remain visible
   *  during horizontal scroll. Typically contains the entity or primary
   *  dimension column. Empty array means no pinning. */
  readonly pinnedColumns: readonly string[];
  /** Multi-column sort state persisted across sessions. Each entry contains
   *  a column ID and sort direction ('asc' | 'desc'). Order matters — first
   *  entry is primary sort, subsequent entries are tie-breakers. Empty array
   *  means no sorting applied. */
  readonly sorting: SortingState;
}

/** Props for the VirtualTable component — a DataTable wrapper that uses
 *  @tanstack/react-virtual for smooth scrolling of 10,000+ row datasets.
 *  The generic TData parameter matches the row data type (e.g.
 *  ExplorerRowsResult['rows'][number] for the Explorer view). */
export interface VirtualTableProps<TData> {
  /** Row data array. Virtual scrolling renders only the visible subset
   *  (typically 20-50 rows at a time), so this can safely contain 10k+
   *  items without performance degradation. */
  readonly data: readonly TData[];
  /** Column definitions — must include an `id` field for TanStack Table's
   *  internal tracking. See TableColumn<TData> for the full interface. */
  readonly columns: readonly TableColumn<TData>[];
  /** Initial column visibility state. Missing column IDs default to visible.
   *  Controlled by the useTablePreferences hook. */
  readonly columnVisibility?: VisibilityState | undefined;
  /** Callback fired when the user toggles column visibility via the column
   *  picker dropdown. The consuming component should persist this state via
   *  useTablePreferences. */
  readonly onColumnVisibilityChange?: ((state: VisibilityState) => void) | undefined;
  /** Initial column pinning state. Keys are 'left' and 'right'; values are
   *  arrays of column IDs. Only 'left' pinning is currently supported
   *  (right-side pinning reserved for future actions column). */
  readonly columnPinning?: ColumnPinningState | undefined;
  /** Callback fired when the user pins or unpins a column. The consuming
   *  component should persist this state via useTablePreferences. */
  readonly onColumnPinningChange?: ((state: ColumnPinningState) => void) | undefined;
  /** Initial sort state. Array of { id: columnId, desc: boolean } objects.
   *  Multi-column sort is supported — shift+click a header to add a secondary
   *  sort. Empty array means no sorting. */
  readonly sorting?: SortingState | undefined;
  /** Callback fired when the user clicks a column header to sort. The
   *  consuming component should persist this state via useTablePreferences. */
  readonly onSortingChange?: ((state: SortingState) => void) | undefined;
  /** Optional loading indicator. When true, displays a semi-transparent
   *  overlay with a spinner (CoinRainLoader). */
  readonly loading?: boolean | undefined;
  /** Optional error message. When non-null, displays an error banner above
   *  the table. */
  readonly error?: string | null | undefined;
  /** Optional empty state message displayed when data.length === 0 and
   *  loading === false. Defaults to "No data available". */
  readonly emptyMessage?: string | undefined;
  /** Row height in pixels. Defaults to 48. Must be constant for virtual
   *  scrolling to calculate scroll positions correctly. */
  readonly rowHeight?: number | undefined;
  /** Overscan count — number of rows to render outside the visible viewport
   *  for smoother scrolling. Defaults to 10. Higher values improve scroll
   *  smoothness but increase DOM node count. */
  readonly overscan?: number | undefined;
  /** Optional callback fired when the user clicks a cell. Receives the row
   *  data, column ID, and cell value. Used by Explorer to add filter chips
   *  when clicking dimension values. */
  readonly onCellClick?: ((row: TData, columnId: string, value: unknown) => void) | undefined;
  /** If true, show a column visibility toggle button in the table toolbar.
   *  Requires onColumnVisibilityChange to be set. Defaults to false. */
  readonly showColumnVisibilityToggle?: boolean | undefined;
  /** If true, show a CSV export button in the table toolbar. Exports visible
   *  columns in current sort order. Defaults to false. */
  readonly showCsvExport?: boolean | undefined;
  /** Optional filename for CSV export. Defaults to 'export.csv'. */
  readonly csvFilename?: string | undefined;
}
