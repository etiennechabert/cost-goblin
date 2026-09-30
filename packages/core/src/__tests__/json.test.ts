import { describe, expect, it } from 'vitest';
import { isStringRecord, parseJsonObject, parseJsonObjectFile } from '../utils/json.js';

describe('isStringRecord', () => {
  it('accepts plain objects', () => {
    expect(isStringRecord({})).toBe(true);
    expect(isStringRecord({ a: 1 })).toBe(true);
  });

  it('rejects arrays', () => {
    expect(isStringRecord([])).toBe(false);
    expect(isStringRecord([1, 2, 3])).toBe(false);
  });

  it('rejects null and primitives', () => {
    expect(isStringRecord(null)).toBe(false);
    expect(isStringRecord(undefined)).toBe(false);
    expect(isStringRecord('string')).toBe(false);
    expect(isStringRecord(42)).toBe(false);
    expect(isStringRecord(true)).toBe(false);
  });
});

describe('parseJsonObject', () => {
  it('parses a JSON object', () => {
    const result = parseJsonObject('{"theme":"dark","autoSync":true}');
    expect(result).not.toBeNull();
    expect(result?.['theme']).toBe('dark');
    expect(result?.['autoSync']).toBe(true);
  });

  it('returns null on invalid JSON', () => {
    expect(parseJsonObject('not json')).toBeNull();
    expect(parseJsonObject('')).toBeNull();
  });

  it('returns null when top-level is an array', () => {
    expect(parseJsonObject('[1,2,3]')).toBeNull();
  });

  it('returns null when top-level is null or a primitive', () => {
    expect(parseJsonObject('null')).toBeNull();
    expect(parseJsonObject('"string"')).toBeNull();
    expect(parseJsonObject('42')).toBeNull();
  });
});

describe('parseJsonObjectFile', () => {
  it('reads a file saved with a UTF-8 BOM, which JSON.parse alone rejects', () => {
    expect(parseJsonObject('\uFEFF{"a":1}')).toBeNull();
    expect(parseJsonObjectFile('\uFEFF{"a":1}')).toEqual({ a: 1 });
  });

  it('otherwise behaves as parseJsonObject', () => {
    expect(parseJsonObjectFile('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonObjectFile('[1]')).toBeNull();
    expect(parseJsonObjectFile('{"torn":')).toBeNull();
  });
});
