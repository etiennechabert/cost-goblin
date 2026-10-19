import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter, getEventListeners } from 'node:events';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../logger/logger.js';
import { parseGcloudCompletedBytes, syncGcpSelectedFiles } from '../sync/gcp-selective-sync.js';
import type { GcpSelectiveSyncOptions } from '../sync/gcp-selective-sync.js';
import type { ManifestFileEntry } from '../sync/manifest.js';
import type { SyncProgress } from '../sync/s3-client.js';
import { asProviderName } from '../types/branded.js';

/** The edges of the `gcloud storage rsync` subprocess that the main GCP sync
 *  suite does not reach: cancellations that land between two steps of the
 *  launch, spawn failures, the shaping of the failure text, and the
 *  environment the child runs with. Only the subprocess and the canonicalizer
 *  are faked — staging, installation and the etag sidecar run on a real tmp
 *  dir. The canonicalizer is out of scope here (its own suites run it against
 *  real Parquet), so it stands in with a placeholder file. */

const { mockSpawn, mockFindGcloudCli, mockGcloudChildPath, mockCanonicalize } = vi.hoisted(() => ({
  mockSpawn: vi.fn<(...args: unknown[]) => unknown>(),
  mockFindGcloudCli: vi.fn((): string | null => '/mock/trusted/gcloud'),
  mockGcloudChildPath: vi.fn((inherited: string): string => inherited),
  mockCanonicalize: vi.fn<(options: { readonly stagingDir: string; readonly outputPath: string }) =>
    Promise<{ rows: number; synthesizedColumns: readonly string[] }>>(),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: mockSpawn,
}));
vi.mock('../logger/logger.js');
vi.mock('../sync/trusted-binaries.js', () => ({
  findGcloudCli: mockFindGcloudCli,
  gcloudChildPath: mockGcloudChildPath,
  gcloudSpawnShape: (bin: string, args: readonly string[]): { command: string; args: string[]; shell: boolean } =>
    ({ command: bin, args: [...args], shell: false }),
}));
vi.mock('../sync/gcp-canonicalize.js', () => ({ canonicalizeGcpPeriod: mockCanonicalize }));

const providerName = asProviderName('gcp-main');
const CANCELLED = 'Download cancelled';
const WAITING = 'Waiting for another Cloud Storage download to finish…';
const CLI_MISSING = process.platform === 'darwin'
  ? 'Google Cloud CLI not found — install it with: brew install --cask google-cloud-sdk'
  : 'Google Cloud CLI not found — install it: https://cloud.google.com/sdk/docs/install';

const file = (key: string, hash = 'h', size = 10): ManifestFileEntry => ({ key, contentHash: hash, size });

class FakeGcloud extends EventEmitter {
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

  exit(code: number): void {
    this.emit('close', code, null);
  }
}

interface Spawned {
  readonly proc: FakeGcloud;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
}

function envOf(opts: unknown): Record<string, string | undefined> {
  const env: unknown = typeof opts === 'object' && opts !== null ? Reflect.get(opts, 'env') : undefined;
  if (typeof env !== 'object' || env === null) return {};
  return Object.fromEntries(Object.entries(env).map(([name, value]) => [name, typeof value === 'string' ? value : undefined]));
}

describe('gcloud storage rsync process handling', () => {
  let dataDir: string;
  let spawned: Spawned[];

  function recordSpawn(_bin: unknown, args: unknown, opts: unknown): FakeGcloud {
    const proc = new FakeGcloud();
    spawned.push({ proc, argv: Array.isArray(args) ? args.map(String) : [], env: envOf(opts) });
    return proc;
  }

  async function nextSpawn(index: number): Promise<Spawned> {
    await vi.waitFor(() => { expect(spawned.length).toBeGreaterThan(index); });
    const entry = spawned[index];
    if (entry === undefined) throw new Error(`no gcloud process #${String(index)} was spawned`);
    return entry;
  }

  function sync(overrides: Partial<GcpSelectiveSyncOptions> = {}): Promise<{ filesDownloaded: number; rowsProcessed: number }> {
    return syncGcpSelectedFiles({
      bucketPath: 'gs://bkt/focus',
      providerName,
      dataDir,
      expectedDataType: 'daily',
      files: [file('focus/billing_period=2026-01/shard-0.parquet')],
      ...overrides,
    });
  }

  const rawPeriodDir = (period: string): string => join(dataDir, String(providerName), 'raw', `daily-${period}`);
  const stagingTierDir = (): string => join(dataDir, String(providerName), 'meta', 'staging-gcp', 'daily');

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSpawn.mockReset();
    mockSpawn.mockImplementation(recordSpawn);
    mockFindGcloudCli.mockReset();
    mockGcloudChildPath.mockReset();
    mockCanonicalize.mockReset();
    mockCanonicalize.mockImplementation(async ({ outputPath }) => {
      await writeFile(outputPath, 'canonical');
      return { rows: 7, synthesizedColumns: ['x_ServiceCode', 'x_Operation'] };
    });
    spawned = [];
    dataDir = await mkdtemp(join(tmpdir(), 'gcp-gcloud-proc-'));
  });

  afterEach(async () => {
    // The rsync queue is module state: a process left open here would block
    // every later case in the file.
    for (const { proc } of spawned) proc.exit(1);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('points this one invocation at the configured key file, leaving the parent environment alone', async () => {
    const run = sync({ keyFile: '/keys/reader.json' });
    const { proc, env, argv } = await nextSpawn(0);
    proc.exit(0);

    await expect(run).resolves.toEqual({ filesDownloaded: 1, rowsProcessed: 7 });
    expect(env['CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE']).toBe('/keys/reader.json');
    expect(process.env['CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE']).not.toBe('/keys/reader.json');
    // A key file is its own identity: no impersonation flag rides along.
    expect(argv.some(a => a.startsWith('--impersonate-service-account'))).toBe(false);
    expect(await readdir(rawPeriodDir('2026-01'))).toEqual(['part-0.parquet']);
  });

  it('builds the child PATH from the trusted SDK directories alone when none is inherited', async () => {
    vi.stubEnv('PATH', undefined);
    mockGcloudChildPath.mockReturnValueOnce('/trusted/google-cloud-sdk/bin');

    const run = sync();
    const { proc, env } = await nextSpawn(0);
    proc.exit(0);
    await run;

    expect(mockGcloudChildPath).toHaveBeenCalledWith('');
    expect(env['PATH']).toBe('/trusted/google-cloud-sdk/bin');
  });

  it('cancels without spawning when the abort lands while the CLI is being located', async () => {
    const controller = new AbortController();
    mockFindGcloudCli.mockImplementationOnce(() => {
      controller.abort();
      return '/mock/trusted/gcloud';
    });

    await expect(sync({ signal: controller.signal })).rejects.toThrow(CANCELLED);

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockCanonicalize).not.toHaveBeenCalled();
    await expect(readdir(rawPeriodDir('2026-01'))).rejects.toThrow(/ENOENT/);
    // Staging is scratch and is removed whichever way the period ends.
    expect(await readdir(stagingTierDir())).toEqual([]);
  });

  it('kills a CLI that was spawned just as the sync was cancelled', async () => {
    // The abort lands after the pre-spawn check but before the abort listener
    // is attached; a past abort never re-fires a listener, so the runner has
    // to notice it and kill the child itself.
    const controller = new AbortController();
    mockSpawn.mockImplementationOnce((bin: unknown, args: unknown, opts: unknown) => {
      const proc = recordSpawn(bin, args, opts);
      controller.abort();
      return proc;
    });

    await expect(sync({ signal: controller.signal })).rejects.toThrow(CANCELLED);

    const [only] = spawned;
    expect(only?.proc.killed).toBe(true);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(mockCanonicalize).not.toHaveBeenCalled();
    await expect(readdir(rawPeriodDir('2026-01'))).rejects.toThrow(/ENOENT/);
  });

  it('refuses a queued sync at once when it is cancelled the moment it is told to wait', async () => {
    const first = sync({
      bucketPath: 'gs://bkt/focus/daily',
      files: [file('focus/daily/billing_period=2026-01/shard-0.parquet')],
    });
    const head = await nextSpawn(0);

    const controller = new AbortController();
    const messages: string[] = [];
    const queued = sync({
      bucketPath: 'gs://bkt/focus/hourly',
      expectedDataType: 'hourly',
      files: [file('focus/hourly/billing_period=2026-01/shard-0.parquet')],
      signal: controller.signal,
      onProgress: (p) => {
        if (p.message === undefined) return;
        messages.push(p.message);
        controller.abort();
      },
    });

    await expect(queued).rejects.toThrow(CANCELLED);
    expect(messages).toEqual([WAITING]);
    // Never spawned, and the download ahead of it is untouched.
    expect(spawned).toHaveLength(1);
    expect(head.proc.killed).toBe(false);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);

    head.proc.exit(0);
    await expect(first).resolves.toEqual({ filesDownloaded: 1, rowsProcessed: 7 });
  });

  it('reports a CLI that vanished between lookup and spawn as not installed, and detaches from the signal', async () => {
    const controller = new AbortController();
    const run = sync({ signal: controller.signal });
    const { proc } = await nextSpawn(0);
    proc.emit('error', Object.assign(new Error('spawn /mock/trusted/gcloud ENOENT'), { code: 'ENOENT' }));

    await expect(run).rejects.toHaveProperty('message', CLI_MISSING);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(mockCanonicalize).not.toHaveBeenCalled();
  });

  it('passes any other spawn failure through unchanged', async () => {
    const run = sync();
    const { proc } = await nextSpawn(0);
    const failure = Object.assign(new Error('spawn /mock/trusted/gcloud EACCES'), { code: 'EACCES' });
    proc.emit('error', failure);

    await expect(run).rejects.toBe(failure);
    await expect(readdir(rawPeriodDir('2026-01'))).rejects.toThrow(/ENOENT/);
  });

  it('keeps only the last 40 failure lines, skipping blank ones and flushing an unterminated last line', async () => {
    const info = vi.spyOn(logger, 'info');
    const lines = Array.from({ length: 45 }, (_, i) => `ERROR: failure ${String(i + 1).padStart(2, '0')}`);
    const last = 'ERROR: failure 45';
    const run = sync();
    const { proc } = await nextSpawn(0);

    proc.stderr.emit('data', Buffer.from(`\n   \n${lines.slice(0, 44).join('\n')}\n\n`));
    // gcloud's final line often has no newline: only the end-of-stream flush
    // gets it into the message.
    proc.stderr.emit('data', Buffer.from(last));
    proc.stderr.emit('end');
    proc.exit(1);

    await expect(run).rejects.toHaveProperty(
      'message',
      `gcloud storage rsync failed (exit 1): ${lines.slice(5).join('\n')}`,
    );
    // Blank lines never reach the progress feed either.
    const fed = info.mock.calls.map(([message]) => message).filter(m => m.startsWith('[gcloud]'));
    expect(fed).toEqual(lines.map(l => `[gcloud] ${l}`));
  });

  it('never runs past the listing when gcloud transfers objects the listing did not include', async () => {
    // A re-export can land between the inventory listing and the download, so
    // gcloud may announce objects the totals were never built from.
    const progress: SyncProgress[] = [];
    const known = 'focus/billing_period=2026-01/shard-0.parquet';
    const run = sync({ files: [file(known, 'h', 500)], onProgress: (p) => { progress.push(p); } });
    const { proc } = await nextSpawn(0);

    proc.stderr.emit('data', Buffer.from(
      `Copying gs://bkt/${known} to file:///s/shard-0.parquet\n`
      + 'Copying gs://bkt/focus/billing_period=2026-01/late-shard.parquet to file:///s/late.parquet\n'
      + 'Copying gs://bkt/focus/billing_period=2026-01/later-shard.parquet to file:///s/later.parquet\n',
    ));
    proc.exit(0);
    await run;

    expect(progress.filter(p => p.phase === 'downloading')).toEqual([
      { phase: 'downloading', filesTotal: 1, filesDone: 0, bytesTotal: 500, bytesDone: 0 },
      // The listed shard has landed.
      { phase: 'downloading', filesTotal: 1, filesDone: 1, bytesTotal: 500, bytesDone: 500 },
      // So has an unlisted one: it adds no bytes, and the count stays capped.
      { phase: 'downloading', filesTotal: 1, filesDone: 1, bytesTotal: 500, bytesDone: 500 },
    ]);
    expect(progress.at(-1)).toEqual({ phase: 'done', filesTotal: 1, filesDone: 1, bytesTotal: 500, bytesDone: 500 });
  });

  it('logs synthesized contract columns only when the canonicalizer had to invent some', async () => {
    const info = vi.spyOn(logger, 'info');
    const synthesizedLines = (): string[] =>
      info.mock.calls.map(([message]) => message).filter(m => m.startsWith('Synthesized column(s)'));

    mockCanonicalize.mockImplementationOnce(async ({ outputPath }) => {
      await writeFile(outputPath, 'canonical');
      return { rows: 2, synthesizedColumns: [] };
    });
    const complete = sync();
    (await nextSpawn(0)).proc.exit(0);
    await expect(complete).resolves.toEqual({ filesDownloaded: 1, rowsProcessed: 2 });
    expect(synthesizedLines()).toEqual([]);

    const partial = sync();
    (await nextSpawn(1)).proc.exit(0);
    await expect(partial).resolves.toEqual({ filesDownloaded: 1, rowsProcessed: 7 });
    expect(synthesizedLines()).toEqual(['Synthesized column(s) absent from the GCP export: x_ServiceCode, x_Operation']);
  });
});

describe('parseGcloudCompletedBytes', () => {
  it('reads tebibyte totals, which a multi-year hourly backfill reaches', () => {
    expect(parseGcloudCompletedBytes('Completed files 9/40 | 512.0GiB/1.5TiB'))
      .toEqual({ bytesDone: 512 * 1024 ** 3, bytesTotal: 1.5 * 1024 ** 4 });
    // gcloud's unit casing is not fixed across builds.
    expect(parseGcloudCompletedBytes('Completed files 40/40 | 2.0tib/2.0TIB'))
      .toEqual({ bytesDone: 2 * 1024 ** 4, bytesTotal: 2 * 1024 ** 4 });
  });
});
