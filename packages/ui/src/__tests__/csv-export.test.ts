import { describe, it, expect } from 'vitest';
import { asEntityRef, asDollars } from '@costgoblin/core/browser';
import type { CostRow } from '@costgoblin/core/browser';
import { buildCsv, escapeCell } from '../components/csv-export.js';
import { escapeCsv } from '../components/table-csv-export.js';

describe('escapeCell (cost CSV export)', () => {
  it('neutralises spreadsheet formula triggers by prefixing a quote', () => {
    for (const trigger of ['=', '+', '-', '@', '\t', '\r']) {
      const result = escapeCell(`${trigger}cmd`);
      // The neutralised value must no longer start with the trigger character.
      const unquoted = result.startsWith('"') ? result.slice(1, -1) : result;
      expect(unquoted.startsWith("'")).toBe(true);
      expect(unquoted[1]).toBe(trigger);
    }
  });

  it('leaves benign values untouched', () => {
    expect(escapeCell('AmazonEC2')).toBe('AmazonEC2');
    expect(escapeCell('team-a')).toBe('team-a'); // internal hyphen is fine
  });

  it('still quotes commas, quotes and newlines', () => {
    expect(escapeCell('a,b')).toBe('"a,b"');
    expect(escapeCell('a"b')).toBe('"a""b"');
    expect(escapeCell('a\nb')).toBe('"a\nb"');
  });

  it('quotes and neutralises a value that is both a formula and contains a comma', () => {
    expect(escapeCell('=1,2')).toBe('"\'=1,2"');
  });
});

describe('buildCsv', () => {
  function row(entity: string, total: number, services: Record<string, number>): CostRow {
    const serviceCosts: Record<string, ReturnType<typeof asDollars>> = {};
    for (const [k, v] of Object.entries(services)) serviceCosts[k] = asDollars(v);
    return { entity: asEntityRef(entity), totalCost: asDollars(total), serviceCosts };
  }

  it('neutralises a malicious entity value in the output', () => {
    const csv = buildCsv(
      [row('=HYPERLINK("http://evil","x")', 10, { AmazonEC2: 10 })],
      ['AmazonEC2'],
    );
    // The dangerous cell is present but defused: no data line starts a formula.
    const lines = csv.split('\n');
    for (const line of lines) {
      expect(line.startsWith('=')).toBe(false);
    }
    expect(csv).toContain("'=HYPERLINK");
  });
});

describe('escapeCsv (table CSV export)', () => {
  it('neutralises formula triggers on string cells', () => {
    expect(escapeCsv('=1+1')).toBe("'=1+1");
    expect(escapeCsv('@SUM(A1)')).toBe("'@SUM(A1)");
  });

  it('does not prefix numeric cells (a negative number is not a formula)', () => {
    expect(escapeCsv(-12.5)).toBe('-12.5');
    expect(escapeCsv(42)).toBe('42');
  });

  it('returns empty string for null/undefined', () => {
    expect(escapeCsv(null)).toBe('');
    expect(escapeCsv(undefined)).toBe('');
  });
});
