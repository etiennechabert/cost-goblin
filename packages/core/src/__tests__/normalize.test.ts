import { describe, it, expect } from 'vitest';
import {
  applyNormalizationRule,
  normalizeTagValue,
  resolveAlias,
  normalizeAndResolve,
  buildAliasSqlCase,
} from '../normalize/normalize.js';
import type { TagDimension } from '../types/config.js';

describe('applyNormalizationRule', () => {
  it('applies lowercase', () => {
    expect(applyNormalizationRule('Hello World', 'lowercase')).toBe('hello world');
  });

  it('applies uppercase', () => {
    expect(applyNormalizationRule('hello', 'uppercase')).toBe('HELLO');
  });

  it('applies lowercase-kebab', () => {
    expect(applyNormalizationRule('Core_Banking', 'lowercase-kebab')).toBe('core-banking');
    expect(applyNormalizationRule('CoreBanking', 'lowercase-kebab')).toBe('core-banking');
    expect(applyNormalizationRule('core banking', 'lowercase-kebab')).toBe('core-banking');
  });
});

describe('normalizeTagValue', () => {
  it('returns value unchanged when no rule', () => {
    expect(normalizeTagValue('Hello', undefined)).toBe('Hello');
  });

  it('applies rule when provided', () => {
    expect(normalizeTagValue('PROD', 'lowercase')).toBe('prod');
  });
});

describe('resolveAlias', () => {
  const aliases = {
    'core-banking': ['core_banking', 'corebanking'],
    'production': ['prod', 'prd'],
  } as const;

  it('returns canonical when value matches alias', () => {
    expect(resolveAlias('corebanking', aliases)).toBe('core-banking');
    expect(resolveAlias('prod', aliases)).toBe('production');
  });

  it('returns canonical when value is already canonical', () => {
    expect(resolveAlias('core-banking', aliases)).toBe('core-banking');
  });

  it('returns value unchanged when no match', () => {
    expect(resolveAlias('unknown-team', aliases)).toBe('unknown-team');
  });

  it('returns value unchanged when no aliases', () => {
    expect(resolveAlias('anything', undefined)).toBe('anything');
  });
});

describe('normalizeAndResolve', () => {
  const dimension: TagDimension = {
    tagName: 'org:team',
    label: 'Team',
    normalize: 'lowercase-kebab',
    aliases: {
      'core-banking': ['core_banking', 'corebanking'],
    },
  };

  it('normalizes and resolves in one step', () => {
    expect(normalizeAndResolve('CoreBanking', dimension)).toBe('core-banking');
    expect(normalizeAndResolve('core_banking', dimension)).toBe('core-banking');
  });

  it('passes through unknown values after normalization', () => {
    expect(normalizeAndResolve('NewTeam', dimension)).toBe('new-team');
  });
});

describe('buildAliasSqlCase', () => {
  it('returns plain field when no normalization or aliases', () => {
    const dim: TagDimension = { tagName: 'x', label: 'X' };
    expect(buildAliasSqlCase('tag_x', dim)).toBe('tag_x');
  });

  it('wraps field with LOWER for lowercase normalization', () => {
    const dim: TagDimension = { tagName: 'x', label: 'X', normalize: 'lowercase' };
    const result = buildAliasSqlCase('tag_x', dim);
    expect(result).toBe('LOWER(tag_x)');
  });

  it('builds CASE expression for aliases', () => {
    const dim: TagDimension = {
      tagName: 'x',
      label: 'X',
      normalize: 'lowercase',
      aliases: { production: ['prod', 'prd'] },
    };
    const result = buildAliasSqlCase('tag_x', dim);
    expect(result).toContain('CASE');
    expect(result).toContain("'prod'");
    expect(result).toContain("'prd'");
    expect(result).toContain("'production'");
  });
});
