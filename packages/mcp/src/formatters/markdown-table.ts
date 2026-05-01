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

export function markdownTable(columns: readonly ColumnDef[], rows: readonly (readonly string[])[]): string {
  const aligns: Alignment[] = columns.map(c => c.align ?? 'left');
  const widths = columns.map(c => c.header.length);

  for (const row of rows) {
    for (let i = 0; i < columns.length; i++) {
      const cell = row[i] ?? '';
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    }
  }

  const headerLine = '| ' + columns.map((c, i) => pad(c.header, widths[i] ?? 0, aligns[i] ?? 'left')).join(' | ') + ' |';
  const sepLine = '| ' + columns.map((_, i) => separatorCell(widths[i] ?? 3, aligns[i] ?? 'left')).join(' | ') + ' |';

  const dataLines = rows.map(row =>
    '| ' + columns.map((_, i) => pad(row[i] ?? '', widths[i] ?? 0, aligns[i] ?? 'left')).join(' | ') + ' |',
  );

  return [headerLine, sepLine, ...dataLines].join('\n');
}
