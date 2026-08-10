import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';
import {
  awsCliCandidates,
  findTrustedBinary,
  gcloudChildPath,
  gcloudCliCandidates,
  gcloudSearchPaths,
  gcloudSpawnShape,
  ghCliCandidates,
  gitCliCandidates,
} from '../sync/trusted-binaries.js';

describe('findTrustedBinary', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'trusted-bin-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns the first candidate that exists on disk', async () => {
    await writeFile(join(dir, 'second'), '');
    await writeFile(join(dir, 'third'), '');
    const found = findTrustedBinary([
      join(dir, 'missing'),
      join(dir, 'second'),
      join(dir, 'third'),
    ]);
    expect(found).toBe(join(dir, 'second'));
  });

  it('returns null when no candidate exists — the caller disables the feature', () => {
    expect(findTrustedBinary([join(dir, 'nope'), join(dir, 'also-nope')])).toBeNull();
  });

  it('never resolves a relative candidate, even one that exists from the CWD', () => {
    // A relative path would be probed against whatever directory the app was
    // launched from. 'package.json' exists relative to the repo CWD the tests
    // run in; a trusted lookup must still refuse it.
    expect(findTrustedBinary(['package.json'])).toBeNull();
  });

  it('re-probes on every call: a binary that appears after a miss is found without a restart', async () => {
    const bin = join(dir, 'late-install');
    expect(findTrustedBinary([bin])).toBeNull();
    await writeFile(bin, '');
    expect(findTrustedBinary([bin])).toBe(bin);
  });

  it('re-probes on every call: a binary that relocates resolves at its new home', async () => {
    // The resolver deliberately holds no cache — a stale hit once wedged the
    // Windows re-auth button into a silent no-op and kept POSIX syncs
    // reporting "not found" after a brew migration until app restart.
    const first = join(dir, 'old-home');
    const second = join(dir, 'new-home');
    await writeFile(first, '');
    expect(findTrustedBinary([first, second])).toBe(first);
    await rm(first);
    await writeFile(second, '');
    expect(findTrustedBinary([first, second])).toBe(second);
    await rm(second);
    expect(findTrustedBinary([first, second])).toBeNull();
  });
});

describe('candidate lists (current platform)', () => {
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

  it('every candidate is absolute — the builders never emit a relative entry', () => {
    // Set-but-empty or missing Windows env vars omit the entry (or fall back
    // to the literal default) rather than joining '' into a relative path, so
    // the resolver's isAbsolute guard is pure defense in depth.
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

  it('gcloudSearchPaths entries are absolute, deduped directories of gcloud candidates', () => {
    const paths = gcloudSearchPaths();
    expect(paths.length).toBeGreaterThan(0);
    expect(new Set(paths).size).toBe(paths.length);
    for (const p of paths) {
      expect(isAbsolute(p)).toBe(true);
    }
    for (const candidate of lists.gcloud) {
      expect(paths).toContain(dirname(candidate));
    }
  });
});

describe('win32 candidate arms', () => {
  // The lists branch on process.platform at call time, so the Windows arms
  // are testable from the POSIX CI runners by stubbing the platform. Note
  // node:path keeps the host flavor, so these cases assert on path CONTENT
  // (roots, basenames, entry counts), not on separators or isAbsolute.
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    vi.stubEnv('PROGRAMFILES', String.raw`C:\Program Files`);
    vi.stubEnv('LOCALAPPDATA', String.raw`C:\Users\dev\AppData\Local`);
  });

  afterEach(() => {
    if (originalPlatform !== undefined) Object.defineProperty(process, 'platform', originalPlatform);
    vi.unstubAllEnvs();
  });

  it('resolves the four binaries to .exe/.cmd entries under the Windows roots', () => {
    expect(awsCliCandidates().every(c => c.endsWith('aws.exe'))).toBe(true);
    expect(gcloudCliCandidates().every(c => c.endsWith('gcloud.cmd'))).toBe(true);
    expect(gitCliCandidates().every(c => c.endsWith('git.exe'))).toBe(true);
    expect(ghCliCandidates().every(c => c.endsWith('gh.exe'))).toBe(true);
  });

  it('a set-but-empty PROGRAMFILES falls back to the default root like an unset one', () => {
    vi.stubEnv('PROGRAMFILES', '');
    for (const candidate of [...awsCliCandidates(), ...gitCliCandidates(), ...ghCliCandidates()]) {
      if (candidate.includes('(x86)')) continue;
      expect(candidate.startsWith(String.raw`C:\Program Files`)).toBe(true);
    }
    expect(gcloudCliCandidates()[0]?.startsWith(String.raw`C:\Program Files`)).toBe(true);
  });

  it('omits the LOCALAPPDATA gcloud entry when the env var is unset or empty, instead of emitting a relative path', () => {
    expect(gcloudCliCandidates()).toHaveLength(2);
    vi.stubEnv('LOCALAPPDATA', '');
    expect(gcloudCliCandidates()).toHaveLength(1);
  });

  it('quotes the binary and every argument for the cmd.exe spawn', () => {
    const shape = gcloudSpawnShape(String.raw`C:\Program Files\Google\gcloud.cmd`, ['auth', 'login']);
    expect(shape.shell).toBe(true);
    expect(shape.command).toBe(String.raw`"C:\Program Files\Google\gcloud.cmd"`);
    expect(shape.args).toStrictEqual(['"auth"', '"login"']);
  });
});

describe('gcloudChildPath', () => {
  it('puts every trusted SDK directory before the inherited entries', () => {
    const child = gcloudChildPath(['/inherited/first', '/inherited/second'].join(delimiter));
    const entries = child.split(delimiter);
    const lastTrusted = Math.max(...gcloudSearchPaths().map(p => entries.indexOf(p)));
    expect(lastTrusted).toBeGreaterThanOrEqual(0);
    expect(lastTrusted).toBeLessThan(entries.indexOf('/inherited/first'));
  });

  it('dedupes an inherited entry that is already trusted', () => {
    const trusted = gcloudSearchPaths();
    const child = gcloudChildPath([trusted[0] ?? '', '/inherited/only'].join(delimiter));
    const entries = child.split(delimiter);
    expect(entries.filter(e => e === trusted[0])).toHaveLength(1);
  });

  it('drops empty segments — an empty PATH entry means "current directory"', () => {
    const child = gcloudChildPath(['', '/inherited/only', ''].join(delimiter));
    expect(child.split(delimiter)).not.toContain('');
  });
});

describe('gcloudSpawnShape (current platform)', () => {
  it('spawns the binary directly with untouched args on POSIX', () => {
    if (process.platform === 'win32') return;
    const shape = gcloudSpawnShape('/opt/homebrew/bin/gcloud', ['storage', 'rsync']);
    expect(shape).toStrictEqual({
      command: '/opt/homebrew/bin/gcloud',
      args: ['storage', 'rsync'],
      shell: false,
    });
  });
});
