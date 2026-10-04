import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  hasErrnoCode,
  quarantineFile,
  readTextIfExists,
  retryTransientFs,
  writeFileAtomic,
} from '../utils/atomic-file.js';

const tmpDirs: string[] = [];
async function newDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'cg-atomic-'));
  tmpDirs.push(d);
  return d;
}

afterAll(async () => {
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
});

function errnoError(code: string): Error {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

describe('hasErrnoCode', () => {
  it('matches only Node system errors carrying one of the codes', () => {
    expect(hasErrnoCode(errnoError('EBUSY'), ['EBUSY', 'EPERM'])).toBe(true);
    expect(hasErrnoCode(errnoError('EIO'), ['EBUSY'])).toBe(false);
    expect(hasErrnoCode(new Error('no code'), ['EBUSY'])).toBe(false);
    expect(hasErrnoCode({ code: 'EBUSY' }, ['EBUSY'])).toBe(false);
  });
});

describe('retryTransientFs', () => {
  it('retries a transient lock/descriptor error and returns the eventual result', async () => {
    let calls = 0;
    const result = await retryTransientFs(() => {
      calls += 1;
      return calls < 3 ? Promise.reject(errnoError(calls === 1 ? 'EBUSY' : 'EMFILE')) : Promise.resolve('ok');
    }, [0, 0, 0]);
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('rethrows a non-transient error at once', async () => {
    let calls = 0;
    await expect(retryTransientFs(() => { calls += 1; return Promise.reject(errnoError('EIO')); }, [0, 0])).rejects.toThrow('EIO');
    expect(calls).toBe(1);
  });

  it('gives up with the last error once the backoff schedule is spent', async () => {
    let calls = 0;
    await expect(retryTransientFs(() => { calls += 1; return Promise.reject(errnoError('EPERM')); }, [0, 0])).rejects.toThrow('EPERM');
    expect(calls).toBe(3);
  });
});

describe('readTextIfExists', () => {
  it('returns the contents of an existing file', async () => {
    const path = join(await newDir(), 'state.json');
    await writeFile(path, '{"a":1}');
    expect(await readTextIfExists(path)).toBe('{"a":1}');
  });

  it('returns null only when the file does not exist', async () => {
    expect(await readTextIfExists(join(await newDir(), 'missing.json'))).toBeNull();
  });

  it('throws any other read failure instead of reporting "no file"', async () => {
    const path = join(await newDir(), 'state.json');
    await mkdir(path); // a directory at the path: EISDIR, not ENOENT
    await expect(readTextIfExists(path)).rejects.toThrow();
  });
});

describe('writeFileAtomic', () => {
  it('creates the file, then replaces it whole, leaving no temp file behind', async () => {
    const dir = await newDir();
    const path = join(dir, 'state.json');
    await writeFileAtomic(path, 'first');
    await writeFileAtomic(path, 'second');
    expect(await readFile(path, 'utf-8')).toBe('second');
    expect(await readdir(dir)).toEqual(['state.json']);
  });

  it('leaves the previous file intact and removes its temp when the replace fails', async () => {
    const dir = await newDir();
    const path = join(dir, 'state');
    // A non-empty directory at the target: the temp write succeeds, the rename
    // over it cannot.
    await mkdir(path);
    await writeFile(join(path, 'keep'), 'x');
    await expect(writeFileAtomic(path, 'new')).rejects.toThrow();
    expect(await readdir(dir)).toEqual(['state']);
    expect(await readFile(join(path, 'keep'), 'utf-8')).toBe('x');
  });

  it('writes through a symlink and keeps the file mode, like the in-place write it replaces', async () => {
    const dir = await newDir();
    const real = join(dir, 'real.json');
    const link = join(dir, 'state.json');
    await writeFile(real, 'old');
    await chmod(real, 0o600);
    await symlink(real, link);

    await writeFileAtomic(link, 'new');

    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(real, 'utf-8')).toBe('new');
    expect((await stat(real)).mode & 0o777).toBe(0o600);
  });

  it('sweeps temps a crashed writer left behind, but not a recent one', async () => {
    const dir = await newDir();
    const path = join(dir, 'state.json');
    const stale = `${path}.11111111-1111-1111-1111-111111111111.tmp`;
    const fresh = `${path}.22222222-2222-2222-2222-222222222222.tmp`;
    const unrelated = join(dir, 'other.json.33333333-3333-3333-3333-333333333333.tmp');
    for (const p of [stale, fresh, unrelated]) await writeFile(p, 'partial');
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(stale, twoHoursAgo, twoHoursAgo);
    await utimes(unrelated, twoHoursAgo, twoHoursAgo);

    await writeFileAtomic(path, 'data');

    expect((await readdir(dir)).sort()).toEqual(
      ['other.json.33333333-3333-3333-3333-333333333333.tmp', 'state.json', 'state.json.22222222-2222-2222-2222-222222222222.tmp'],
    );
  });
});

describe('quarantineFile', () => {
  it('moves the file aside under a timestamped, filename-safe name, preserving its bytes', async () => {
    const dir = await newDir();
    const path = join(dir, 'state.json');
    await writeFile(path, '{"torn":');
    const moved = await quarantineFile(path);
    expect(moved.startsWith(`${path}.corrupt-`)).toBe(true);
    // Colons are not legal in Windows filenames.
    expect(moved.slice(dir.length + 1)).not.toContain(':');
    expect(await readFile(moved, 'utf-8')).toBe('{"torn":');
    expect(await readTextIfExists(path)).toBeNull();
  });

  it('never overwrites an earlier quarantined file', async () => {
    const dir = await newDir();
    const path = join(dir, 'state.json');
    await writeFile(path, 'one');
    const first = await quarantineFile(path);
    await writeFile(path, 'two');
    const second = await quarantineFile(path);
    expect(second).not.toBe(first);
    expect(await readFile(first, 'utf-8')).toBe('one');
    expect(await readFile(second, 'utf-8')).toBe('two');
  });
});
