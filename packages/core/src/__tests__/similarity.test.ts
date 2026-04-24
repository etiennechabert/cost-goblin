import { describe, it, expect } from 'vitest';
import {
  normalizeForPatternMatching,
  isCaseVariation,
  isSeparatorVariation,
  isPotentialAbbreviation,
  hasPatternMatch,
  similarity,
  isSimilar,
  findSimilar,
  clusterBySimilarity,
  generateAliasSuggestions,
  type AliasSuggestion,
} from '../normalize/similarity.js';

describe('normalizeForPatternMatching', () => {
  it('converts to lowercase', () => {
    expect(normalizeForPatternMatching('PRODUCTION')).toBe('production');
    expect(normalizeForPatternMatching('Prod')).toBe('prod');
  });

  it('removes hyphens', () => {
    expect(normalizeForPatternMatching('core-banking')).toBe('corebanking');
  });

  it('removes underscores', () => {
    expect(normalizeForPatternMatching('core_banking')).toBe('corebanking');
  });

  it('removes spaces', () => {
    expect(normalizeForPatternMatching('core banking')).toBe('corebanking');
  });

  it('removes multiple separators', () => {
    expect(normalizeForPatternMatching('core-_- banking')).toBe('corebanking');
  });

  it('handles mixed case and separators', () => {
    expect(normalizeForPatternMatching('Core-Banking_System')).toBe('corebankingsystem');
  });

  it('handles empty string', () => {
    expect(normalizeForPatternMatching('')).toBe('');
  });
});

describe('isCaseVariation', () => {
  it('returns true for exact match', () => {
    expect(isCaseVariation('prod', 'prod')).toBe(true);
  });

  it('returns true for case variations', () => {
    expect(isCaseVariation('prod', 'PROD')).toBe(true);
    expect(isCaseVariation('prod', 'Prod')).toBe(true);
    expect(isCaseVariation('PRODUCTION', 'production')).toBe(true);
  });

  it('returns false for different strings', () => {
    expect(isCaseVariation('prod', 'production')).toBe(false);
    expect(isCaseVariation('staging', 'development')).toBe(false);
  });

  it('returns false for separator variations', () => {
    expect(isCaseVariation('core-banking', 'core_banking')).toBe(false);
  });

  it('handles empty strings', () => {
    expect(isCaseVariation('', '')).toBe(true);
    expect(isCaseVariation('prod', '')).toBe(false);
  });
});

describe('isSeparatorVariation', () => {
  it('returns true for exact match', () => {
    expect(isSeparatorVariation('prod', 'prod')).toBe(true);
  });

  it('returns true for separator variations', () => {
    expect(isSeparatorVariation('core-banking', 'core_banking')).toBe(true);
    expect(isSeparatorVariation('core-banking', 'corebanking')).toBe(true);
    expect(isSeparatorVariation('core banking', 'core-banking')).toBe(true);
  });

  it('returns true for separator and case variations', () => {
    expect(isSeparatorVariation('CoreBanking', 'core-banking')).toBe(true);
    expect(isSeparatorVariation('CORE_BANKING', 'core-banking')).toBe(true);
  });

  it('returns false for different strings', () => {
    expect(isSeparatorVariation('prod', 'production')).toBe(false);
    expect(isSeparatorVariation('staging', 'development')).toBe(false);
  });

  it('handles empty strings', () => {
    expect(isSeparatorVariation('', '')).toBe(true);
    expect(isSeparatorVariation('prod', '')).toBe(false);
  });
});

describe('isPotentialAbbreviation', () => {
  it('returns false when abbrev is longer or equal', () => {
    expect(isPotentialAbbreviation('prod', 'production')).toBe(false);
    expect(isPotentialAbbreviation('prod', 'prod')).toBe(false);
  });

  it('detects simple prefix abbreviations', () => {
    expect(isPotentialAbbreviation('production', 'prod')).toBe(true);
    expect(isPotentialAbbreviation('staging', 'sta')).toBe(true);
    expect(isPotentialAbbreviation('development', 'dev')).toBe(true);
  });

  it('detects first-letter abbreviations', () => {
    expect(isPotentialAbbreviation('core banking', 'cb')).toBe(true);
    expect(isPotentialAbbreviation('core-banking', 'cb')).toBe(true);
    expect(isPotentialAbbreviation('CoreBanking', 'cb')).toBe(true);
  });

  it('handles camelCase word boundaries', () => {
    expect(isPotentialAbbreviation('CoreBankingSystem', 'cbs')).toBe(true);
  });

  it('handles mixed separators', () => {
    expect(isPotentialAbbreviation('core_banking-system', 'cbs')).toBe(true);
  });

  it('returns false when abbrev does not match', () => {
    expect(isPotentialAbbreviation('production', 'xyz')).toBe(false);
    expect(isPotentialAbbreviation('staging', 'xyz')).toBe(false);
  });

  it('handles empty strings', () => {
    expect(isPotentialAbbreviation('production', '')).toBe(false);
    expect(isPotentialAbbreviation('', 'p')).toBe(false);
  });

  it('is case insensitive', () => {
    expect(isPotentialAbbreviation('PRODUCTION', 'prod')).toBe(true);
    expect(isPotentialAbbreviation('production', 'PROD')).toBe(true);
  });
});

describe('hasPatternMatch', () => {
  it('returns true for exact match', () => {
    expect(hasPatternMatch('prod', 'prod')).toBe(true);
  });

  it('returns true for case variation', () => {
    expect(hasPatternMatch('prod', 'PROD')).toBe(true);
  });

  it('returns true for separator variation', () => {
    expect(hasPatternMatch('core-banking', 'core_banking')).toBe(true);
  });

  it('returns true for abbreviation (both directions)', () => {
    expect(hasPatternMatch('production', 'prod')).toBe(true);
    expect(hasPatternMatch('prod', 'production')).toBe(true);
  });

  it('returns false when no pattern matches', () => {
    expect(hasPatternMatch('staging', 'development')).toBe(false);
    expect(hasPatternMatch('prod', 'xyz')).toBe(false);
  });
});

describe('similarity', () => {
  it('returns 1 for identical strings', () => {
    expect(similarity('prod', 'prod')).toBe(1);
    expect(similarity('production', 'production')).toBe(1);
  });

  it('returns 0 for empty strings', () => {
    expect(similarity('', '')).toBe(1); // Empty strings are identical
    expect(similarity('prod', '')).toBe(0);
    expect(similarity('', 'prod')).toBe(0);
  });

  it('returns high score for similar strings', () => {
    const score = similarity('production', 'produktion');
    expect(score).toBeGreaterThan(0.8);
  });

  it('returns low score for different strings', () => {
    const score = similarity('production', 'staging');
    expect(score).toBeLessThan(0.5);
  });

  it('normalizes by longer string length', () => {
    // "prod" vs "production" - 6 edits (add "uction") / 10 chars = 0.4
    const score = similarity('prod', 'production');
    expect(score).toBe(0.4);
  });

  it('is symmetric', () => {
    const score1 = similarity('prod', 'production');
    const score2 = similarity('production', 'prod');
    expect(score1).toBe(score2);
  });
});

describe('isSimilar', () => {
  it('returns true for identical strings', () => {
    expect(isSimilar('prod', 'prod')).toBe(true);
  });

  it('returns true for pattern matches regardless of threshold', () => {
    expect(isSimilar('prod', 'PROD', 0.9)).toBe(true);
    expect(isSimilar('core-banking', 'core_banking', 0.9)).toBe(true);
  });

  it('returns true when similarity exceeds threshold', () => {
    expect(isSimilar('production', 'produktion', 0.8)).toBe(true);
  });

  it('returns false when similarity below threshold', () => {
    expect(isSimilar('production', 'staging', 0.8)).toBe(false);
  });

  it('respects custom threshold', () => {
    // "prod" is detected as abbreviation of "production", so it matches via pattern
    expect(isSimilar('prod', 'production', 0.3)).toBe(true);
    expect(isSimilar('prod', 'production', 0.5)).toBe(true); // Pattern match overrides threshold
    // Use different strings that don't have pattern matches
    expect(isSimilar('apple', 'apples', 0.9)).toBe(true);
    expect(isSimilar('apple', 'orange', 0.9)).toBe(false);
  });

  it('throws on invalid threshold', () => {
    expect(() => isSimilar('a', 'b', -0.1)).toThrow(RangeError);
    expect(() => isSimilar('a', 'b', 1.1)).toThrow(RangeError);
  });

  it('accepts threshold at boundaries', () => {
    expect(isSimilar('a', 'b', 0)).toBeDefined();
    expect(isSimilar('a', 'b', 1)).toBeDefined();
  });
});

describe('findSimilar', () => {
  const values = ['prod', 'PROD', 'production', 'staging', 'stg', 'development', 'dev'];

  it('finds case variations with perfect score', () => {
    const results = findSimilar('prod', values);
    const prodMatch = results.find(([v]) => v === 'PROD');
    expect(prodMatch).toBeDefined();
    expect(prodMatch?.[1]).toBe(1.0);
  });

  it('finds abbreviations with perfect score', () => {
    const results = findSimilar('production', values);
    const prodMatch = results.find(([v]) => v === 'prod');
    expect(prodMatch).toBeDefined();
    expect(prodMatch?.[1]).toBe(1.0);
  });

  it('excludes the target value itself', () => {
    const results = findSimilar('prod', values);
    expect(results.find(([v]) => v === 'prod')).toBeUndefined();
  });

  it('sorts results by descending score', () => {
    const results = findSimilar('prod', values);
    for (let i = 1; i < results.length; i++) {
      const prevScore = results[i - 1]?.[1] ?? 0;
      const currScore = results[i]?.[1] ?? 0;
      expect(prevScore).toBeGreaterThanOrEqual(currScore);
    }
  });

  it('respects threshold', () => {
    const results = findSimilar('prod', values, 0.9);
    const productionMatch = results.find(([v]) => v === 'production');
    // "production" should not match "prod" at 0.9 threshold unless it's a pattern match
    expect(productionMatch?.[1]).toBe(1.0); // It's an abbreviation, so perfect score
  });

  it('returns empty array when no matches', () => {
    const results = findSimilar('xyz', values);
    expect(results).toHaveLength(0);
  });

  it('returns empty array for empty values list', () => {
    const results = findSimilar('prod', []);
    expect(results).toHaveLength(0);
  });
});

describe('clusterBySimilarity', () => {
  it('clusters similar values together', () => {
    const values = ['prod', 'PROD', 'production'];
    const clusters = clusterBySimilarity(values);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toEqual(expect.arrayContaining(['prod', 'PROD', 'production']));
  });

  it('sorts cluster by shortest first, then lexicographic', () => {
    const values = ['production', 'PROD', 'prod'];
    const clusters = clusterBySimilarity(values);
    expect(clusters[0]).toBeDefined();
    const cluster = clusters[0] as string[];
    // Shortest first (both PROD and prod are length 4), then lexicographic
    // localeCompare puts "prod" before "PROD" in natural sort order
    expect(cluster[0]).toBe('prod');
    expect(cluster[1]).toBe('PROD');
    expect(cluster[2]).toBe('production');
  });

  it('creates separate clusters for different groups', () => {
    const values = ['prod', 'production', 'dev', 'development'];
    const clusters = clusterBySimilarity(values);
    expect(clusters).toHaveLength(2);
  });

  it('excludes singleton clusters', () => {
    const values = ['prod', 'production', 'unique'];
    const clusters = clusterBySimilarity(values);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toEqual(expect.arrayContaining(['prod', 'production']));
  });

  it('handles transitive similarity', () => {
    // If A~B and B~C, then A, B, C should all be in same cluster
    const values = ['a', 'aa', 'aaa'];
    const clusters = clusterBySimilarity(values, 0.5);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toHaveLength(3);
  });

  it('returns empty array for empty input', () => {
    const clusters = clusterBySimilarity([]);
    expect(clusters).toHaveLength(0);
  });

  it('returns empty array when no clusters found', () => {
    const values = ['a', 'b', 'c'];
    const clusters = clusterBySimilarity(values, 0.9);
    expect(clusters).toHaveLength(0);
  });

  it('respects threshold parameter', () => {
    const values = ['prod', 'production'];
    const highThreshold = clusterBySimilarity(values, 0.9);
    const lowThreshold = clusterBySimilarity(values, 0.3);
    // With high threshold, might not cluster depending on similarity score
    // With low threshold, should cluster
    expect(lowThreshold.length).toBeGreaterThanOrEqual(highThreshold.length);
  });
});

describe('generateAliasSuggestions', () => {
  it('generates suggestions from clusters', () => {
    const values = ['prod', 'PROD', 'production', 'staging', 'stg'];
    const suggestions = generateAliasSuggestions(values);
    expect(suggestions.length).toBeGreaterThan(0);
  });

  it('uses shortest value as canonical', () => {
    const values = ['production', 'prod', 'PROD'];
    const suggestions = generateAliasSuggestions(values);
    expect(suggestions).toHaveLength(1);
    const suggestion = suggestions[0];
    expect(suggestion).toBeDefined();
    // "PROD" and "prod" are both length 4, lexicographic sort puts "prod" first
    expect(suggestion?.canonical).toBe('prod');
  });

  it('includes remaining values as aliases', () => {
    const values = ['prod', 'PROD', 'production'];
    const suggestions = generateAliasSuggestions(values);
    expect(suggestions).toHaveLength(1);
    const suggestion = suggestions[0];
    expect(suggestion).toBeDefined();
    // Canonical is "prod", so aliases are "PROD" and "production"
    expect(suggestion?.aliases).toEqual(expect.arrayContaining(['PROD', 'production']));
  });

  it('creates multiple suggestions for multiple clusters', () => {
    const values = ['prod', 'production', 'staging', 'stg', 'dev', 'development'];
    const suggestions = generateAliasSuggestions(values);
    expect(suggestions.length).toBeGreaterThan(1);
  });

  it('returns empty array when no clusters found', () => {
    const values = ['a', 'b', 'c'];
    const suggestions = generateAliasSuggestions(values, 0.9);
    expect(suggestions).toHaveLength(0);
  });

  it('returns empty array for empty input', () => {
    const suggestions = generateAliasSuggestions([]);
    expect(suggestions).toHaveLength(0);
  });

  it('respects threshold parameter', () => {
    const values = ['prod', 'production'];
    const highThreshold = generateAliasSuggestions(values, 0.9);
    const lowThreshold = generateAliasSuggestions(values, 0.3);
    expect(lowThreshold.length).toBeGreaterThanOrEqual(highThreshold.length);
  });

  it('returns suggestions with correct interface', () => {
    const values = ['prod', 'PROD', 'production'];
    const suggestions = generateAliasSuggestions(values);
    expect(suggestions).toHaveLength(1);
    const suggestion = suggestions[0] as AliasSuggestion;
    expect(suggestion).toHaveProperty('canonical');
    expect(suggestion).toHaveProperty('aliases');
    expect(typeof suggestion.canonical).toBe('string');
    expect(Array.isArray(suggestion.aliases)).toBe(true);
  });
});
