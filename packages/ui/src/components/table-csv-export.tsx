import type { Table } from '@tanstack/react-table';
import { Download } from 'lucide-react';

function escapeCsv(value: unknown): string {
  if (value === null || value === undefined) return '';
  let str = '';
  if (typeof value === 'string') str = value;
  else if (typeof value === 'number') str = value.toString();
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replaceAll('"', '""')}"`;
  }
  return str;
}

export function CsvExportButton<TData>({ table, filename }: Readonly<{ table: Table<TData>; filename: string }>) {
  function handleExport() {
    const visibleColumns = table.getVisibleLeafColumns();
    const headers = visibleColumns.map(col => {
      const header = col.columnDef.header;
      return typeof header === 'string' ? header : col.id;
    });

    const csvRows = [headers.map(escapeCsv).join(',')];
    for (const row of table.getSortedRowModel().rows) {
      const cells = visibleColumns.map(col => {
        const cell = row.getAllCells().find(c => c.column.id === col.id);
        return escapeCsv(cell?.getValue());
      });
      csvRows.push(cells.join(','));
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
