import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileWithinRoot, ContainedReadError } from '../peer/contained-read.js';

describe('readFileWithinRoot', () => {
  // Creating a symlink needs elevated privilege / Developer Mode on Windows
  // (fs.symlink throws EPERM), so skip there rather than fail an unrelated suite.
  it.skipIf(process.platform === 'win32')('reads an in-tree file but refuses a symlink that escapes the root', async () => {
    const base = await mkdtemp(join(tmpdir(), 'cg-contained-'));
    try {
      const root = join(base, 'aws', 'raw');
      const periodDir = join(root, 'daily-2026-06');
      await mkdir(periodDir, { recursive: true });

      const real = join(periodDir, 'part-0.parquet');
      await writeFile(real, 'parquet-bytes');

      // A secret sitting OUTSIDE the shared root, plus a safe-looking symlink
      // inside the tree pointing at it.
      const secret = join(base, 'secret.txt');
      await writeFile(secret, 'TOP-SECRET');
      const link = join(periodDir, 'leak.parquet');
      await symlink(secret, link);

      expect((await readFileWithinRoot(root, real)).toString()).toBe('parquet-bytes');
      await expect(readFileWithinRoot(root, link)).rejects.toBeInstanceOf(ContainedReadError);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
