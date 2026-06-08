import { markdownTable, type ColumnDef, type Alignment } from './markdown-table.js';
import { formatDollars, formatPercent, formatDelta, formatNumber } from './cost.js';

export type ResponseFormat = 'markdown' | 'json' | 'csv';

export type CellType = 'string' | 'currency' | 'percent' | 'change' | 'number' | 'delta';

export type Cell = string | number | null;

export interface Column {
  readonly key: string;
  readonly header: string;
  readonly type?: CellType;
  readonly align?: Alignment;
}

export interface Table {
  readonly title?: string;
  readonly columns: readonly Column[];
  readonly rows: readonly (readonly Cell[])[];
  readonly footer?: string;
}

export interface MetaField {
  readonly label: string;
  readonly value: string | number;
  readonly type?: CellType;
}

export interface StructuredResult {
  readonly title: string;
  readonly meta?: readonly MetaField[];
  readonly notes?: readonly string[];
  readonly tables?: readonly Table[];
}

function formatCell(value: Cell, type: CellType | undefined): string {
  if (value === null) return '';
  if (type === undefined || type === 'string') {
    return typeof value === 'string' ? value : String(value);
  }
  if (typeof value !== 'number') return value;
  switch (type) {
    case 'currency': return formatDollars(value);
    case 'percent': return Number.isFinite(value) ? `${value.toFixed(1)}%` : 'N/A';
    case 'change': return formatPercent(value);
    case 'delta': return formatDelta(value);
    case 'number': return formatNumber(value);
  }
}

function defaultAlign(type: CellType | undefined, explicit: Alignment | undefined): Alignment {
  if (explicit !== undefined) return explicit;
  if (type === 'currency' || type === 'percent' || type === 'change' || type === 'delta' || type === 'number') return 'right';
  return 'left';
}

function formatTableMarkdown(table: Table): string {
  const colDefs: ColumnDef[] = table.columns.map(c => ({
    header: c.header,
    align: defaultAlign(c.type, c.align),
  }));
  const rows = table.rows.map(row => row.map((cell, i) => formatCell(cell, table.columns[i]?.type)));
  const sections: string[] = [];
  if (table.title !== undefined && table.title.length > 0) {
    sections.push(`### ${table.title}`);
    sections.push('');
  }
  sections.push(markdownTable(colDefs, rows));
  if (table.footer !== undefined && table.footer.length > 0) {
    sections.push(table.footer);
  }
  return sections.join('\n');
}

export function formatAsMarkdown(result: StructuredResult): string {
  const parts: string[] = [];
  parts.push(`## ${result.title}`);
  parts.push('');
  if (result.meta !== undefined) {
    for (const field of result.meta) {
      parts.push(`**${field.label}**: ${formatCell(field.value, field.type)}`);
    }
    parts.push('');
  }
  if (result.notes !== undefined) {
    for (const note of result.notes) {
      parts.push(note);
      parts.push('');
    }
  }
  if (result.tables !== undefined) {
    for (let i = 0; i < result.tables.length; i++) {
      const table = result.tables[i];
      if (table === undefined) continue;
      parts.push(formatTableMarkdown(table));
      if (i < result.tables.length - 1) parts.push('');
    }
  }
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

interface JsonTable {
  readonly title?: string;
  readonly columns: readonly { key: string; header: string; type: CellType }[];
  readonly rows: readonly (readonly Cell[])[];
  readonly footer?: string;
}

interface JsonMetaField {
  readonly label: string;
  readonly value: string | number;
  readonly type: CellType;
}

interface JsonResult {
  readonly title: string;
  readonly meta?: readonly JsonMetaField[];
  readonly notes?: readonly string[];
  readonly tables?: readonly JsonTable[];
}

export function formatAsJson(result: StructuredResult): string {
  const out: JsonResult = {
    title: result.title,
    ...(result.meta !== undefined ? {
      meta: result.meta.map(f => ({ label: f.label, value: f.value, type: f.type ?? 'string' })),
    } : {}),
    ...(result.notes !== undefined && result.notes.length > 0 ? { notes: result.notes } : {}),
    ...(result.tables !== undefined ? {
      tables: result.tables.map(t => ({
        ...(t.title !== undefined ? { title: t.title } : {}),
        columns: t.columns.map(c => ({ key: c.key, header: c.header, type: c.type ?? 'string' })),
        rows: t.rows,
        ...(t.footer !== undefined && t.footer.length > 0 ? { footer: t.footer.trim() } : {}),
      })),
    } : {}),
  };
  return JSON.stringify(out, null, 2);
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

function cellToCsv(value: Cell, type: CellType | undefined): string {
  if (value === null) return '';
  if (typeof value === 'number') {
    if (type === 'currency' || type === 'delta') return value.toFixed(2);
    if (type === 'percent' || type === 'change') return value.toFixed(2);
    return String(value);
  }
  return value;
}

export function formatAsCsv(result: StructuredResult): string {
  const lines: string[] = [];
  lines.push(`# ${result.title}`);
  if (result.meta !== undefined) {
    for (const field of result.meta) {
      lines.push(`# ${field.label}: ${formatCell(field.value, field.type)}`);
    }
  }
  if (result.notes !== undefined) {
    for (const note of result.notes) lines.push(`# ${note.replaceAll('\n', ' ')}`);
  }
  if (result.tables !== undefined) {
    for (let ti = 0; ti < result.tables.length; ti++) {
      const table = result.tables[ti];
      if (table === undefined) continue;
      if (ti > 0) lines.push('');
      if (table.title !== undefined && table.title.length > 0) lines.push(`# ${table.title}`);
      lines.push(table.columns.map(c => csvEscape(c.header)).join(','));
      for (const row of table.rows) {
        lines.push(row.map((cell, i) => csvEscape(cellToCsv(cell, table.columns[i]?.type))).join(','));
      }
      if (table.footer !== undefined && table.footer.length > 0) {
        lines.push(`# ${table.footer.trim().replace(/^\*|\*$/g, '')}`);
      }
    }
  }
  return lines.join('\n');
}

export function formatResult(result: StructuredResult, format: ResponseFormat): string {
  switch (format) {
    case 'markdown': return formatAsMarkdown(result);
    case 'json': return formatAsJson(result);
    case 'csv': return formatAsCsv(result);
  }
}
