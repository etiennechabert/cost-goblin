import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigValidationError, validateDimensions } from '../config/validator.js';
import { logger } from '../logger/logger.js';
import type { TagDimension } from '../types/config.js';

/** The message of the ConfigValidationError `fn` throws; anything else fails the test. */
function configError(fn: () => unknown): string {
  try {
    fn();
  } catch (err: unknown) {
    if (err instanceof ConfigValidationError) return err.message;
    throw err;
  }
  throw new Error('expected a ConfigValidationError, but nothing was thrown');
}

function onlyTag(raw: Readonly<Record<string, unknown>>): TagDimension {
  const [tag] = validateDimensions({ builtIn: [], tags: [raw] }).tags;
  if (tag === undefined) throw new Error('expected one validated tag');
  return tag;
}

function tagError(raw: Readonly<Record<string, unknown>>): string {
  return configError(() => validateDimensions({ builtIn: [], tags: [raw] }));
}

const team = { tagName: 'team', label: 'Team' };

describe('validateDimensions: tag concepts', () => {
  it.each(['owner', 'product', 'environment', 'unit'])('keeps the %s concept', (concept) => {
    expect(onlyTag({ ...team, concept })).toStrictEqual({ tagName: 'team', label: 'Team', concept });
  });

  it('omits the concept key when the tag has none', () => {
    expect(onlyTag(team)).not.toHaveProperty('concept');
  });

  it('rejects an unknown concept, listing the valid ones', () => {
    expect(tagError({ ...team, concept: 'team' })).toBe("tags[0].concept must be 'owner', 'product', 'environment', or 'unit'");
  });

  it('rejects a non-string concept', () => {
    expect(tagError({ ...team, concept: 1 })).toBe('tags[0].concept must be a string');
  });
});

describe('validateDimensions: tag path segments', () => {
  it('keeps a valid path segment, including -1 for the last segment', () => {
    expect(onlyTag({ ...team, pathSegment: { separator: '/', index: 2 } }).pathSegment).toStrictEqual({ separator: '/', index: 2 });
    expect(onlyTag({ ...team, pathSegment: { separator: ' > ', index: -1 } }).pathSegment).toStrictEqual({ separator: ' > ', index: -1 });
  });

  it('omits the pathSegment key when the tag has none', () => {
    expect(onlyTag(team)).not.toHaveProperty('pathSegment');
  });

  it('rejects an empty separator', () => {
    expect(tagError({ ...team, pathSegment: { separator: '', index: 1 } })).toBe('tags[0].pathSegment.separator must be non-empty');
  });

  it.each([['0', 0], ['a fraction', 1.5]])('rejects an index of %s', (_label, index) => {
    expect(tagError({ ...team, pathSegment: { separator: '/', index } }))
      .toBe('tags[0].pathSegment.index must be a non-zero integer (1-based; -1 = last)');
  });

  it.each([
    ['a non-object path segment', 'a/b', 'tags[0].pathSegment must be an object'],
    ['a non-string separator', { separator: 1, index: 1 }, 'tags[0].pathSegment.separator must be a string'],
    ['a non-numeric index', { separator: '/', index: '1' }, 'tags[0].pathSegment.index must be a number'],
  ])('rejects %s', (_label, pathSegment, message) => {
    expect(tagError({ ...team, pathSegment })).toBe(message);
  });
});

describe('validateDimensions: CUR-era user_ prefix', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('keeps a bare "user_" tag name rather than stripping it to nothing', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    expect(onlyTag({ tagName: 'user_', label: 'User' }).tagName).toBe('user_');
    expect(warn).not.toHaveBeenCalled();
  });

  it('strips the prefix from a longer tag name, with a warning naming both forms', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    expect(onlyTag({ tagName: 'user_cost_center', label: 'Cost center' }).tagName).toBe('cost_center');
    expect(warn).toHaveBeenCalledWith('tags[0].tagName "user_cost_center" carries the CUR-era user_ prefix; migrating to "cost_center"');
  });
});
