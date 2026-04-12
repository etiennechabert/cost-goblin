import { describe, expect, it } from 'vitest';

// Mirror of toStr from ipc.ts — kept in sync to test the conversion logic
function toStr(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object' && 'toString' in v) return (v as { toString(): string }).toString();
  return '';
}

class FakeDuckDBDateValue {
  readonly days: number;
  constructor(days: number) { this.days = days; }
  toString(): string {
    const epoch = new Date(1970, 0, 1);
    epoch.setDate(epoch.getDate() + this.days);
    return `${String(epoch.getFullYear())}-${String(epoch.getMonth() + 1).padStart(2, '0')}-${String(epoch.getDate()).padStart(2, '0')}`;
  }
}

describe('toStr', () => {
  it('handles strings', () => {
    expect(toStr('2026-04-01')).toBe('2026-04-01');
  });

  it('handles numbers', () => {
    expect(toStr(42)).toBe('42');
  });

  it('handles JS Date objects', () => {
    expect(toStr(new Date('2026-04-01'))).toBe('2026-04-01');
  });

  it('handles DuckDB date-like objects with toString()', () => {
    const duckDate = new FakeDuckDBDateValue(20544);
    expect(toStr(duckDate)).toBe('2026-04-01');
  });

  it('returns empty for null/undefined', () => {
    expect(toStr(null)).toBe('');
    expect(toStr(undefined)).toBe('');
  });
});
