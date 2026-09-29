import { escapeMarkdownCell } from './neutralize.js';

export type Alignment = 'left' | 'right' | 'center';

export interface ColumnDef {
  readonly header: string;
  readonly align?: Alignment | undefined;
}

function pad(s: string, width: number, align: Alignment): string {
  if (s.length >= width) return s;
  const diff = width - s.length;
  switch (align) {
    case 'right': return ' '.repeat(diff) + s;
    case 'center': {
      const left = Math.floor(diff / 2);
      return ' '.repeat(left) + s + ' '.repeat(diff - left);
    }
    default: return s + ' '.repeat(diff);
  }
}

function separatorCell(width: number, align: Alignment): string {
  const dashes = '-'.repeat(Math.max(width, 3));
  switch (align) {
    case 'right': return `${dashes.slice(0, -1)}:`;
    case 'center': return `:${dashes.slice(2)}:`;
    default: return dashes;
  }
}

/** Render a GFM table. Headers and cells may hold billing/config values, so
 *  each is escaped (single line, `|` as backslash-pipe) BEFORE the column
 *  widths are measured — padding is computed on what is actually emitted. */
export function markdownTable(columns: readonly ColumnDef[], rows: readonly (readonly string[])[]): string {
  const aligns: Alignment[] = columns.map(c => c.align ?? 'left');
  const headers = columns.map(c => escapeMarkdownCell(c.header));
  const cells = rows.map(row => columns.map((_, i) => escapeMarkdownCell(row[i] ?? '')));
  const widths = headers.map(h => h.length);

  for (const row of cells) {
    for (let i = 0; i < columns.length; i++) {
      widths[i] = Math.max(widths[i] ?? 0, (row[i] ?? '').length);
    }
  }

  const headerLine = '| ' + headers.map((h, i) => pad(h, widths[i] ?? 0, aligns[i] ?? 'left')).join(' | ') + ' |';
  const sepLine = '| ' + columns.map((_, i) => separatorCell(widths[i] ?? 3, aligns[i] ?? 'left')).join(' | ') + ' |';

  const dataLines = cells.map(row =>
    '| ' + row.map((cell, i) => pad(cell, widths[i] ?? 0, aligns[i] ?? 'left')).join(' | ') + ' |',
  );

  return [headerLine, sepLine, ...dataLines].join('\n');
}
