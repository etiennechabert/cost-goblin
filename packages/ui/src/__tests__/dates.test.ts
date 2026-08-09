import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { daysBetween, daysAgo, getThisMonth, getLastMonth, getCurrentQuarter, getLastQuarter, getYTD } from '../lib/dates.js';

describe('daysBetween', () => {
  it('calculates inclusive days between dates', () => {
    expect(daysBetween('2024-01-01', '2024-01-01')).toBe(1);
    expect(daysBetween('2024-01-01', '2024-01-31')).toBe(31);
    expect(daysBetween('2024-01-01', '2024-12-31')).toBe(366); // 2024 is leap year
  });
});

describe('daysAgo', () => {
  it('calculates date N days ago', () => {
    const result = daysAgo(7);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('getThisMonth', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    { name: 'returns current month start and end', now: '2024-03-15', expectedStart: '2024-03-01', expectedEnd: '2024-03-31' },
    { name: 'handles February in leap year', now: '2024-02-15', expectedStart: '2024-02-01', expectedEnd: '2024-02-29' },
    { name: 'handles February in non-leap year', now: '2023-02-15', expectedStart: '2023-02-01', expectedEnd: '2023-02-28' },
  ])('$name', ({ now, expectedStart, expectedEnd }) => {
    vi.setSystemTime(new Date(now));
    const { start, end } = getThisMonth();
    expect(start).toBe(expectedStart);
    expect(end).toBe(expectedEnd);
  });
});

describe('getLastMonth', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    { name: 'returns previous month start and end', now: '2024-03-15', expectedStart: '2024-02-01', expectedEnd: '2024-02-29' },
    { name: 'handles December when current is January', now: '2024-01-15', expectedStart: '2023-12-01', expectedEnd: '2023-12-31' },
    { name: 'handles year boundary', now: '2025-01-10', expectedStart: '2024-12-01', expectedEnd: '2024-12-31' },
  ])('$name', ({ now, expectedStart, expectedEnd }) => {
    vi.setSystemTime(new Date(now));
    const { start, end } = getLastMonth();
    expect(start).toBe(expectedStart);
    expect(end).toBe(expectedEnd);
  });
});

describe('getCurrentQuarter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    { name: 'returns Q1 when in Q1', now: '2024-02-15', expectedStart: '2024-01-01', expectedEnd: '2024-03-31' },
    { name: 'returns Q2 when in Q2', now: '2024-05-15', expectedStart: '2024-04-01', expectedEnd: '2024-06-30' },
    { name: 'returns Q3 when in Q3', now: '2024-08-15', expectedStart: '2024-07-01', expectedEnd: '2024-09-30' },
    { name: 'returns Q4 when in Q4', now: '2024-11-15', expectedStart: '2024-10-01', expectedEnd: '2024-12-31' },
  ])('$name', ({ now, expectedStart, expectedEnd }) => {
    vi.setSystemTime(new Date(now));
    const { start, end } = getCurrentQuarter();
    expect(start).toBe(expectedStart);
    expect(end).toBe(expectedEnd);
  });
});

describe('getLastQuarter', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('returns Q4 when in Q1', () => {
    vi.setSystemTime(new Date('2024-02-15'));
    const { start, end } = getLastQuarter();
    expect(start).toBe('2023-10-01');
    expect(end).toBe('2023-12-31');
  });

  it('returns Q1 when in Q2', () => {
    vi.setSystemTime(new Date('2024-05-15'));
    const { start, end } = getLastQuarter();
    expect(start).toBe('2024-01-01');
    expect(end).toBe('2024-03-31');
  });
});

describe('getYTD', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns full current calendar year', () => {
    vi.setSystemTime(new Date('2024-03-15'));
    const { start, end } = getYTD();
    expect(start).toBe('2024-01-01');
    expect(end).toBe('2024-12-31');
  });
});
