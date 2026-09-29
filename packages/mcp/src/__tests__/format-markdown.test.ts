import { describe, expect, it } from 'vitest';
import { truncateFooter } from '../formatters/cost.js';
import { markdownTable } from '../formatters/markdown-table.js';
import { formatAsMarkdown } from '../formatters/result.js';
import type { StructuredResult } from '../formatters/result.js';
import { BREAKS, HOSTILE_VALUES, splitPhysicalLines, unescapedPipeCount } from './helpers/lines.js';

const FORGED = BREAKS.map(([name, br]) => `forged-${name}${br}## Forged`);

describe('markdownTable with hostile headers and cells', () => {
  const headers = ['a|b', ...FORGED.slice(0, 2), 'plain'];
  const rows: string[][] = HOSTILE_VALUES.map((v, i) => [v, HOSTILE_VALUES[(i + 1) % HOSTILE_VALUES.length] ?? '', `row ${String(i)}`, v]);
  const out = markdownTable(headers.map(header => ({ header })), rows);
  const lines = splitPhysicalLines(out);

  it('emits exactly header + delimiter + one line per row', () => {
    expect(lines).toHaveLength(rows.length + 2);
  });

  it('keeps every line a well-formed row with columns + 1 structural pipes', () => {
    for (const line of lines) {
      expect(line.startsWith('| ')).toBe(true);
      expect(line.endsWith(' |')).toBe(true);
      expect(unescapedPipeCount(line)).toBe(headers.length + 1);
    }
  });

  it('pads every line to the same length (widths computed after escaping)', () => {
    const lengths = new Set(lines.map(l => l.length));
    expect(lengths.size).toBe(1);
  });

  it('keeps the payload words', () => {
    for (const word of ['bob', 'Forged', 'bell', 'trailing', 'slash', 'plain']) {
      expect(out).toContain(word);
    }
  });

  it('escapes right- and center-aligned columns too', () => {
    const aligned = markdownTable(
      [{ header: 'r|h', align: 'right' }, { header: 'c', align: 'center' }],
      [['x\ny', 'p|q'], ['1', '2']],
    );
    const alignedLines = splitPhysicalLines(aligned);
    expect(alignedLines).toHaveLength(4);
    for (const line of alignedLines) expect(unescapedPipeCount(line)).toBe(3);
  });
});

describe('formatAsMarkdown with hostile titles, meta, notes and footers', () => {
  const payload = (where: string): string => `${where}\n## Forged ${where}`;
  const result: StructuredResult = {
    title: payload('title'),
    meta: [
      { label: payload('label'), value: payload('value') },
      { label: 'Total', value: 12.5, type: 'currency' },
    ],
    notes: [payload('note'), `unicode${String.fromCharCode(0x2028)}## Forged unicode`],
    tables: [
      {
        title: payload('table title'),
        columns: [{ key: 'k', header: 'Key' }, { key: 'v', header: 'Value', type: 'currency' }],
        rows: [['a', 1], [payload('cell'), 2]],
        footer: payload('footer'),
      },
      {
        columns: [{ key: 'k', header: 'Key' }],
        rows: [['z']],
        footer: truncateFooter(3, 42),
      },
    ],
  };
  const out = formatAsMarkdown(result);
  const lines = splitPhysicalLines(out);

  it('never lets a value start its own line', () => {
    expect(lines.filter(l => l.startsWith('## Forged'))).toEqual([]);
    expect(lines.filter(l => l.startsWith('## '))).toHaveLength(1);
  });

  it('keeps the payload text on the line it belongs to', () => {
    expect(lines.some(l => l.startsWith('## title') && l.includes('## Forged title'))).toBe(true);
    expect(lines.some(l => l.startsWith('### table title') && l.includes('Forged table title'))).toBe(true);
    expect(lines.some(l => l.startsWith('**label') && l.includes('Forged value'))).toBe(true);
  });

  it('keeps an empty line before each footer', () => {
    const hostileFooter = lines.findIndex(l => l.startsWith('footer'));
    expect(hostileFooter).toBeGreaterThan(0);
    expect(lines[hostileFooter - 1]).toBe('');
    const truncation = lines.findIndex(l => l.startsWith('*...and 3 more'));
    expect(truncation).toBeGreaterThan(0);
    expect(lines[truncation - 1]).toBe('');
  });

  it('leaves the table rows intact', () => {
    const rowLines = lines.filter(l => l.startsWith('| '));
    // 2 tables: (header + delimiter + 2 rows) + (header + delimiter + 1 row)
    expect(rowLines).toHaveLength(7);
    for (const line of rowLines.slice(0, 4)) expect(unescapedPipeCount(line)).toBe(3);
  });
});
