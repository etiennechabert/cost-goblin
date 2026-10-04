import type { RowData, Table, TableFeatures } from '@tanstack/react-table';
import { Download } from 'lucide-react';

// A leading =, +, -, @, tab, or CR makes Excel/Sheets evaluate the cell as a
// formula. Cell values can come from billing-derived text (resource tag values
// an AWS user controls), so neutralise the trigger on string cells by prefixing
// a single quote. Numeric cells are left as-is — a negative number is not an
// injection vector.
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

export function escapeCsv(value: unknown): string {
  if (value === null || value === undefined) return '';
  let str = '';
  if (typeof value === 'string') {
    str = FORMULA_TRIGGER.test(value) ? `'${value}` : value;
  } else if (typeof value === 'number') {
    str = value.toString();
  }
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replaceAll('"', '""')}"`;
  }
  return str;
}

export function CsvExportButton<TFeatures extends TableFeatures, TData extends RowData>({ table, filename }: Readonly<{ table: Table<TFeatures, TData>; filename: string }>) {
  function handleExport() {
    // Every leaf column: callers hand DataTable only the columns on screen.
    const columns = table.getAllLeafColumns();
    const headers = columns.map(col => {
      const header = col.columnDef.header;
      return typeof header === 'string' ? header : col.id;
    });

    const csvRows = [headers.map(escapeCsv).join(',')];
    for (const row of table.getSortedRowModel().rows) {
      csvRows.push(columns.map(col => escapeCsv(row.getValue(col.id))).join(','));
    }

    const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <button
      type="button"
      onClick={handleExport}
      className="inline-flex items-center gap-1.5 rounded border border-border bg-bg-tertiary/30 px-2.5 py-1 text-xs text-text-secondary hover:text-text-primary hover:border-border"
      title="Export visible columns as CSV"
    >
      <Download size={12} />
      <span>CSV</span>
    </button>
  );
}
