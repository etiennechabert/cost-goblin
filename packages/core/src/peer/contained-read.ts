import { readFile, realpath } from 'node:fs/promises';
import { sep } from 'node:path';

/** Thrown when a requested file resolves outside the shared root — e.g. a
 *  symlink inside the data tree points at a file elsewhere on disk. */
export class ContainedReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContainedReadError';
  }
}

/** Read a file, but only if its fully-resolved real path stays within `root`.
 *  `isSafePackPath` already confines the *string* to `aws/raw/...`, but a
 *  symlink planted in the data tree could still redirect the bytes to, say,
 *  `~/.aws/credentials`. Resolving both sides with realpath and requiring
 *  containment closes that out-of-tree read. Both paths are realpath'd so the
 *  comparison is robust to symlinked roots (e.g. macOS `/var` → `/private/var`). */
export async function readFileWithinRoot(root: string, filePath: string): Promise<Buffer> {
  const [realRoot, realFile] = await Promise.all([realpath(root), realpath(filePath)]);
  if (!realFile.startsWith(realRoot + sep)) {
    throw new ContainedReadError('Resolved path escapes the shared data root');
  }
  return readFile(realFile);
}
