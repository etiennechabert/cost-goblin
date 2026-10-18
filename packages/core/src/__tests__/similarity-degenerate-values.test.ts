import { describe, it, expect } from 'vitest';
import { generateAliasSuggestions } from '../normalize/similarity.js';

/** Tag values come straight from billing data, so the suggestion engine sees
 *  empty strings, one-letter values, exact duplicates and (from sparse
 *  arrays built by callers) holes. None of them may yield a bogus cluster. */
describe('generateAliasSuggestions on degenerate values', () => {
  it('never treats a single character as an abbreviation, even when it is a prefix', () => {
    expect(generateAliasSuggestions(['production', 'p'])).toEqual([]);
    // One character once separators are stripped is just as short.
    expect(generateAliasSuggestions(['production', 'p_'])).toEqual([]);
    // Two characters are enough for a prefix abbreviation.
    expect(generateAliasSuggestions(['production', 'pr'])).toEqual([{ canonical: 'pr', aliases: ['production'] }]);
  });

  it('does not cluster the empty string with anything', () => {
    expect(generateAliasSuggestions(['', 'x'])).toEqual([]);
    expect(generateAliasSuggestions(['dev', '', 'development'])).toEqual([{ canonical: 'dev', aliases: ['development'] }]);
  });

  it('does not suggest an exact duplicate as an alias of itself', () => {
    expect(generateAliasSuggestions(['prod', 'prod'])).toEqual([]);
    expect(generateAliasSuggestions(['prod', 'prod', 'production'])).toEqual([{ canonical: 'prod', aliases: ['production'] }]);
  });

  it('skips the holes of a sparse value list', () => {
    const values: string[] = ['prod'];
    values[2] = 'production';
    expect(values).toHaveLength(3);
    expect(1 in values).toBe(false);
    expect(generateAliasSuggestions(values)).toEqual([{ canonical: 'prod', aliases: ['production'] }]);
  });

  it('links typo-level edits only under a looser threshold', () => {
    // A transposition is two edits: similarity 1 - 2/8 = 0.75.
    expect(generateAliasSuggestions(['payments', 'paymnets'])).toEqual([]);
    expect(generateAliasSuggestions(['payments', 'paymnets'], 0.75)).toEqual([{ canonical: 'payments', aliases: ['paymnets'] }]);
  });
});
