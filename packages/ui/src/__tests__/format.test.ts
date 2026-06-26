import { describe, it, expect } from 'vitest';
import { formatBytes, formatRelativeTime } from '../components/format.js';

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
