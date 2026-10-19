import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { awsCliCandidates, findAwsCli } from '../sync/trusted-binaries.js';

/** `findAwsCli` against a faked filesystem, so the answer does not depend on
 *  whether the machine running the suite has the AWS CLI installed. Every
 *  sync suite mocks this function away; this is the one place it runs. */

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(() => false) };
});

describe('findAwsCli', () => {
  beforeEach(() => {
    vi.mocked(existsSync).mockReset();
    vi.mocked(existsSync).mockReturnValue(false);
  });

  it('returns the first trusted install that exists, probing the list in order', () => {
    const candidates = awsCliCandidates();
    const installed = candidates.at(-1);
    if (installed === undefined) throw new Error('no AWS CLI candidates for this platform');
    vi.mocked(existsSync).mockImplementation(path => path === installed);

    expect(findAwsCli()).toBe(installed);
    expect(vi.mocked(existsSync).mock.calls.map(([path]) => path)).toEqual(candidates);
  });

  it('returns null, never a bare `aws`, when no trusted location has it', () => {
    expect(findAwsCli()).toBeNull();
    expect(vi.mocked(existsSync)).toHaveBeenCalledTimes(awsCliCandidates().length);
  });
});
