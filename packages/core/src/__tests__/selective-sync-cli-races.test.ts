import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter, getEventListeners } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../logger/logger.js';
import { syncSelectedFiles } from '../sync/selective-sync.js';
import type { SelectiveSyncOptions } from '../sync/selective-sync.js';
import type { ManifestFileEntry } from '../sync/manifest.js';
import { asProviderName } from '../types/branded.js';

/** The `aws s3 sync` runner's narrow windows that the main suite's fixed
 *  timers cannot hit: a cancel landing while the CLI is located, while it is
 *  spawned, or as a period starts; a spawn failure that is not a missing
 *  binary; and a destination that vanishes before the stale-file prune.
 *  Unlike `selective-sync.test.ts` this suite runs on a real tmp dir, so the
 *  etag sidecar it asserts on is the one actually written. */

const { mockSpawn, mockFindAwsCli } = vi.hoisted(() => ({
  mockSpawn: vi.fn<(...args: unknown[]) => unknown>(),
  mockFindAwsCli: vi.fn((): string | null => '/mock/trusted/aws'),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: mockSpawn,
}));
vi.mock('../logger/logger.js');
vi.mock('../sync/trusted-binaries.js', () => ({ findAwsCli: mockFindAwsCli }));

const providerName = asProviderName('aws-main');
const CANCELLED = 'Download cancelled';

const file = (key: string, hash = 'h'): ManifestFileEntry => ({ key, contentHash: hash, size: 1 });

class FakeAws extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  killed = false;

  kill(): boolean {
    this.killed = true;
    // Asynchronous, as a real child's exit is: the runner can kill before it
    // has attached its 'close' listener, and must still hear the exit.
    queueMicrotask(() => { this.emit('close', null, 'SIGTERM'); });
    return true;
  }
}

describe('syncSelectedFiles around the aws CLI process', () => {
  let dataDir: string;
  let procs: FakeAws[];
  let dests: string[];

  function recordSpawn(_bin: unknown, args: unknown): FakeAws {
    const proc = new FakeAws();
    procs.push(proc);
    // argv: s3 sync <source> <dest> ...
    dests.push((Array.isArray(args) ? args.map(String) : [])[3] ?? '');
    return proc;
  }

  async function nextProc(index: number): Promise<FakeAws> {
    await vi.waitFor(() => { expect(procs.length).toBeGreaterThan(index); });
    const proc = procs[index];
    if (proc === undefined) throw new Error(`no aws process #${String(index)} was spawned`);
    return proc;
  }

  function sync(overrides: Partial<SelectiveSyncOptions> = {}): Promise<{ filesDownloaded: number; rowsProcessed: number }> {
    return syncSelectedFiles({
      bucketPath: 's3://billing/cur/data/',
      profile: 'billing-reader',
      providerName,
      dataDir,
      expectedDataType: 'daily',
      files: [file('cur/data/billing_period=2026-01/part-0.parquet', 'jan')],
      ...overrides,
    });
  }

  async function etags(): Promise<unknown> {
    return JSON.parse(await readFile(join(dataDir, String(providerName), 'meta', 'sync-etags.json'), 'utf-8'));
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSpawn.mockReset();
    mockSpawn.mockImplementation(recordSpawn);
    mockFindAwsCli.mockReset();
    procs = [];
    dests = [];
    dataDir = await mkdtemp(join(tmpdir(), 'aws-sync-races-'));
  });

  afterEach(async () => {
    for (const proc of procs) proc.emit('close', 1, null);
    vi.restoreAllMocks();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('cancels without spawning when the abort lands while the CLI is being located', async () => {
    const controller = new AbortController();
    mockFindAwsCli.mockImplementationOnce(() => {
      controller.abort();
      return '/mock/trusted/aws';
    });

    await expect(sync({ signal: controller.signal })).rejects.toThrow(CANCELLED);

    expect(mockSpawn).not.toHaveBeenCalled();
    await expect(etags()).rejects.toThrow(/ENOENT/);
  });

  it('kills a CLI that was spawned just as the sync was cancelled', async () => {
    // Past the pre-spawn check but before the abort listener is attached: a
    // past abort never re-fires a listener, so the runner must kill directly.
    const controller = new AbortController();
    mockSpawn.mockImplementationOnce((bin: unknown, args: unknown) => {
      const proc = recordSpawn(bin, args);
      controller.abort();
      return proc;
    });

    await expect(sync({ signal: controller.signal })).rejects.toThrow(CANCELLED);

    expect(procs[0]?.killed).toBe(true);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    await expect(etags()).rejects.toThrow(/ENOENT/);
  });

  it('passes a spawn failure that is not a missing binary through unchanged', async () => {
    const run = sync();
    const proc = await nextProc(0);
    const failure = Object.assign(new Error('spawn /mock/trusted/aws EACCES'), { code: 'EACCES' });
    proc.emit('error', failure);

    await expect(run).rejects.toBe(failure);
    await expect(etags()).rejects.toThrow(/ENOENT/);
  });

  it('still completes, and records the period, when the destination vanished before the prune', async () => {
    // Pruning is best-effort: a directory that is gone has nothing stale in
    // it, and must not fail a download the CLI reported as successful.
    const info = vi.spyOn(logger, 'info');
    const run = sync();
    const proc = await nextProc(0);
    const [dest] = dests;
    if (dest === undefined) throw new Error('the aws process was given no destination');
    await rm(dest, { recursive: true, force: true });
    proc.emit('close', 0, null);

    await expect(run).resolves.toEqual({ filesDownloaded: 1, rowsProcessed: 0 });
    expect(await etags()).toEqual({ '2026-01': { 'cur/data/billing_period=2026-01/part-0.parquet': 'jan' } });
    expect(info.mock.calls.some(([message]) => message.startsWith('Pruned'))).toBe(false);
  });

  it('keeps the finished period and starts nothing for one whose start raced a cancel', async () => {
    const controller = new AbortController();
    // The cancel lands between the loop's own check and the period's first
    // folder — the one point a period can begin with nothing synced.
    vi.spyOn(logger, 'info').mockImplementation((message: string) => {
      if (message.startsWith('Processing daily period 2026-02')) controller.abort();
    });
    const run = sync({
      files: [
        file('cur/data/billing_period=2026-01/part-0.parquet', 'jan'),
        file('cur/data/billing_period=2026-02/part-0.parquet', 'feb'),
      ],
      signal: controller.signal,
    });
    (await nextProc(0)).emit('close', 0, null);

    await expect(run).resolves.toEqual({ filesDownloaded: 1, rowsProcessed: 0 });
    expect(procs).toHaveLength(1);
    // February has no etags, so it reads as stale and is retried next run.
    expect(await etags()).toEqual({ '2026-01': { 'cur/data/billing_period=2026-01/part-0.parquet': 'jan' } });
    await expect(readdir(join(dataDir, String(providerName), 'raw', 'daily-2026-02'))).rejects.toThrow(/ENOENT/);
  });
});
