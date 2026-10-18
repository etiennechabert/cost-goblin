import { describe, expect, it } from 'vitest';
import { formatDelta, formatDollars, formatNumber, formatPercent } from '../formatters/cost.js';
import { markdownTable } from '../formatters/markdown-table.js';
import { dataCoverageBanner, formatAsCsv, formatAsJson, formatAsMarkdown, formatResult } from '../formatters/result.js';
import type { DataCoverage, StructuredResult } from '../formatters/result.js';

// The cell, banner and layout rules of the three response formats, branch by
// branch (the hostile-value cases live in format-markdown / format-csv).

const COVERAGE: DataCoverage = {
  availableMonths: ['2026-01'],
  latestDay: '2026-01-31',
  earliestDay: '2026-01-01',
  lagDays: 3,
  totalDays: 31,
  missingPeriods: [],
  missingInRange: [],
};

describe('dataCoverageBanner', () => {
  it.each([
    ['no synced data', { ...COVERAGE, availableMonths: [] }, '*Data coverage: no synced data found.*'],
    ['the span and a multi-day lag', COVERAGE, '*Data coverage: 2026-01-01 to 2026-01-31 (31 days). Latest day: 2026-01-31 (3 days ago).*'],
    ['a latest day of today', { ...COVERAGE, lagDays: 0 }, '*Data coverage: 2026-01-01 to 2026-01-31 (31 days). Latest day: 2026-01-31 (today).*'],
    ['a one-day lag', { ...COVERAGE, lagDays: 1 }, '*Data coverage: 2026-01-01 to 2026-01-31 (31 days). Latest day: 2026-01-31 (1 day ago).*'],
    ['an unknown lag', { ...COVERAGE, lagDays: null }, '*Data coverage: 2026-01-01 to 2026-01-31 (31 days).*'],
    ['an unknown span', { ...COVERAGE, totalDays: null }, '*Data coverage: Latest day: 2026-01-31 (3 days ago).*'],
    ['an unknown earliest day', { ...COVERAGE, earliestDay: null }, '*Data coverage: Latest day: 2026-01-31 (3 days ago).*'],
    ['gaps outside the requested range', { ...COVERAGE, missingPeriods: ['2025-11', '2025-12'] },
      '*Data coverage: 2026-01-01 to 2026-01-31 (31 days). Latest day: 2026-01-31 (3 days ago). Missing periods: 2025-11, 2025-12.*'],
    ['gaps in the requested range, which win over the others', { ...COVERAGE, missingPeriods: ['2025-12'], missingInRange: ['2026-02'] },
      '*Data coverage: 2026-01-01 to 2026-01-31 (31 days). Latest day: 2026-01-31 (3 days ago). Missing periods in your requested range: 2026-02.*'],
    ['only gaps when the latest day is unknown', { ...COVERAGE, latestDay: null, lagDays: null, totalDays: null, missingPeriods: ['2025-12'] },
      '*Data coverage: Missing periods: 2025-12.*'],
  ])('describes %s', (_label, coverage, banner) => {
    expect(dataCoverageBanner(coverage)).toBe(banner);
  });
});

describe('cost formatters', () => {
  it.each([
    [2_500_000, '$2.50M'], [-2_500_000, '-$2.50M'], [12_345, '$12.3k'], [250, '$250'], [5, '$5.00'],
    [0.5, '$0.50'], [0.004, '$0.0040'], [-0.004, '-$0.0040'], [0, '$0.0000'],
  ])('formatDollars(%s) = %s', (amount, text) => {
    expect(formatDollars(amount)).toBe(text);
  });

  it.each([
    [12.34, '+12.3%'], [-12.34, '-12.3%'], [0, '0.0%'], [150, '+150%'], [-250, '-250%'],
    [Number.POSITIVE_INFINITY, 'N/A'], [Number.NaN, 'N/A'],
  ])('formatPercent(%s) = %s', (pct, text) => {
    expect(formatPercent(pct)).toBe(text);
  });

  it.each([[5, '+$5.00'], [-5, '-$5.00'], [0, '$0.0000']])('formatDelta(%s) = %s', (amount, text) => {
    expect(formatDelta(amount)).toBe(text);
  });

  it.each([[2_500_000, '2.5M'], [1_500, '1.5k'], [12.4, '12'], [999.6, '1000']])('formatNumber(%s) = %s', (n, text) => {
    expect(formatNumber(n)).toBe(text);
  });
});

/** One row per cell type, so each formatter sees a value of its type. */
const TYPED: StructuredResult = {
  title: 'Typed cells',
  meta: [
    { label: 'Plain', value: 'text' },
    { label: 'Count', value: 1500, type: 'number' },
  ],
  notes: [],
  tables: [{
    title: '',
    columns: [
      { key: 'name', header: 'Name' },
      { key: 'cost', header: 'Cost', type: 'currency' },
      { key: 'share', header: 'Share', type: 'percent' },
      { key: 'change', header: 'Change', type: 'change' },
      { key: 'delta', header: 'Delta', type: 'delta' },
      { key: 'n', header: 'N', type: 'number', align: 'center' },
      { key: 'raw', header: 'Raw', type: 'string' },
    ],
    rows: [
      ['a', 1234.5, 12.5, 7.5, -2, 7, 42],
      ['b', 'n/a', Number.POSITIVE_INFINITY, Number.NaN, 3, 1_500_000, null],
      [null, null, null, null, null, null, null],
    ],
    footer: '',
  }],
};

describe('formatAsMarkdown cells and layout', () => {
  const lines = formatAsMarkdown(TYPED).split('\n');

  it('formats each cell by its column type and leaves other values as they are', () => {
    expect(lines).toEqual([
      '## Typed cells',
      '',
      '**Plain**: text',
      '**Count**: 1.5k',
      '',
      '| Name |  Cost | Share | Change |  Delta |  N   | Raw |',
      '| ---- | ----: | ----: | -----: | -----: | :--: | --- |',
      '| a    | $1235 | 12.5% |  +7.5% | -$2.00 |  7   | 42  |',
      '| b    |   n/a |   N/A |    N/A | +$3.00 | 1.5M |     |',
      '|      |       |       |        |        |      |     |',
    ]);
  });

  it('omits an empty table title and an empty footer', () => {
    expect(lines.some(l => l.startsWith('###'))).toBe(false);
    expect(lines.at(-1)).toBe('|      |       |       |        |        |      |     |');
  });

  it('separates consecutive tables with a blank line and renders a footer under its table', () => {
    const out = formatAsMarkdown({
      title: 'Two tables',
      tables: [
        { columns: [{ key: 'a', header: 'A' }], rows: [['1']], footer: '*one more*' },
        { title: 'Second', columns: [{ key: 'b', header: 'B' }], rows: [['2']] },
      ],
    });
    // The delimiter row keeps GFM's minimum of three dashes even for a 1-char column.
    expect(out).toBe('## Two tables\n\n| A |\n| --- |\n| 1 |\n\n*one more*\n\n### Second\n\n| B |\n| --- |\n| 2 |');
  });
});

describe('formatAsJson', () => {
  it('keeps only the title when nothing else is set', () => {
    expect(JSON.parse(formatAsJson({ title: 'Bare' }))).toEqual({ title: 'Bare' });
  });

  it('defaults meta and column types to string, and drops empty notes and footers', () => {
    expect(JSON.parse(formatAsJson(TYPED))).toEqual({
      title: 'Typed cells',
      meta: [
        { label: 'Plain', value: 'text', type: 'string' },
        { label: 'Count', value: 1500, type: 'number' },
      ],
      tables: [{
        title: '',
        columns: [
          { key: 'name', header: 'Name', type: 'string' },
          { key: 'cost', header: 'Cost', type: 'currency' },
          { key: 'share', header: 'Share', type: 'percent' },
          { key: 'change', header: 'Change', type: 'change' },
          { key: 'delta', header: 'Delta', type: 'delta' },
          { key: 'n', header: 'N', type: 'number' },
          { key: 'raw', header: 'Raw', type: 'string' },
        ],
        // Raw values: Infinity and NaN serialize as null in JSON.
        rows: [
          ['a', 1234.5, 12.5, 7.5, -2, 7, 42],
          ['b', 'n/a', null, null, 3, 1_500_000, null],
          [null, null, null, null, null, null, null],
        ],
      }],
    });
  });

  it('keeps notes, a table without a title, and a trimmed footer', () => {
    expect(JSON.parse(formatAsJson({
      title: 'T',
      notes: ['first'],
      tables: [{ columns: [{ key: 'a', header: 'A' }], rows: [], footer: '  *more*  ' }],
      coverage: COVERAGE,
    }))).toEqual({
      title: 'T',
      coverage: COVERAGE,
      notes: ['first'],
      tables: [{ columns: [{ key: 'a', header: 'A', type: 'string' }], rows: [], footer: '*more*' }],
    });
  });
});

describe('formatAsCsv', () => {
  it('writes numbers per type, empty cells for null, and no title line for an untitled table', () => {
    expect(formatAsCsv(TYPED).split('\n')).toEqual([
      '# Typed cells',
      '# Plain: text',
      '# Count: 1.5k',
      'Name,Cost,Share,Change,Delta,N,Raw',
      'a,1234.50,12.50,7.50,-2.00,7,42',
      'b,n/a,Infinity,NaN,3.00,1500000,',
      ',,,,,,',
    ]);
  });

  it('separates tables with a blank line and keeps coverage, notes and footers as comments', () => {
    expect(formatAsCsv({
      title: 'Two tables',
      coverage: { ...COVERAGE, availableMonths: [] },
      notes: ['*heads up*'],
      tables: [
        { title: 'First', columns: [{ key: 'a', header: 'A' }], rows: [['x, y']], footer: '*one more*' },
        { columns: [{ key: 'b', header: 'B' }], rows: [['"q"']] },
      ],
    }).split('\n')).toEqual([
      '# Data coverage: no synced data found.',
      '# Two tables',
      '# *heads up*',
      '# First',
      'A',
      '"x, y"',
      '# one more',
      '',
      'B',
      '"""q"""',
    ]);
  });

  it('is what formatResult returns for csv, as markdown and json are for theirs', () => {
    const result: StructuredResult = { title: 'Same', meta: [{ label: 'X', value: 1 }] };
    expect(formatResult(result, 'csv')).toBe(formatAsCsv(result));
    expect(formatResult(result, 'json')).toBe(formatAsJson(result));
    expect(formatResult(result, 'markdown')).toBe(formatAsMarkdown(result));
  });
});

describe('markdownTable', () => {
  it('pads a short row with empty cells and centres a centre-aligned column', () => {
    expect(markdownTable(
      [{ header: 'Left' }, { header: 'Mid', align: 'center' }, { header: 'Right', align: 'right' }],
      [['a'], ['bb', 'c', 'dd']],
    ).split('\n')).toEqual([
      '| Left | Mid | Right |',
      '| ---- | :-: | ----: |',
      '| a    |     |       |',
      '| bb   |  c  |    dd |',
    ]);
  });
});
