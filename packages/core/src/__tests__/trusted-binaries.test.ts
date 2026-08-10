import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import {
  awsCliCandidates,
  findTrustedBinary,
  gcloudCliCandidates,
  gcloudSearchPaths,
  ghCliCandidates,
  gitCliCandidates,
} from '../sync/trusted-binaries.js';

describe('findTrustedBinary', () => {
  let dir: string;
  // The resolver caches hits per binary name for the life of the process, so
  // every case probes under its own name to stay independent.
  let caseNo = 0;
  const uniqueName = (): string => `test-bin-${String(++caseNo)}-${String(process.pid)}`;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'trusted-bin-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns the first candidate that exists on disk', async () => {
    await writeFile(join(dir, 'second'), '');
    await writeFile(join(dir, 'third'), '');
    const found = findTrustedBinary(uniqueName(), [
      join(dir, 'missing'),
      join(dir, 'second'),
      join(dir, 'third'),
    ]);
    expect(found).toBe(join(dir, 'second'));
  });

  it('returns null when no candidate exists — the caller disables the feature', () => {
    expect(findTrustedBinary(uniqueName(), [join(dir, 'nope'), join(dir, 'also-nope')])).toBeNull();
  });

  it('never resolves a relative candidate, even one that exists from the CWD', () => {
    // `join('', ...)` — a Windows env var being unset — yields a RELATIVE
    // path, which existsSync would probe against whatever directory the app
    // was launched from. 'package.json' exists relative to the repo CWD the
    // tests run in; a trusted lookup must still refuse it.
    expect(findTrustedBinary(uniqueName(), ['package.json'])).toBeNull();
  });

  it('caches a hit: the path keeps being returned after the file is gone', async () => {
    const name = uniqueName();
    const bin = join(dir, 'cached');
    await writeFile(bin, '');
    expect(findTrustedBinary(name, [bin])).toBe(bin);
    await rm(bin);
    expect(findTrustedBinary(name, [bin])).toBe(bin);
  });

  it('does not cache a miss: installing the CLI then retrying succeeds without a restart', async () => {
    const name = uniqueName();
    const bin = join(dir, 'late-install');
    expect(findTrustedBinary(name, [bin])).toBeNull();
    await writeFile(bin, '');
    expect(findTrustedBinary(name, [bin])).toBe(bin);
  });
});

describe('candidate lists', () => {
  const lists = {
    aws: awsCliCandidates(),
    gcloud: gcloudCliCandidates(),
    git: gitCliCandidates(),
    gh: ghCliCandidates(),
  } as const;

  it('every list is non-empty and names its own binary', () => {
    for (const [name, candidates] of Object.entries(lists)) {
      expect(candidates.length).toBeGreaterThan(0);
      for (const candidate of candidates) {
        // e.g. 'aws' or 'aws.exe' / 'gcloud' or 'gcloud.cmd'
        expect(basename(candidate).split('.')[0]).toBe(name);
      }
    }
  });

  it('every candidate is absolute on this platform', () => {
    // The one sanctioned exception is Windows' LOCALAPPDATA-derived gcloud
    // entry when the env var is unset — findTrustedBinary skips it via its
    // isAbsolute guard rather than probing a CWD-relative path.
    for (const candidates of Object.values(lists)) {
      for (const candidate of candidates) {
        expect(isAbsolute(candidate)).toBe(true);
      }
    }
  });

  it('git is never looked for in System32 — a dead entry that once padded the lookup path', () => {
    for (const candidate of lists.git) {
      expect(candidate.toLowerCase()).not.toContain('system32');
    }
  });

  it('gcloudSearchPaths is the deduped directories of the gcloud candidates', () => {
    const expected = [...new Set(lists.gcloud.filter(p => isAbsolute(p)).map(p => dirname(p)))];
    expect(gcloudSearchPaths()).toStrictEqual(expected);
  });
});
