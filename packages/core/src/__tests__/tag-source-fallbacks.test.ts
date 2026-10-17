import { describe, expect, it } from 'vitest';
import { describeTagSource, hasTagSource, tagDimColumn, tagSourceKey } from '../types/branded.js';

// An editor draft can hold a tag dimension with no key yet: no resource tag
// name and no account source (a saved config always has one).
describe('tag dimensions with no source yet', () => {
  it.each([
    ['no fields', {}],
    ['an empty tag name', { tagName: '' }],
    ['an empty account source', { accountTagFallback: '' }],
  ])('are described as an empty account tag when they have %s', (_label, tag) => {
    expect(describeTagSource(tag)).toBe('account tag ""');
  });

  it('derive the placeholder id tag_unknown', () => {
    expect(tagSourceKey({})).toBe('unknown');
    expect(tagSourceKey({ tagName: '', accountTagFallback: '' })).toBe('unknown');
    expect(tagDimColumn({})).toBe('tag_unknown');
  });

  it('report no source', () => {
    expect(hasTagSource({})).toBe(false);
    expect(hasTagSource({ tagName: '', accountTagFallback: '' })).toBe(false);
    expect(hasTagSource({ accountTagFallback: 'Owner' })).toBe(true);
  });
});
