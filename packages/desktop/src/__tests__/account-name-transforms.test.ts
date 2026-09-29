import { afterEach, describe, it, expect, vi } from 'vitest';
import { ConfigValidationError, logger } from '@costgoblin/core';
import { applyAccountNameTransforms } from '../main/handlers/account-name-transforms.js';
import { applyNormalizeAndStrip, NO_STRIP_ISSUES, parsePreviewStripPatterns } from '../main/handlers/dimensions-preview.js';

afterEach(() => { vi.restoreAllMocks(); });

/** Realistic 30–45 character org account names, plus one arbitrarily long
 *  name of the kind a peer-pulled org-accounts.json can carry. */
function peerStyleAccounts(): Map<string, string> {
  const accounts = new Map<string, string>();
  const teams = ['payments', 'search-relevance', 'core-banking', 'data-platform', 'identity-and-access'];
  for (let i = 0; i < 40; i++) {
    const team = teams[i % teams.length] ?? 'team';
    accounts.set(String(100000000000 + i), `acme-${team}-workload-${String(i).padStart(3, '0')} production`);
  }
  accounts.set('999999999999', `${'peer-controlled-'.repeat(31)}name production`);
  return accounts;
}

describe('applyAccountNameTransforms', () => {
  it('returns the input map untouched when there is nothing to apply', () => {
    const raw = new Map([['1', '  Keep   As Is ']]);
    expect(applyAccountNameTransforms(raw, undefined, undefined)).toBe(raw);
    expect(applyAccountNameTransforms(raw, undefined, [])).toBe(raw);
  });

  it('normalizes, then strips, preserving the id → name pairing', () => {
    const raw = new Map([['1', 'Acme-Payments Production'], ['2', 'Acme-Search']]);
    const map = applyAccountNameTransforms(raw, 'lowercase', [String.raw`\s+production$`, '^acme-']);
    expect([...map]).toEqual([['1', 'payments'], ['2', 'search']]);
  });

  it('bounds a catastrophic pattern, still applies the benign one, and warns with the index only', () => {
    const warn = vi.spyOn(logger, 'warn');
    const raw = peerStyleAccounts();
    const longName = raw.get('999999999999') ?? '';
    expect(longName.length).toBeGreaterThanOrEqual(500);

    const started = performance.now();
    const map = applyAccountNameTransforms(raw, undefined, ['((.+)+)+z', String.raw`\s+production$`]);
    expect(performance.now() - started).toBeLessThan(2000);

    expect(map.size).toBe(raw.size);
    expect(map.get('100000000000')).toBe('acme-payments-workload-000');
    expect(map.get('999999999999')?.endsWith('name')).toBe(true);

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toMatch(/slow.*\[0\]/i);
    // Never the pattern text, never an account name.
    expect(message).not.toContain('(.+)+');
    expect(message).not.toContain('production');
    expect(message).not.toContain('acme');
  });

  it('warns about an uncompilable pattern by index and applies the rest', () => {
    const warn = vi.spyOn(logger, 'warn');
    const map = applyAccountNameTransforms(new Map([['1', 'acme-x']]), undefined, ['(unclosed', '^acme-']);
    expect(map.get('1')).toBe('x');
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/invalid.*\[0\]/i);
  });

  it('does not warn when every pattern applies', () => {
    const warn = vi.spyOn(logger, 'warn');
    applyAccountNameTransforms(new Map([['1', 'acme-x']]), undefined, ['^acme-']);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('parsePreviewStripPatterns', () => {
  it('accepts undefined and a string array within the caps', () => {
    expect(parsePreviewStripPatterns(undefined)).toBeUndefined();
    expect(parsePreviewStripPatterns(['^acme-', ''])).toEqual(['^acme-', '']);
  });

  it.each([
    ['a non-array', '^acme-'],
    ['null', null],
    ['an array holding a non-string', ['^acme-', 7]],
    ['17 entries', Array.from({ length: 17 }, (_, i) => `p${String(i)}`)],
    ['a 257-character entry', ['x'.repeat(257)]],
  ])('rejects %s', (_label, value) => {
    expect(() => parsePreviewStripPatterns(value)).toThrow(ConfigValidationError);
  });
});

describe('applyNormalizeAndStrip (editor preview)', () => {
  it('reports no issues and returns the values untouched when there is nothing to apply', () => {
    const values = [{ value: 'A', cost: 1 }];
    expect(applyNormalizeAndStrip(values, 'account_id', undefined)).toEqual({ values, stripIssues: NO_STRIP_ISSUES });
  });

  it('ignores strip patterns for fields other than account_id', () => {
    const values = [{ value: 'acme-x', cost: 1 }];
    const result = applyNormalizeAndStrip(values, 'service', { nameStripPatterns: ['^acme-'] });
    expect(result.values).toEqual(values);
    expect(result.stripIssues).toEqual(NO_STRIP_ISSUES);
  });

  it('merges values that strip to the same label, highest cost first', () => {
    const result = applyNormalizeAndStrip(
      [{ value: 'Acme-A production', cost: 1 }, { value: 'acme-a staging', cost: 2 }, { value: 'acme-b', cost: 5 }],
      'account_id',
      { normalize: 'lowercase', nameStripPatterns: ['^acme-', String.raw`\s+(production|staging)$`] },
    );
    expect(result.values).toEqual([{ value: 'b', cost: 5 }, { value: 'a', cost: 3 }]);
    expect(result.stripIssues).toEqual(NO_STRIP_ISSUES);
  });

  it('reports a slow pattern in stripIssues and still applies the benign one', () => {
    const started = performance.now();
    const result = applyNormalizeAndStrip(
      [{ value: 'acme-payments-production-eu-west-1', cost: 1 }],
      'account_id',
      { nameStripPatterns: ['((.+)+)+zz', '-eu-west-1$'] },
    );
    expect(performance.now() - started).toBeLessThan(1000);
    expect(result.stripIssues.slow).toEqual([0]);
    expect(result.stripIssues.invalid).toEqual([]);
    expect(result.values).toEqual([{ value: 'acme-payments-production', cost: 1 }]);
  });

  it('reports an uncompilable pattern as invalid', () => {
    const result = applyNormalizeAndStrip([{ value: 'x', cost: 1 }], 'account_id', { nameStripPatterns: ['(bad'] });
    expect(result.stripIssues.invalid).toEqual([0]);
  });
});
