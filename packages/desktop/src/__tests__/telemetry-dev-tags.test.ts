import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDevTags, readDevTagsSync } from '../main/telemetry/dev-tags.js';

// git resolution goes through core's trusted-binary lookup; execFileSync must
// only ever receive the absolute path it returns, never a bare 'git' that the
// inherited PATH would resolve.
const { mockFindGitCli, mockExecFileSync } = vi.hoisted(() => ({
  mockFindGitCli: vi.fn((): string | null => '/trusted/bin/git'),
  mockExecFileSync: vi.fn<(...args: unknown[]) => string>(() => ''),
}));
vi.mock('@costgoblin/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@costgoblin/core')>()),
  findGitCli: mockFindGitCli,
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync: mockExecFileSync,
}));

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
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns no tags for a packaged build (never shells out to git)', () => {
    expect(readDevTagsSync(true, '/does/not/exist')).toStrictEqual({});
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('runs the trusted absolute git path, never a PATH-resolved bare name', () => {
    mockExecFileSync
      .mockReturnValueOnce('feature/x\n')
      .mockReturnValueOnce('abc1234\n');

    expect(readDevTagsSync(false, '/repo')).toStrictEqual({ branch: 'feature/x', commit: 'abc1234' });

    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
    for (const call of mockExecFileSync.mock.calls) {
      expect(call[0]).toBe('/trusted/bin/git');
    }
  });

  it('returns no tags when git has no trusted install — no bare-name fallback', () => {
    // Once per gitOut call (branch, then commit); the vi.fn default
    // implementation resumes afterwards, matching the sibling sync suites.
    mockFindGitCli.mockReturnValueOnce(null).mockReturnValueOnce(null);
    expect(readDevTagsSync(false, '/repo')).toStrictEqual({});
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });
});
