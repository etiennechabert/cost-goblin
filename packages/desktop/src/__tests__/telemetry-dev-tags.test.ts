import { describe, it, expect } from 'vitest';
import { buildDevTags, readDevTagsSync } from '../main/telemetry/dev-tags.js';

describe('buildDevTags', () => {
  it('includes trimmed branch and commit when present', () => {
    expect(buildDevTags('feature/x\n', 'abc1234\n')).toStrictEqual({ branch: 'feature/x', commit: 'abc1234' });
  });

  it('drops a detached HEAD branch but keeps the commit', () => {
    expect(buildDevTags('HEAD', 'abc1234')).toStrictEqual({ commit: 'abc1234' });
  });

  it('returns no tags when both are empty or null', () => {
    expect(buildDevTags(null, null)).toStrictEqual({});
    expect(buildDevTags('', '  ')).toStrictEqual({});
  });
});

describe('readDevTagsSync', () => {
  it('returns no tags for a packaged build (never shells out to git)', () => {
    expect(readDevTagsSync(true, '/does/not/exist')).toStrictEqual({});
  });
});
