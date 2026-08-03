import { describe, it, expect } from 'vitest';
import {
  ProviderNameError,
  isValidProviderName,
  parseProviderName,
} from '../config/provider-name.js';

describe('parseProviderName', () => {
  it('accepts simple names and returns them branded', () => {
    expect(String(parseProviderName('aws'))).toBe('aws');
    expect(String(parseProviderName('aws-payer-a'))).toBe('aws-payer-a');
    expect(String(parseProviderName('payer_2'))).toBe('payer_2');
    expect(String(parseProviderName('0team'))).toBe('0team');
  });

  it('rejects the empty string', () => {
    expect(() => parseProviderName('')).toThrow(ProviderNameError);
  });

  it('rejects names longer than 64 characters', () => {
    expect(() => parseProviderName('a'.repeat(65))).toThrow(ProviderNameError);
    expect(() => parseProviderName('a'.repeat(64))).not.toThrow();
  });

  it('rejects path separators, dots, and traversal — the name becomes a directory and a SQL path fragment', () => {
    expect(() => parseProviderName('a/b')).toThrow(ProviderNameError);
    expect(() => parseProviderName('a\\b')).toThrow(ProviderNameError);
    expect(() => parseProviderName('..')).toThrow(ProviderNameError);
    expect(() => parseProviderName('a.b')).toThrow(ProviderNameError);
    expect(() => parseProviderName("a'b")).toThrow(ProviderNameError);
    expect(() => parseProviderName('a b')).toThrow(ProviderNameError);
    expect(() => parseProviderName('a*b')).toThrow(ProviderNameError);
    expect(() => parseProviderName('-leading-dash')).toThrow(ProviderNameError);
  });

  it('rejects Windows reserved device names case-insensitively', () => {
    expect(() => parseProviderName('CON')).toThrow(ProviderNameError);
    expect(() => parseProviderName('con')).toThrow(ProviderNameError);
    expect(() => parseProviderName('Lpt1')).toThrow(ProviderNameError);
  });

  it('rejects reserved layout names (raw, rollup, meta) case-insensitively', () => {
    expect(() => parseProviderName('raw')).toThrow(ProviderNameError);
    expect(() => parseProviderName('Rollup')).toThrow(ProviderNameError);
    expect(() => parseProviderName('META')).toThrow(ProviderNameError);
  });
});

describe('isValidProviderName', () => {
  it('mirrors parseProviderName without throwing', () => {
    expect(isValidProviderName('aws-main')).toBe(true);
    expect(isValidProviderName('raw')).toBe(false);
    expect(isValidProviderName('a/b')).toBe(false);
    expect(isValidProviderName('')).toBe(false);
  });
});
