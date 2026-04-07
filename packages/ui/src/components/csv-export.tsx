import type { CostRow } from '@costgoblin/core/browser';

interface CsvExportProps {
  rows: readonly CostRow[];
  topServices: readonly string[];
  filename?: string;
}

function escapeCell(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function buildCsv(rows: readonly CostRow[], topServices: readonly string[]): string {
  const headers = ['Entity', 'Total Cost', ...topServices];
  const lines = [headers.map(escapeCell).join(',')];

  for (const row of rows) {
    const cells = [
      escapeCell(row.entity),
      String(row.totalCost),
      ...topServices.map((svc) => {
        const cost = row.serviceCosts[svc];
        return cost !== undefined ? String(cost) : '';
      }),
    ];
    lines.push(cells.join(','));
  }

  return lines.join('\n');
}

export function CsvExport({ rows, topServices, filename = 'costgoblin-export.csv' }: CsvExportProps) {
  function handleExport() {
    const csv = buildCsv(rows, topServices);
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
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
      Export CSV
    </button>
  );
}
