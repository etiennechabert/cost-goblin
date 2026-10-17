import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadOrgTree } from '../config/loader.js';
import { ConfigValidationError } from '../config/validator.js';

let dir = '';

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'costgoblin-org-tree-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The message of the ConfigValidationError `promise` rejects with; anything else fails the test. */
async function configError(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err: unknown) {
    if (err instanceof ConfigValidationError) return err.message;
    throw err;
  }
  throw new Error('expected a ConfigValidationError, but the promise resolved');
}

describe('loadOrgTree', () => {
  it('reads a missing org-tree.yaml as an empty tree (the org tree is optional)', async () => {
    await expect(loadOrgTree(join(dir, 'org-tree.yaml'))).resolves.toStrictEqual({ tree: [] });
  });

  it('validates an org-tree.yaml that exists', async () => {
    const path = join(dir, 'present.yaml');
    await writeFile(path, 'tree:\n  - name: Engineering\n    virtual: true\n    children:\n      - name: platform\n', 'utf-8');
    await expect(loadOrgTree(path)).resolves.toStrictEqual({
      tree: [{ name: 'Engineering', virtual: true, children: [{ name: 'platform' }] }],
    });
  });

  it('still rejects an org-tree.yaml that exists but is invalid', async () => {
    const path = join(dir, 'invalid.yaml');
    await writeFile(path, 'tree: Engineering\n', 'utf-8');
    expect(await configError(loadOrgTree(path))).toBe('tree must be an array');
  });
});
