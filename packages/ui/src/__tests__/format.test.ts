import { describe, it, expect } from 'vitest';
import { formatBytes, formatDollars, formatRelativeTime } from '../components/format.js';

describe('formatDollars', () => {
  it('shows cents with thousands separators under $1,000, and one decimal of k or M above', () => {
    expect(formatDollars(0)).toBe('$0.00');
    expect(formatDollars(0.004)).toBe('$0.00');
    expect(formatDollars(0.006)).toBe('$0.01');
    expect(formatDollars(12.5)).toBe('$12.50');
    expect(formatDollars(999.99)).toBe('$999.99');
    expect(formatDollars(1_000)).toBe('$1.0k');
    expect(formatDollars(42_300.5)).toBe('$42.3k');
    expect(formatDollars(999_999)).toBe('$1000.0k');
    expect(formatDollars(1_000_000)).toBe('$1.0M');
    expect(formatDollars(12_345_678)).toBe('$12.3M');
  });

  it('puts the sign of a credit after the dollar sign', () => {
    expect(formatDollars(-12.5)).toBe('$-12.50');
    expect(formatDollars(-1_500)).toBe('$-1.5k');
    expect(formatDollars(-2_500_000)).toBe('$-2.5M');
  });

  it('keeps the sign of a credit that rounds to nothing, and of a negative zero', () => {
    expect(formatDollars(-0.001)).toBe('$-0.00');
    expect(formatDollars(-0)).toBe('$-0.00');
  });

  it('rounds an amount just under $1,000 up to it, with its separator', () => {
    expect(formatDollars(999.994)).toBe('$999.99');
    expect(formatDollars(999.996)).toBe('$1,000.00');
    expect(formatDollars(999.999)).toBe('$1,000.00');
    expect(formatDollars(-999.999)).toBe('$-1,000.00');
  });

  it('spells out what is not a finite amount', () => {
    expect(formatDollars(Number.NaN)).toBe('$NaN');
    expect(formatDollars(Number.POSITIVE_INFINITY)).toBe('$InfinityM');
    expect(formatDollars(Number.NEGATIVE_INFINITY)).toBe('$-InfinityM');
  });

  // The formatter is built once for the module, where each call used to build
  // its own through toLocaleString: the text has to be the one that gave.
  it('formats every amount under $1,000 as toLocaleString with two decimals does', () => {
    const viaLocaleString = (amount: number): string =>
      `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const amounts = [0, -0, Number.NaN, Number.MIN_VALUE, -Number.MIN_VALUE, 1e-7, 0.005, 0.015, 0.045, 1.005, 2.675, 999.985, 999.995, 999.9949999];
    for (let cents = 1; cents < 100_000; cents += 37) {
      amounts.push(cents / 100, -cents / 100, cents / 100 + 0.004999, cents / 1000);
    }
    for (const amount of amounts) {
      expect(formatDollars(amount), String(amount)).toBe(viaLocaleString(amount));
    }
  });
});

describe('formatBytes', () => {
  it('formats within each unit with sensible precision', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(5_000_000)).toBe('4.8 MB');
    expect(formatBytes(1_500_000)).toBe('1.4 MB');
    // Large values within a unit drop the decimal.
    expect(formatBytes(150 * 1024 * 1024)).toBe('150 MB');
  });

  it('rolls over to the next unit instead of rendering "1024 MB"', () => {
    // Just under 1 GiB rounds up at MB precision — must promote to GB.
    expect(formatBytes(1024 * 1024 * 1024 - 1)).toBe('1.0 GB');
    expect(formatBytes(1024)).toBe('1.0 KB');
  });

  it('never returns a negative size', () => {
    expect(formatBytes(-100)).toBe('0 B');
  });
});

describe('formatRelativeTime', () => {
  const now = new Date('2026-06-26T12:00:00.000Z').getTime();

  it('shows "just now" within the last 45 seconds', () => {
    expect(formatRelativeTime('2026-06-26T11:59:30.000Z', now)).toBe('just now');
    expect(formatRelativeTime(new Date('2026-06-26T12:00:00.000Z'), now)).toBe('just now');
  });

  it('shows minutes / hours / days for recent times', () => {
    expect(formatRelativeTime('2026-06-26T11:30:00.000Z', now)).toBe('30m ago');
    expect(formatRelativeTime('2026-06-26T09:00:00.000Z', now)).toBe('3h ago');
    expect(formatRelativeTime('2026-06-24T12:00:00.000Z', now)).toBe('2d ago');
  });

  it('falls back to an absolute date beyond a week', () => {
    const out = formatRelativeTime('2026-05-01T12:00:00.000Z', now);
    expect(out).not.toMatch(/ago/);
    expect(out).toContain('2026');
  });

  it('returns an empty string for an unparseable value', () => {
    expect(formatRelativeTime('not-a-date', now)).toBe('');
  });
});
