import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse, stringify } from 'yaml';
import { readConfigMapping, upsertWizardProviderFile } from '../main/config-file.js';
import type { WizardProviderConfig } from '../main/config-upsert.js';

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

// A working two-provider config: the GCP entry's keyFile is a credential
// nothing can rebuild if the file is rewritten without it.
const EXISTING = {
  providers: [
    { name: 'aws-main', type: 'aws', credentialsProfile: 'main', sync: { daily: { bucket: 's3://a/daily/', retentionDays: 90 } } },
    { name: 'gcp-main', type: 'gcp', keyFile: '/keys/sa.json', sync: { daily: { bucket: 'gs://g/daily/', retentionDays: 90 } } },
  ],
  defaults: { lookbackDays: 30 },
};
const EXISTING_TEXT = stringify(EXISTING);

const WIZARD: WizardProviderConfig = { providerName: 'aws-payer', profile: 'payer', dailyBucket: 's3://p/daily/' };

const tmpDirs: string[] = [];
let dir: string;
let configPath: string;

beforeEach(async () => {
  // Canonical (macOS tmpdir is a symlink): writes resolve their target path.
  dir = await fsActual.realpath(await mkdtemp(join(tmpdir(), 'cg-config-file-')));
  tmpDirs.push(dir);
  configPath = join(dir, 'costgoblin.yaml');
});

afterEach(() => { readFileMock.mockReset(); });
afterAll(async () => {
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
});

async function providerNames(): Promise<unknown> {
  const doc: unknown = parse(await fsActual.readFile(configPath, 'utf-8'));
  if (typeof doc !== 'object' || doc === null || !('providers' in doc) || !Array.isArray(doc.providers)) return [];
  return doc.providers.map((p: unknown) => (typeof p === 'object' && p !== null && 'name' in p ? p.name : undefined));
}

describe('upsertWizardProviderFile', () => {
  it('creates a missing costgoblin.yaml with the wizard\'s provider', async () => {
    await upsertWizardProviderFile(configPath, WIZARD);
    expect(await providerNames()).toEqual(['aws-payer']);
  });

  it('adds the provider next to the existing ones, keeping them and other keys, with no temp left', async () => {
    await writeFile(configPath, EXISTING_TEXT);
    await upsertWizardProviderFile(configPath, WIZARD);
    expect(await providerNames()).toEqual(['aws-main', 'gcp-main', 'aws-payer']);
    expect(await fsActual.readFile(configPath, 'utf-8')).toContain('keyFile: /keys/sa.json');
    expect(await readdir(dir)).toEqual(['costgoblin.yaml']);
  });

  it('rejects on a read failure other than a missing file, leaving every provider in place', async () => {
    await writeFile(configPath, EXISTING_TEXT);
    readFileMock.mockImplementation((file, options) =>
      file === configPath ? Promise.reject(errnoError('EIO')) : fsActual.readFile(file, options));

    await expect(upsertWizardProviderFile(configPath, WIZARD)).rejects.toThrow('EIO');
    expect(await fsActual.readFile(configPath, 'utf-8')).toBe(EXISTING_TEXT);
  });

  it('retries a transient lock instead of starting from an empty config', async () => {
    await writeFile(configPath, EXISTING_TEXT);
    let failures = 0;
    readFileMock.mockImplementation((file, options) => {
      if (file === configPath && failures < 2) {
        failures += 1;
        return Promise.reject(errnoError(failures === 1 ? 'EBUSY' : 'EPERM'));
      }
      return fsActual.readFile(file, options);
    });

    await upsertWizardProviderFile(configPath, WIZARD);

    expect(failures).toBe(2);
    expect(await providerNames()).toEqual(['aws-main', 'gcp-main', 'aws-payer']);
  });

  it('rejects, leaving the file alone, on a hand-edit typo', async () => {
    const typo = `${EXISTING_TEXT}  - name: [unclosed\n`;
    await writeFile(configPath, typo);

    await expect(upsertWizardProviderFile(configPath, WIZARD)).rejects.toThrow();
    expect(await fsActual.readFile(configPath, 'utf-8')).toBe(typo);
  });

  it('rejects, leaving the file alone, when it is not a YAML mapping', async () => {
    await writeFile(configPath, '- aws-main\n');
    await expect(upsertWizardProviderFile(configPath, WIZARD)).rejects.toThrow('not a YAML mapping');
    expect(await fsActual.readFile(configPath, 'utf-8')).toBe('- aws-main\n');
  });

  it('treats a blank file as a new config', async () => {
    await writeFile(configPath, '');
    await upsertWizardProviderFile(configPath, WIZARD);
    expect(await providerNames()).toEqual(['aws-payer']);
  });
});

describe('readConfigMapping', () => {
  it('returns the config mapping', async () => {
    await writeFile(configPath, EXISTING_TEXT);
    expect(await readConfigMapping(configPath)).toEqual(EXISTING);
  });

  it('rejects when there is no config to update', async () => {
    await expect(readConfigMapping(configPath)).rejects.toThrow('costgoblin.yaml');
  });
});
