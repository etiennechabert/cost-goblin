import { describe, expect, it } from 'vitest';
import { parseCursor, encodeCursor, clampPageSize } from '../main/handlers/pagination-utils.js';

describe('parseCursor', () => {
  it('returns 0 for undefined cursor', () => {
    expect(parseCursor(undefined)).toBe(0);
  });

  it('parses valid base64-encoded offset', () => {
    const cursor = encodeCursor(1000);
    expect(parseCursor(cursor)).toBe(1000);
  });

  it('handles zero offset', () => {
    const cursor = encodeCursor(0);
    expect(parseCursor(cursor)).toBe(0);
  });

  it('handles large offsets', () => {
    const cursor = encodeCursor(999999);
    expect(parseCursor(cursor)).toBe(999999);
  });

  it('returns 0 for invalid cursor', () => {
    expect(parseCursor('invalid')).toBe(0);
    expect(parseCursor('')).toBe(0);
    expect(parseCursor('not-base64')).toBe(0);
  });

  it('returns 0 for non-numeric decoded value', () => {
    const invalidCursor = Buffer.from('not-a-number').toString('base64');
    expect(parseCursor(invalidCursor)).toBe(0);
  });

  it('returns 0 for negative decoded value', () => {
    const negativeCursor = encodeCursor(-100);
    const result = parseCursor(negativeCursor);
    // Should clamp negative to 0
    expect(result).toBe(0);
  });
});

describe('encodeCursor', () => {
  it('encodes offset to base64 string', () => {
    const cursor = encodeCursor(500);
    expect(typeof cursor).toBe('string');
    expect(cursor.length).toBeGreaterThan(0);
  });

  it('encodes zero offset', () => {
    const cursor = encodeCursor(0);
    expect(parseCursor(cursor)).toBe(0);
  });

  it('produces different cursors for different offsets', () => {
    const cursor1 = encodeCursor(100);
    const cursor2 = encodeCursor(200);
    expect(cursor1).not.toBe(cursor2);
  });

  it('is reversible with parseCursor', () => {
    const offsets = [0, 1, 10, 100, 1000, 9999];
    for (const offset of offsets) {
      const cursor = encodeCursor(offset);
      expect(parseCursor(cursor)).toBe(offset);
    }
  });
});

describe('clampPageSize', () => {
  it('returns value when within bounds', () => {
    expect(clampPageSize(500, 2000)).toBe(500);
    expect(clampPageSize(1, 2000)).toBe(1);
    expect(clampPageSize(2000, 2000)).toBe(2000);
  });

  it('clamps to 1 when value is less than 1', () => {
    expect(clampPageSize(0, 2000)).toBe(1);
    expect(clampPageSize(-10, 2000)).toBe(1);
    expect(clampPageSize(-1000, 2000)).toBe(1);
  });

  it('clamps to maxSize when value exceeds maximum', () => {
    expect(clampPageSize(3000, 2000)).toBe(2000);
    expect(clampPageSize(10000, 2000)).toBe(2000);
  });

  it('handles edge cases', () => {
    expect(clampPageSize(1000, 1000)).toBe(1000);
    expect(clampPageSize(999, 1000)).toBe(999);
    expect(clampPageSize(1001, 1000)).toBe(1000);
  });

  it('handles non-integer inputs by flooring', () => {
    expect(clampPageSize(500.7, 2000)).toBe(500);
    expect(clampPageSize(1.9, 2000)).toBe(1);
    expect(clampPageSize(2000.1, 2000)).toBe(2000);
  });
});
