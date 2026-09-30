import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { asDimensionId } from '@costgoblin/core';
import type { DimensionsConfig } from '@costgoblin/core';
import type { McpContext } from '../context.js';
import { getBaselineDrift, listBaselines } from '../tools/baselines.js';

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

const NOW = '2026-03-04T12:00:00.000Z';
const BASIS = { costMetric: 'billed', rules: [] };
const spec = (id: string, filters: Record<string, readonly string[]>, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, source: 'manual', scope: { kind: 'filter', filters }, basis: BASIS,
  basisSnapshotAt: NOW, createdAt: NOW, updatedAt: NOW, ...extra,
});

const SERVICE_ONLY: DimensionsConfig = {
  builtIn: [{ name: asDimensionId('service'), label: 'Service', field: 'service' }],
  tags: [{ tagName: 'team', label: 'Team' }],
};
const WITH_REGION: DimensionsConfig = {
  builtIn: [...SERVICE_ONLY.builtIn, { name: asDimensionId('region'), label: 'Region', field: 'region' }],
  tags: SERVICE_ONLY.tags,
};

// The same specs the desktop store would split into live and hidden.
const PERSISTED = {
  version: 1,
  baselines: [
    spec('ec2', { service: ['Amazon Elastic Compute Cloud'] }, { name: 'EC2 spend' }),
    // Hidden while `region` is not a dimension: the desktop keeps it (and
    // writes it back) but shows it nowhere.
    spec('eu-west', { region: ['eu-west-1'] }, { name: 'EU West' }),
    // Never valid: baseline scopes may only use built-in dimensions.
    spec('by-team', { tag_team: ['core'] }, { name: 'Team core' }),
    // Missing its basis — a spec no build could load.
    { id: 'no-basis', source: 'manual', scope: { kind: 'filter', filters: { service: ['AWS Lambda'] } }, name: 'Lambda' },
    // A later duplicate replaces the earlier entry, as the desktop keys specs by id.
    spec('s3', { service: ['Amazon Simple Storage Service'] }, { name: 'S3 old' }),
    spec('s3', { service: ['Amazon Simple Storage Service'] }, { name: 'S3 spend' }),
  ],
};

let stateDir: string;
let specsPath: string;
let dimensions: DimensionsConfig = SERVICE_ONLY;

function unused(): Promise<never> {
  return Promise.reject(new Error('not used by the baselines tools'));
}

function makeCtx(): McpContext {
  return {
    dataDir: stateDir,
    stateDir,
    runQuery: unused,
    runPreparedQuery: unused,
    getConfig: unused,
    getDimensions: () => Promise.resolve(dimensions),
    getQueryDimensions: () => Promise.resolve(dimensions),
    getCostScope: unused,
    getAccountMap: unused,
    getAccountReverseMap: unused,
    getOrgAccountsPath: () => Promise.resolve(undefined),
    materializedBase: { getSource: () => undefined },
    warmup: () => Promise.resolve(),
  };
}

async function listedIds(): Promise<readonly unknown[]> {
  const parsed: unknown = JSON.parse((await listBaselines(makeCtx(), { format: 'json' })).content[0].text);
  if (typeof parsed !== 'object' || parsed === null || !('tables' in parsed) || !Array.isArray(parsed.tables)) return [];
  const table: unknown = parsed.tables[0];
  if (typeof table !== 'object' || table === null || !('rows' in table) || !Array.isArray(table.rows)) return [];
  return table.rows.map((row: unknown) => (Array.isArray(row) ? row[0] : undefined)).sort();
}

beforeAll(async () => {
  stateDir = await fsActual.realpath(await mkdtemp(join(tmpdir(), 'cg-mcp-baselines-')));
  specsPath = join(stateDir, 'baselines.json');
  await writeFile(specsPath, JSON.stringify(PERSISTED));
});

afterEach(() => {
  readFileMock.mockReset();
  dimensions = SERVICE_ONLY;
});

afterAll(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

describe('list_baselines', () => {
  it('lists only the specs the desktop shows, keyed by id', async () => {
    expect(await listedIds()).toEqual(['ec2', 's3']);
  });

  it('lists a hidden spec once its dimension is back, as the desktop revives it', async () => {
    dimensions = WITH_REGION;
    expect(await listedIds()).toEqual(['ec2', 'eu-west', 's3']);
  });

  it('shows the later of two entries sharing an id', async () => {
    const text = (await listBaselines(makeCtx(), { format: 'json' })).content[0].text;
    expect(text).toContain('S3 spend');
    expect(text).not.toContain('S3 old');
  });

  it('rejects on an unreadable baselines.json rather than reporting there are none', async () => {
    readFileMock.mockImplementation((file, options) =>
      file === specsPath ? Promise.reject(errnoError('EIO')) : fsActual.readFile(file, options));
    await expect(listBaselines(makeCtx(), {})).rejects.toThrow('EIO');
  });

  it('reports no baselines when the file does not exist yet', async () => {
    readFileMock.mockImplementation((file, options) =>
      file === specsPath ? Promise.reject(errnoError('ENOENT')) : fsActual.readFile(file, options));
    expect((await listBaselines(makeCtx(), {})).content[0].text).toContain('No baselines found');
  });
});

describe('get_baseline_drift', () => {
  it('cannot reach a hidden spec by id or by match', async () => {
    expect((await getBaselineDrift(makeCtx(), { id: 'eu-west' })).content[0].text).toContain('No matching baseline');
    expect((await getBaselineDrift(makeCtx(), { match: 'team core' })).content[0].text).toContain('No matching baseline');
  });

  it('reaches a visible spec', async () => {
    expect((await getBaselineDrift(makeCtx(), { id: 'ec2' })).content[0].text).toContain('EC2 spend');
  });
});
