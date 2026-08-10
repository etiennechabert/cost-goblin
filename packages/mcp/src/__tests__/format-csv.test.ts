import { describe, expect, it } from 'vitest';
import { formatAsCsv } from '../formatters/result.js';
import type { Cell, StructuredResult } from '../formatters/result.js';

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
