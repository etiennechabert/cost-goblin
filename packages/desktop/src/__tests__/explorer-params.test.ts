import { describe, it, expect } from 'vitest';
import {
  parseAggregatedTableParams,
  parseExplorerFilterValuesParams,
  parseExplorerOverviewParams,
  parseExplorerRowsParams,
} from '../main/handlers/explorer-params.js';

// #479: the Explorer handlers cast their `unknown` IPC payload with `as`, so a
// malformed one failed later with a raw TypeError deep in SQL building. They
// now parse it at the handler entry.

const base = {
  filters: { service: ['EC2', 'S3'], tag_team: [] },
  dateRange: { start: '2026-05-01', end: '2026-05-31' },
  granularity: 'daily',
  applyCostScope: true,
  costMetric: 'effective',
  origin: 'widget:table',
};

describe('parseExplorerOverviewParams', () => {
  it('returns a well-formed payload unchanged', () => {
    expect(parseExplorerOverviewParams(base)).toEqual(base);
  });

  it('accepts the minimal payload', () => {
    expect(parseExplorerOverviewParams({ filters: {} })).toEqual({ filters: {} });
  });

  it('keeps valid hour bounds and drops malformed ones', () => {
    const hours = { start: '2026-05-02', end: '2026-05-02', startHour: '2026-05-02 03:00:00', endHour: '2026-05-02 09:00:00' };
    expect(parseExplorerOverviewParams({ filters: {}, dateRange: hours }).dateRange).toEqual(hours);
    const badHour = parseExplorerOverviewParams({ filters: {}, dateRange: { ...hours, endHour: '9am' } });
    expect(badHour.dateRange).toEqual({ start: '2026-05-02', end: '2026-05-02' });
  });

  it('drops a date range whose dates are malformed (the handler then uses its default window)', () => {
    expect(parseExplorerOverviewParams({ filters: {}, dateRange: { start: '2026-13-01', end: '2026-05-31' } }).dateRange).toBeUndefined();
  });

  it.each([
    ['a non-object payload', null],
    ['an array payload', []],
    ['missing filters', {}],
    ['filters that are not string arrays', { filters: { service: 'EC2' } }],
    ['a non-string filter value', { filters: { service: [1] } }],
    ['a dateRange that is not an object', { filters: {}, dateRange: '2026-05' }],
    ['non-string dates', { filters: {}, dateRange: { start: 1, end: 2 } }],
    ['an unknown granularity', { filters: {}, granularity: 'weekly' }],
    ['a non-boolean applyCostScope', { filters: {}, applyCostScope: 'yes' }],
    ['an unknown cost metric', { filters: {}, costMetric: 'amortized' }],
    ['a non-string origin', { filters: {}, origin: 7 }],
  ])('rejects %s', (_label, payload) => {
    expect(() => parseExplorerOverviewParams(payload)).toThrow(TypeError);
  });
});

describe('parseExplorerRowsParams', () => {
  it('parses sort and rowLimit', () => {
    const params = parseExplorerRowsParams({ ...base, sort: { column: 'cost', direction: 'asc' }, rowLimit: 500 });
    expect(params.sort).toEqual({ column: 'cost', direction: 'asc' });
    expect(params.rowLimit).toBe(500);
  });

  it('leaves range clamping to the handler (a non-finite limit falls back to its default)', () => {
    expect(parseExplorerRowsParams({ filters: {}, rowLimit: Number.POSITIVE_INFINITY }).rowLimit).toBe(Number.POSITIVE_INFINITY);
  });

  it.each([
    ['a missing rowLimit', { filters: {} }],
    ['a non-numeric rowLimit', { filters: {}, rowLimit: '500' }],
    ['a null rowLimit', { filters: {}, rowLimit: null }],
    ['a sort without a direction', { filters: {}, rowLimit: 10, sort: { column: 'cost' } }],
    ['an unknown sort direction', { filters: {}, rowLimit: 10, sort: { column: 'cost', direction: 'up' } }],
  ])('rejects %s', (_label, payload) => {
    expect(() => parseExplorerRowsParams(payload)).toThrow(TypeError);
  });
});

describe('parseAggregatedTableParams', () => {
  it('parses group-by columns and row filters', () => {
    const params = parseAggregatedTableParams({
      ...base, groupByColumns: ['service', 'tag_team'], rowLimit: 100, rowFilters: { service: 'EC2' },
    });
    expect(params.groupByColumns).toEqual(['service', 'tag_team']);
    expect(params.rowFilters).toEqual({ service: 'EC2' });
  });

  it.each([
    ['missing groupByColumns', { filters: {}, rowLimit: 10 }],
    ['non-string group-by columns', { filters: {}, rowLimit: 10, groupByColumns: [1] }],
    ['non-string row filter values', { filters: {}, rowLimit: 10, groupByColumns: [], rowFilters: { service: 1 } }],
  ])('rejects %s', (_label, payload) => {
    expect(() => parseAggregatedTableParams(payload)).toThrow(TypeError);
  });
});

describe('parseExplorerFilterValuesParams', () => {
  it('parses the dimension id alongside the shared fields', () => {
    const params = parseExplorerFilterValuesParams({ ...base, dimensionId: 'service' });
    expect(params.dimensionId).toBe('service');
    expect(params.filters).toEqual(base.filters);
    expect(params.dateRange).toEqual(base.dateRange);
  });

  it('rejects a missing dimension id', () => {
    expect(() => parseExplorerFilterValuesParams({ filters: {} })).toThrow(TypeError);
  });
});
