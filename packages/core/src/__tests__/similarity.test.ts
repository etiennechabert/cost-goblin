import { describe, it, expect } from 'vitest';
import { generateAliasSuggestions, type AliasSuggestion } from '../normalize/similarity.js';

describe('generateAliasSuggestions', () => {
  it('clusters case and separator variations', () => {
    const suggestions = generateAliasSuggestions(['prod', 'PROD', 'production']);
    expect(suggestions).toHaveLength(1);
    const s = suggestions[0] as AliasSuggestion;
    expect(s.canonical).toBe('prod');
    expect(s.aliases).toEqual(expect.arrayContaining(['PROD', 'production']));
  });

  it('creates separate clusters for unrelated values', () => {
    const suggestions = generateAliasSuggestions(['prod', 'production', 'dev', 'development']);
    expect(suggestions).toHaveLength(2);
  });

  it('detects prefix abbreviations', () => {
    const suggestions = generateAliasSuggestions(['staging', 'sta']);
    expect(suggestions).toHaveLength(1);
    const s = suggestions[0] as AliasSuggestion;
    expect(s.canonical).toBe('sta');
    expect(s.aliases).toContain('staging');
  });

  it('detects separator variations (hyphen vs underscore)', () => {
    const suggestions = generateAliasSuggestions(['core-banking', 'core_banking']);
    expect(suggestions).toHaveLength(1);
  });

  it('detects first-letter abbreviations', () => {
    const suggestions = generateAliasSuggestions(['core-banking', 'cb']);
    expect(suggestions).toHaveLength(1);
  });

  it('ignores singletons', () => {
    const suggestions = generateAliasSuggestions(['prod', 'production', 'unique']);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.canonical).toBe('prod');
  });

  it('returns empty for empty input', () => {
    expect(generateAliasSuggestions([])).toHaveLength(0);
  });

  it('returns empty when nothing clusters', () => {
    expect(generateAliasSuggestions(['a', 'b', 'c'], 0.9)).toHaveLength(0);
  });

  it('handles 500 values in under 2 seconds', () => {
    const bases = ['production', 'staging', 'development', 'testing', 'core-banking', 'platform', 'data-engineering'];
    const values: string[] = [];
    for (let i = 0; i < 500; i++) {
      const base = bases[i % bases.length];
      if (base === undefined) continue;
      const v = Math.floor(i / bases.length);
      if (v % 4 === 0) values.push(base.toUpperCase());
      else if (v % 4 === 1) values.push(base.replace(/-/g, '_'));
      else if (v % 4 === 2) values.push(base.slice(0, 4));
      else values.push(base);
    }
    const start = performance.now();
    const suggestions = generateAliasSuggestions(values);
    expect(performance.now() - start).toBeLessThan(2000);
    expect(suggestions.length).toBeGreaterThan(0);
  });
});
