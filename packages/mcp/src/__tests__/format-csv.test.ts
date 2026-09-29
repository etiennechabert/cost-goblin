import { describe, expect, it } from 'vitest';
import { formatAsCsv, formatAsJson } from '../formatters/result.js';
import type { Cell, StructuredResult } from '../formatters/result.js';
import { HOSTILE_VALUES, isCsvComment, parseCsvRecord, splitPhysicalLines } from './helpers/lines.js';

describe('formatAsCsv', () => {
  it('handles tables far beyond the spread-argument limit', () => {
    // 200k rows: `lines.push(...tableLines)` would throw RangeError (max call
    // stack) around ~65k spread arguments; the per-line push must not.
    const rows: Cell[][] = Array.from({ length: 200_000 }, (_, i): Cell[] => [`svc-${String(i)}`, i]);
    const result: StructuredResult = {
      title: 'big',
      tables: [{
        columns: [
          { key: 's', header: 'Service' },
          { key: 'n', header: 'N', type: 'number' },
        ],
        rows,
      }],
    };
    const csv = formatAsCsv(result);
    // `# big` + header row + 200k data rows
    expect(csv.split('\n')).toHaveLength(200_002);
  });
});

describe('formatAsCsv with hostile values', () => {
  const rows: Cell[][] = HOSTILE_VALUES.map((v, i): Cell[] => [v, i, `${v},with "quotes"`]);
  const result: StructuredResult = {
    title: 'title\n## Forged title',
    meta: [{ label: 'label\r\nForged', value: 'value\nForged' }],
    notes: [`note${String.fromCharCode(0x2029)}Forged note`],
    tables: [{
      title: 'table\nForged table',
      columns: [
        { key: 'a', header: 'a|b\nForged header' },
        { key: 'n', header: 'N', type: 'number' },
        { key: 'c', header: 'c, "quoted"' },
      ],
      rows,
      footer: '\n*footer\nForged footer*',
    }],
  };
  const csv = formatAsCsv(result);
  const lines = splitPhysicalLines(csv);
  const records = lines.filter(l => !isCsvComment(l));

  it('puts every comment and every record on exactly one physical line', () => {
    // title + meta + note + table title + footer comments; header + one record per row
    expect(lines).toHaveLength(5 + 1 + rows.length);
    expect(records).toHaveLength(1 + rows.length);
  });

  it('keeps every record a complete, 3-field CSV row', () => {
    for (const line of records) {
      const fields = parseCsvRecord(line);
      expect(fields).not.toBeNull();
      expect(fields).toHaveLength(3);
    }
  });

  it('keeps the values recognisable after flattening', () => {
    expect(parseCsvRecord(records[0] ?? '')).toEqual(['a|b\\nForged header', 'N', 'c, "quoted"']);
    expect(parseCsvRecord(records[1] ?? '')).toEqual(['bob | x', '0', 'bob | x,with "quotes"']);
    expect(parseCsvRecord(records[2] ?? '')).toEqual(['payLF\\n## Forged', '1', 'payLF\\n## Forged,with "quotes"']);
  });

  it('keeps formatAsJson exact (raw values round-trip)', () => {
    const parsed: unknown = JSON.parse(formatAsJson(result));
    expect(parsed).toMatchObject({ title: result.title, tables: [{ rows }] });
  });
});
