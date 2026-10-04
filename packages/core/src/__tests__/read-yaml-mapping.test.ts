import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { readYamlMappingIfExists } from '../config/loader.js';

// Pass-through fs so a case can inject a failure into one read.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const fsActual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const readFileMock = vi.mocked(readFile);

function errnoError(code: string): Error {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

const tmpDirs: string[] = [];
async function newFile(content?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cg-yaml-mapping-'));
  tmpDirs.push(dir);
  const path = join(dir, 'costgoblin.yaml');
  if (content !== undefined) await writeFile(path, content);
  return path;
}

afterEach(() => { readFileMock.mockReset(); });
afterAll(async () => {
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
});

describe('readYamlMappingIfExists', () => {
  it('returns the top-level mapping', async () => {
    expect(await readYamlMappingIfExists(await newFile('providers:\n  - name: aws-main\n'))).toEqual({ providers: [{ name: 'aws-main' }] });
  });

  it('returns null only when the file does not exist', async () => {
    expect(await readYamlMappingIfExists(await newFile())).toBeNull();
  });

  it('reads a blank file as an empty mapping: it holds nothing to lose', async () => {
    expect(await readYamlMappingIfExists(await newFile(''))).toEqual({});
    expect(await readYamlMappingIfExists(await newFile('# just a comment\n'))).toEqual({});
  });

  it('throws on a read failure other than a missing file', async () => {
    const path = await newFile('providers: []\n');
    readFileMock.mockImplementation((file, options) =>
      file === path ? Promise.reject(errnoError('EIO')) : fsActual.readFile(file, options));
    await expect(readYamlMappingIfExists(path)).rejects.toThrow('EIO');
  });

  it('retries a transient lock or descriptor error', async () => {
    const path = await newFile('providers: []\n');
    let failures = 0;
    readFileMock.mockImplementation((file, options) => {
      if (file === path && failures < 2) {
        failures += 1;
        return Promise.reject(errnoError(failures === 1 ? 'EBUSY' : 'EMFILE'));
      }
      return fsActual.readFile(file, options);
    });
    expect(await readYamlMappingIfExists(path)).toEqual({ providers: [] });
    expect(failures).toBe(2);
  });

  it('throws on a YAML syntax error, as a hand-edit typo leaves', async () => {
    await expect(readYamlMappingIfExists(await newFile('providers:\n  - name: [unclosed\n'))).rejects.toThrow();
  });

  it('throws on a document that is not a mapping', async () => {
    await expect(readYamlMappingIfExists(await newFile('- a\n- b\n'))).rejects.toThrow('not a YAML mapping');
    await expect(readYamlMappingIfExists(await newFile('just a string\n'))).rejects.toThrow('not a YAML mapping');
  });

  it('leaves the file untouched', async () => {
    const path = await newFile('- a\n');
    await expect(readYamlMappingIfExists(path)).rejects.toThrow();
    expect(await fsActual.readFile(path, 'utf-8')).toBe('- a\n');
  });
});
