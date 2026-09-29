// Shared inputs and structural checks for the MCP output-neutralization tests
// (#602). Raw U+0085 / U+2028 / U+2029 must never appear in this package's
// source, so the break characters are built from their char codes.

const NEL = String.fromCharCode(0x85);
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

/** Every kind of line break a markdown/csv consumer may honour. CRLF is one
 *  break; the others are single characters. */
export const BREAKS: readonly (readonly [name: string, value: string])[] = [
  ['LF', '\n'],
  ['CR', '\r'],
  ['CRLF', '\r\n'],
  ['NEL', NEL],
  ['LS', LS],
  ['PS', PS],
];

/** One backslash followed by `n`: what every break becomes. */
export const ESCAPED_BREAK = '\\n';

/** Hostile values: a pipe, every break kind followed by a forged heading, a C0
 *  control, a trailing backslash and a backslash-pipe. */
export const HOSTILE_VALUES: readonly string[] = [
  'bob | x',
  ...BREAKS.map(([name, br]) => `pay${name}${br}## Forged`),
  `bell${String.fromCharCode(7)}ring`,
  'trailing\\',
  'back\\|slash',
];

function isBreakCode(code: number): boolean {
  return code === 0x0a || code === 0x0d || code === 0x85 || code === 0x2028 || code === 0x2029;
}

/** Split text into physical lines on EVERY break kind (CRLF counts once). */
export function splitPhysicalLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (!isBreakCode(code)) continue;
    lines.push(text.slice(start, i));
    if (code === 0x0d && text.charCodeAt(i + 1) === 0x0a) i++;
    start = i + 1;
  }
  lines.push(text.slice(start));
  return lines;
}

/** Number of `|` characters not directly preceded by a backslash — the pipes
 *  a GFM table parser treats as cell delimiters. */
export function unescapedPipeCount(line: string): number {
  let count = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '|' && line[i - 1] !== '\\') count++;
  }
  return count;
}

/** True for a GFM table delimiter row such as `| --- | ---: |`. */
export function isDelimiterRow(line: string): boolean {
  if (!line.startsWith('| ') || !line.includes('---')) return false;
  for (const ch of line) {
    if (ch !== '|' && ch !== '-' && ch !== ':' && ch !== ' ') return false;
  }
  return true;
}

export interface MarkdownTableShape {
  readonly lines: readonly string[];
  readonly pipesPerLine: number;
}

/** Every markdown table in `text`: from the header line (just above a
 *  delimiter row) to the next blank line. */
export function markdownTables(text: string): MarkdownTableShape[] {
  const lines = splitPhysicalLines(text);
  const tables: MarkdownTableShape[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || !isDelimiterRow(line)) continue;
    let end = i + 1;
    while (end < lines.length && lines[end] !== '') end++;
    tables.push({ lines: lines.slice(i - 1, end), pipesPerLine: unescapedPipeCount(line) });
  }
  return tables;
}

/** Split one CSV record into fields (RFC 4180 quoting). Returns null when the
 *  line is not a single complete record (an unterminated quote). */
export function parseCsvRecord(line: string): string[] | null {
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch ?? '';
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      fields.push(field);
      field = '';
    } else {
      field += ch ?? '';
    }
  }
  if (quoted) return null;
  fields.push(field);
  return fields;
}

/** A CSV comment line: `#` (or a quoted `"#` cell) at the start. */
export function isCsvComment(line: string): boolean {
  return line.startsWith('#') || line.startsWith('"#');
}
