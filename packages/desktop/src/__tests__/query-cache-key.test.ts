import { describe, it, expect } from 'vitest';
import { preparedQueryKey } from '../main/query-cache-key.js';

describe('preparedQueryKey', () => {
  it('keys a bigint-free param list exactly as JSON.stringify(params) did', () => {
    const params = ['2026-01-01', 42, 3.5, true, null, undefined, { a: [1, 'x'] }, 'a,b"c'];
    expect(preparedQueryKey('SELECT 1', params)).toBe(`SELECT 1\0${JSON.stringify(params)}`);
  });

  it('keys a bigint param instead of throwing', () => {
    expect(preparedQueryKey('SELECT $1', [2n ** 63n])).toBe('SELECT $1\0[9223372036854775808n]');
  });

  it('keeps a bigint apart from the same digits as a number or a string', () => {
    const keys = new Set([
      preparedQueryKey('q', [5n]),
      preparedQueryKey('q', [5]),
      preparedQueryKey('q', ['5']),
      preparedQueryKey('q', ['5n']),
    ]);
    expect(keys.size).toBe(4);
  });
});
