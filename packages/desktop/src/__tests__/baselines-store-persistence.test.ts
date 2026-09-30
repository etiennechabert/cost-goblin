import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asDimensionId, asDollars, asTagValue, logger } from '@costgoblin/core';
import type {
  BaselineScope,
  BaselinesDiscoveryConfig,
  CostScopeConfig,
  DimensionId,
  DimensionsConfig,
  TagValue,
} from '@costgoblin/core';
import { BaselineStore, type BaselineEngineDeps } from '../main/baselines-store.js';

// Pass-through fs so individual cases can inject a failure into one call; the
// store's reads and writes go through @costgoblin/core's atomic-file helpers,
// which import this same module.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    writeFile: vi.fn(actual.writeFile),
  };
});

const fsActual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const readFileMock = vi.mocked(readFile);
const writeFileMock = vi.mocked(writeFile);

// Baselines persisted by an earlier session. The manual one, its triage and the
// custom discovery config are user-authored — nothing can rebuild them.
const MANUAL_ID = 'manual-ec2';
const DISCOVERED_ID = 'discovered-s3';
// Scoped on `region`, which the default dimensions below lack — it cannot be
// validated until the user re-enables that dimension.
const REGION_ID = 'manual-region';
const NOW = '2026-03-04T12:00:00.000Z';
const BASIS = { costMetric: 'billed', rules: [] };

const CUSTOM_CONFIG: BaselinesDiscoveryConfig = {
  lookbackDays: 90,
  windowDays: 14,
  lowerPct: 5,
  upperPct: 95,
  minMonthlyCost: asDollars(250),
  minSavings: asDollars(10),
  reopenPct: 20,
  grainDimensions: [asDimensionId('service')],
};

const PERSISTED = {
  version: 1,
  config: CUSTOM_CONFIG,
  baselines: [
    {
      id: MANUAL_ID, name: 'EC2 spend', source: 'manual',
      scope: { kind: 'filter', filters: { service: ['Amazon Elastic Compute Cloud'] } },
      basis: BASIS, basisSnapshotAt: NOW, createdAt: NOW, updatedAt: NOW,
      manualBand: { mode: 'absolute', lower: 10, upper: 20 },
    },
    {
      id: DISCOVERED_ID, source: 'discovered',
      scope: { kind: 'filter', filters: { service: ['Amazon Simple Storage Service'] } },
      basis: BASIS, basisSnapshotAt: NOW, createdAt: NOW, updatedAt: NOW,
    },
    {
      id: REGION_ID, source: 'manual',
      scope: { kind: 'filter', filters: { region: ['eu-west-1'] } },
      basis: BASIS, basisSnapshotAt: NOW, createdAt: NOW, updatedAt: NOW,
    },
  ],
  meta: {
    [MANUAL_ID]: {
      triage: { notes: [{ at: NOW, text: 'right-sizing ticket open', ticket: 'COST-7' }] },
      bestAchieved: 12.5,
      triageStatus: 'acting',
      userTriaged: true,
    },
    [DISCOVERED_ID]: { triage: { notes: [] }, bestAchieved: null },
    [REGION_ID]: { triage: { notes: [{ at: NOW, text: 'watch eu-west-1' }] }, bestAchieved: null, triageStatus: 'tracking', userTriaged: true },
  },
};
const PERSISTED_TEXT = JSON.stringify(PERSISTED, null, 2);

const SERVICE_ONLY: DimensionsConfig = {
  builtIn: [{ name: asDimensionId('service'), label: 'Service', field: 'service' }],
  tags: [],
};
const WITH_REGION: DimensionsConfig = {
  builtIn: [...SERVICE_ONLY.builtIn, { name: asDimensionId('region'), label: 'Region', field: 'region' }],
  tags: [],
};
const costScope: CostScopeConfig = { costMetric: 'billed', rules: [], lagDays: 2 };

function svcScope(service: string): BaselineScope {
  const filters: Partial<Record<DimensionId, readonly TagValue[]>> = {};
  filters[asDimensionId('service')] = [asTagValue(service)];
  return { kind: 'filter', filters };
}

/** No provider configured: a full recompute skips discovery (no DuckDB needed)
 *  but still runs to completion and persists — the path that used to overwrite
 *  baselines.json with whatever was (or wasn't) in memory. */
function makeDeps(stateDir: string, dimensions: DimensionsConfig = SERVICE_ONLY): BaselineEngineDeps {
  return {
    dataDir: stateDir,
    stateDir,
    getFirstProviderName: () => Promise.resolve(null),
    getQueryProviders: () => Promise.resolve([]),
    getQueryDimensions: () => Promise.resolve(dimensions),
    getCostScope: () => Promise.resolve(costScope),
    getAccountMap: () => Promise.resolve(new Map<string, string>()),
    getAccountReverseMap: () => Promise.resolve(new Map<string, readonly string[]>()),
    getOrgTreeConfig: () => Promise.resolve({ tree: [] }),
    runPreparedQuery: () => Promise.reject(new Error('no query expected without a provider')),
    rollupStore: { getBuiltSignature: () => null, resolveSource: () => undefined },
  };
}

function errnoError(code: string): Error {
  return Object.assign(new Error(`${code}: simulated failure`), { code });
}

function rec(v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('expected a JSON object');
  return { ...v };
}

function isPath(file: unknown, path: string): boolean {
  return typeof file === 'string' && file === path;
}

describe('BaselineStore persistence', () => {
  const tmpDirs: string[] = [];
  let stateDir: string;
  let specsPath: string;
  let dataPath: string;

  const readSpecsDoc = async (): Promise<Record<string, unknown>> => rec(JSON.parse(await fsActual.readFile(specsPath, 'utf-8')));
  const persistedIds = async (): Promise<string[]> => {
    const baselines = (await readSpecsDoc())['baselines'];
    return Array.isArray(baselines) ? baselines.map((b) => String(rec(b)['id'])).sort() : [];
  };

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'cg-baselines-persist-'));
    tmpDirs.push(stateDir);
    specsPath = join(stateDir, 'baselines.json');
    dataPath = join(stateDir, 'baselines-data.json');
    await fsActual.writeFile(specsPath, PERSISTED_TEXT);
  });

  afterEach(() => {
    readFileMock.mockReset();
    readFileMock.mockImplementation(fsActual.readFile);
    writeFileMock.mockReset();
    writeFileMock.mockImplementation(fsActual.writeFile);
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
  });

  /** Make every read of baselines.json fail with `code` until the case resets it. */
  const failSpecsReads = (code: string): void => {
    readFileMock.mockImplementation((file, options) =>
      isPath(file, specsPath) ? Promise.reject(errnoError(code)) : fsActual.readFile(file, options));
  };

  describe('an unreadable baselines.json', () => {
    it('fails the load rather than starting empty, so a post-sync recompute cannot wipe it', async () => {
      failSpecsReads('EIO');
      const store = new BaselineStore(stateDir);
      const deps = makeDeps(stateDir);

      await store.recompute(deps);

      expect(store.getStatus()).toMatchObject({ state: 'error' });
      expect(await fsActual.readFile(specsPath, 'utf-8')).toBe(PERSISTED_TEXT);
    });

    it('refuses every write while the load is failing', async () => {
      failSpecsReads('EIO');
      const store = new BaselineStore(stateDir);
      const deps = makeDeps(stateDir);

      await expect(store.list(deps, {})).rejects.toThrow('EIO');
      await expect(store.create(deps, { scope: svcScope('AWS Lambda') })).rejects.toThrow('EIO');
      await expect(store.setConfig(deps, { ...CUSTOM_CONFIG, windowDays: 7 })).rejects.toThrow('EIO');
      await expect(store.resetConfig(deps)).rejects.toThrow('EIO');
      await expect(store.delete(deps, MANUAL_ID)).rejects.toThrow('EIO');

      expect(await fsActual.readFile(specsPath, 'utf-8')).toBe(PERSISTED_TEXT);
    });

    it('retries the load on the next access once the file is readable again, and keeps everything', async () => {
      failSpecsReads('EIO');
      const store = new BaselineStore(stateDir);
      const deps = makeDeps(stateDir);
      await store.recompute(deps);
      expect(store.getStatus()).toMatchObject({ state: 'error' });

      readFileMock.mockImplementation(fsActual.readFile);
      await store.recompute(deps);
      expect(store.getStatus()).toMatchObject({ state: 'idle' });

      const res = await store.list(deps, {});
      const manual = res.items.find((r) => r.spec.id === MANUAL_ID);
      expect(manual?.triageStatus).toBe('acting');
      expect(manual?.triage.notes.map((n) => n.text)).toEqual(['right-sizing ticket open']);
      expect(manual?.spec.manualBand).toEqual({ mode: 'absolute', lower: 10, upper: 20 });
      expect(store.getConfigState()).toEqual({ config: CUSTOM_CONFIG, isCustom: true });

      expect(await persistedIds()).toEqual([DISCOVERED_ID, MANUAL_ID, REGION_ID]);
      expect(rec(rec(rec((await readSpecsDoc())['meta'])[MANUAL_ID])['triage'])['notes']).toHaveLength(1);
    });

    it('retries a transient lock or descriptor error before giving up', async () => {
      let failures = 0;
      readFileMock.mockImplementation((file, options) => {
        if (isPath(file, specsPath) && failures < 2) {
          failures += 1;
          return Promise.reject(errnoError(failures === 1 ? 'EBUSY' : 'EMFILE'));
        }
        return fsActual.readFile(file, options);
      });
      const store = new BaselineStore(stateDir);

      const res = await store.list(makeDeps(stateDir), {});

      expect(failures).toBe(2);
      expect(res.items.map((r) => r.spec.id).sort()).toEqual([DISCOVERED_ID, MANUAL_ID]);
    });
  });

  describe('an unparseable state file', () => {
    it.each([
      ['torn mid-write', PERSISTED_TEXT.slice(0, PERSISTED_TEXT.length / 2)],
      ['empty', ''],
      ['not an object', '[1, 2, 3]'],
      ['a baselines field that is not an array', '{"version":1,"baselines":{"oops":true}}'],
    ])('moves a %s baselines.json aside, byte for byte, before starting fresh', async (_label, content) => {
      await fsActual.writeFile(specsPath, content);
      const errors = vi.spyOn(logger, 'error');
      const store = new BaselineStore(stateDir);

      await store.recompute(makeDeps(stateDir));

      expect(store.getStatus()).toMatchObject({ state: 'idle' });
      const quarantined = (await readdir(stateDir)).filter((f) => f.startsWith('baselines.json.corrupt-'));
      expect(quarantined).toHaveLength(1);
      expect(await fsActual.readFile(join(stateDir, quarantined[0] ?? ''), 'utf-8')).toBe(content);
      expect(errors).toHaveBeenCalledWith(expect.stringContaining('baselines'), expect.objectContaining({ movedTo: expect.stringContaining('.corrupt-') }));
      // A fresh, valid document replaced it.
      expect(await persistedIds()).toEqual([]);
    });

    it('moves a torn baselines-data.json aside too, keeping the specs', async () => {
      await fsActual.writeFile(dataPath, '{"version":1,"history":{"x":[{"da');
      const store = new BaselineStore(stateDir);

      await store.recompute(makeDeps(stateDir));

      expect(store.getStatus()).toMatchObject({ state: 'idle' });
      expect((await readdir(stateDir)).filter((f) => f.startsWith('baselines-data.json.corrupt-'))).toHaveLength(1);
      expect(await persistedIds()).toEqual([DISCOVERED_ID, MANUAL_ID, REGION_ID]);
    });
  });

  describe('load', () => {
    it('does not latch a load whose dimensions lookup rejected', async () => {
      const store = new BaselineStore(stateDir);
      const flaky: BaselineEngineDeps = { ...makeDeps(stateDir), getQueryDimensions: () => Promise.reject(new Error('config unreadable')) };

      await expect(store.list(flaky, {})).rejects.toThrow('config unreadable');

      const res = await store.list(makeDeps(stateDir), {});
      expect(res.items.map((r) => r.spec.id).sort()).toEqual([DISCOVERED_ID, MANUAL_ID]);
    });

    it('makes concurrent first accesses wait for the same load', async () => {
      const store = new BaselineStore(stateDir);
      const deps = makeDeps(stateDir);

      const [a, b] = await Promise.all([store.list(deps, {}), store.list(deps, {})]);

      expect(a.total).toBe(2);
      expect(b.total).toBe(2);
    });

    it('setConfig on a store that has not loaded yet keeps the persisted baselines', async () => {
      const store = new BaselineStore(stateDir);

      await store.setConfig(makeDeps(stateDir), { ...CUSTOM_CONFIG, windowDays: 7 });

      expect(await persistedIds()).toEqual([DISCOVERED_ID, MANUAL_ID, REGION_ID]);
      expect(rec((await readSpecsDoc())['config'])['windowDays']).toBe(7);
    });
  });

  describe('specs that fail validation', () => {
    it('are carried through saves with their triage, and load again once their dimension is back', async () => {
      const warns = vi.spyOn(logger, 'warn');
      const store = new BaselineStore(stateDir);
      const deps = makeDeps(stateDir);

      const res = await store.list(deps, {});
      expect(res.items.map((r) => r.spec.id)).not.toContain(REGION_ID);
      expect(warns).toHaveBeenCalledWith('baselines: kept specs that failed validation (hidden until they validate)', expect.objectContaining({ count: 1 }));

      await store.recompute(deps);
      await store.update(deps, MANUAL_ID, { name: 'EC2 (renamed)' });

      expect(await persistedIds()).toEqual([DISCOVERED_ID, MANUAL_ID, REGION_ID]);
      const regionMeta = rec(rec((await readSpecsDoc())['meta'])[REGION_ID]);
      expect(regionMeta['triageStatus']).toBe('tracking');

      const restored = await new BaselineStore(stateDir).list(makeDeps(stateDir, WITH_REGION), {});
      const region = restored.items.find((r) => r.spec.id === REGION_ID);
      expect(region?.triageStatus).toBe('tracking');
      expect(region?.triage.notes.map((n) => n.text)).toEqual(['watch eu-west-1']);
    });

    it('drops discovered ones on a start-fresh recompute, like every other discovered baseline', async () => {
      const staleDiscovered = {
        ...PERSISTED,
        baselines: [...PERSISTED.baselines, {
          id: 'discovered-region', source: 'discovered',
          scope: { kind: 'filter', filters: { region: ['us-east-1'] } },
          basis: BASIS, basisSnapshotAt: NOW, createdAt: NOW, updatedAt: NOW,
        }],
      };
      await fsActual.writeFile(specsPath, JSON.stringify(staleDiscovered));
      const store = new BaselineStore(stateDir);

      await store.recompute(makeDeps(stateDir), { startFresh: true });

      expect(await persistedIds()).toEqual([MANUAL_ID, REGION_ID]);
    });
  });

  describe('writes', () => {
    it('a write killed half way leaves the previous baselines.json intact and no temp file behind', async () => {
      const store = new BaselineStore(stateDir);
      const deps = makeDeps(stateDir);
      await store.list(deps, {});
      // Simulate the process dying mid-write: half the bytes land, then the
      // write fails.
      writeFileMock.mockImplementation(async (file, data, options) => {
        if (typeof data !== 'string') return fsActual.writeFile(file, data, options);
        await fsActual.writeFile(file, data.slice(0, data.length / 2), options);
        throw errnoError('ENOSPC');
      });

      await expect(store.update(deps, MANUAL_ID, { name: 'renamed' })).rejects.toThrow('ENOSPC');

      expect(await fsActual.readFile(specsPath, 'utf-8')).toBe(PERSISTED_TEXT);
      expect((await readdir(stateDir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    });

    it('concurrent mutations all reach the file', async () => {
      const store = new BaselineStore(stateDir);
      const deps = makeDeps(stateDir);

      await Promise.all([
        store.update(deps, MANUAL_ID, { name: 'renamed' }),
        store.update(deps, DISCOVERED_ID, { note: { text: 'looked at it' } }),
        store.setConfig(deps, { ...CUSTOM_CONFIG, windowDays: 21 }),
      ]);

      const doc = await readSpecsDoc();
      const baselines = doc['baselines'];
      const manual = Array.isArray(baselines) ? baselines.map(rec).find((b) => b['id'] === MANUAL_ID) : undefined;
      expect(manual?.['name']).toBe('renamed');
      expect(rec(rec(rec(doc['meta'])[DISCOVERED_ID])['triage'])['notes']).toHaveLength(1);
      expect(rec(doc['config'])['windowDays']).toBe(21);
    });
  });
});
