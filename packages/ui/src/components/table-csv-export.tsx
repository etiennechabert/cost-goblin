import type { Table } from '@tanstack/react-table';
import { Download } from 'lucide-react';

interface TableCsvExportProps<TData> {
  readonly table: Table<TData>;
  readonly filename?: string;
}

/**
 * CSV export button for TanStack Table instances.
 * Exports visible columns in current sort order.
 *
 * Features:
 * - Respects column visibility state (hidden columns excluded)
 * - Exports rows in current sort order
 * - Handles cell rendering via column definitions
 * - CSV-compliant escaping (commas, quotes, newlines)
 */
export function TableCsvExport<TData>({
  table,
  filename = 'export.csv'
}: Readonly<TableCsvExportProps<TData>>) {

  function escapeCell(value: unknown): string {
    // Handle null/undefined
    if (value === null || value === undefined) {
      return '';
    }

    // Handle primitives (string, number, boolean)
    let str: string;
    if (typeof value === 'string') {
      str = value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      str = String(value);
    } else {
      // For objects, arrays, etc., return empty string or use JSON
      str = '';
    }

    // CSV escaping: wrap in quotes if contains comma, quote, or newline
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replaceAll('"', '""')}"`;
    }
    return str;
  }

  function handleExport() {
    // Get visible columns (respects column visibility state)
    const columns = table.getVisibleLeafColumns();

    // Build header row
    const headers = columns.map(col => {
      const headerValue = typeof col.columnDef.header === 'string'
        ? col.columnDef.header
        : col.id;
      return escapeCell(headerValue);
    });

    const lines = [headers.join(',')];

    // Get sorted rows (respects current sort state)
    const rows = table.getSortedRowModel().rows;

    // Build data rows
    for (const row of rows) {
      const cells = columns.map(col => {
        const cell = row.getValue(col.id);
        return escapeCell(cell);
      });
      lines.push(cells.join(','));
    }

    // Create and download CSV file
    const csv = lines.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <button
      type="button"
      onClick={handleExport}
      className="flex items-center gap-1.5 rounded-lg border border-border bg-bg-tertiary/50 px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-tertiary hover:text-text-primary transition-colors"
    >
      <Download className="h-3.5 w-3.5" />
      Export CSV
    </button>
  );
}
