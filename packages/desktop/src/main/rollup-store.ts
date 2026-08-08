import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  computePartitionEtagHash,
  logger,
  ROLLUP_SCHEMA_VERSION,
  validateManifest,
  type ProviderName,
  type RollupManifest,
  type RollupPartitionMeta,
  type RollupStatus,
} from '@costgoblin/core';
import type { RawRow } from './duckdb-client.js';

export type RollupStatusListener = (status: RollupStatus) => void;

/** Build the human-readable `reason` for a failed batch from the distinct
 *  errors its partitions threw. Picks the most common message (the systematic
 *  root cause behind an all-fail batch), trims it for the popover/IPC payload,
 *  and notes when other, different errors also occurred. Only called when at
 *  least one period failed, so the map is never empty. */
function summarizeErrors(errorCounts: ReadonlyMap<string, number>): string {
  const sorted = [...errorCounts.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted[0]?.[0] ?? 'Unknown error';
  const trimmed = top.length > 400 ? `${top.slice(0, 400)}…` : top;
  const others = sorted.length - 1;
  return others > 0 ? `${trimmed} (+${String(others)} other error${others === 1 ? '' : 's'})` : trimmed;
}

/** Builds the `COPY (...) TO '<outPath>' (FORMAT PARQUET)` DDL for one period.
 *  Supplied by the caller (context.ts) so the store stays decoupled from the
 *  query builder. May be async for historical flexibility. */
export type BuildPartitionSql = (period: string, outPath: string) => string | Promise<string>;

export interface RollupShape {
  readonly signature: string;
  readonly grainDimensions: readonly string[];
}

export interface ResolveSourceArgs {
  /** The YYYY-MM periods the query's date range touches (already intersected
   *  with months on disk by the caller). */
  readonly requiredPeriods: readonly string[];
  readonly tier: 'daily' | 'hourly';
  /** Columns the query references (group-by dim, service, account_id, etc.).
   *  All must be present in the partition grain or we fall back to raw. */
  readonly neededColumns: readonly string[];
}

interface RollupStoreDeps {
  readonly dataDir: string;
  /** Which provider's tree (`{dataDir}/{name}/rollup`) this store owns. A
   *  closure because the store is constructed before the config is loaded;
   *  it throws when called with no provider configured, so every store
   *  entry point must run after the config cache is populated. */
  readonly providerName: () => ProviderName;
  readonly runQuery: (sql: string) => Promise<RawRow[]>;
  /** Runs a partition-build query on a fresh, disposable DuckDB connection so
   *  per-build time doesn't climb across a batch (buffer/cache accumulation on
   *  a reused connection). Defaults to `runQuery` (tests, which share one
   *  connection and build a single period). */
  readonly runBuild?: (sql: string) => Promise<RawRow[]>;
  /** Max partitions built concurrently. Defaults to 1 (sequential) so the
   *  single-connection test harness is safe; production passes the worker's
   *  pool size so independent months build in parallel. */
  readonly buildConcurrency?: number;
}

/**
 * Persistent per-period pre-aggregated rollup, stored as Hive-style Parquet
 * partitions under `{dataDir}/{provider}/rollup/daily-YYYY-MM/rollup.parquet` with a
 * `manifest.json` recording the shape-signature and each partition's raw-etag
 * watermark.
 *
 * Correctness invariants:
 *  - All mutations are serialized through a single-writer queue.
 *  - An `epoch` token is captured at the start of each build; a concurrent
 *    `invalidate()` bumps the epoch so a stale in-flight build cannot write a
 *    manifest (kills the resurrection bug the in-memory base had).
 *  - The manifest is written atomically (temp file + rename on the same fs).
 *  - `resolveSource` returns the rollup glob ONLY when every required period is
 *    valid (signature + watermark match) and every needed column is in-grain;
 *    otherwise the caller queries raw Parquet. A stale partition within the
 *    requested range therefore forces raw, never silently-wrong numbers.
 */
export class RollupStore {
  private readonly dataDir: string;
  private readonly providerName: () => ProviderName;
  private readonly runQuery: (sql: string) => Promise<RawRow[]>;
  private readonly runBuild: (sql: string) => Promise<RawRow[]>;
  private buildConcurrency: number;

  private manifest: RollupManifest | null = null;
  private shape: RollupShape | null = null;
  private validPeriods = new Set<string>();
  private epoch = 0;
  private queue: Promise<unknown> = Promise.resolve();

  private status: RollupStatus = { state: 'idle' };
  private readonly statusListeners = new Set<RollupStatusListener>();

  constructor(deps: RollupStoreDeps) {
    this.dataDir = deps.dataDir;
    this.providerName = deps.providerName;
    this.runQuery = deps.runQuery;
    this.runBuild = deps.runBuild ?? deps.runQuery;
    this.buildConcurrency = Math.max(1, deps.buildConcurrency ?? 1);
  }

  /** Subscribe to rollup compute-state transitions. Fires immediately with the
   *  current status (matching the update-manager convention) so a late
   *  subscriber doesn't miss the build that's already running. */
  onStatusChanged(listener: RollupStatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => { this.statusListeners.delete(listener); };
  }

  getStatus(): RollupStatus { return this.status; }

  /** Adjust the cap on concurrent partition builds at runtime (the Performance
   *  setting). Takes effect on the next maintainPeriods() batch — an in-flight
   *  build keeps its current lane count. */
  setBuildConcurrency(n: number): void {
    this.buildConcurrency = Math.max(1, Math.round(n));
  }

  private setStatus(status: RollupStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }

  private settledStatus(): RollupStatus {
    return this.isReady() ? { state: 'ready', periods: this.validPeriods.size } : { state: 'idle' };
  }

  /** Emit a terminal status from a path that decided there's nothing to build
   *  (e.g. warmup after an invalidate found every partition already valid, or no
   *  local data at all). A no-op while a build is mid-flight — that build owns
   *  the transition to `ready`/`failed`. */
  markSettled(): void { this.setStatus(this.settledStatus()); }

  private rollupDir(): string { return join(this.dataDir, String(this.providerName()), 'rollup'); }
  private manifestPath(): string { return join(this.rollupDir(), 'manifest.json'); }
  private partitionDir(period: string): string { return join(this.rollupDir(), `daily-${period}`); }
  private partitionPath(period: string): string { return join(this.partitionDir(period), 'rollup.parquet'); }

  /** DuckDB read_parquet over EXACTLY the partitions the query needs, listed
   *  explicitly rather than a `daily-*` wildcard. Skipping the other months'
   *  files avoids their Parquet footer reads — the single biggest cost for a
   *  short window over a year of partitions — mirroring the raw path's
   *  `buildParquetSource`. Every period is guaranteed to exist on disk because
   *  `resolveSource` only routes here once all are valid. Forward slashes for
   *  cross-platform globbing. */
  private rollupGlob(periods: readonly string[]): string {
    const paths = periods
      .map(p => `'${this.partitionPath(p).replaceAll('\\', '/').replaceAll("'", "''")}'`)
      .join(', ');
    return `read_parquet([${paths}])`;
  }

  isReady(): boolean { return this.manifest !== null && this.validPeriods.size > 0; }
  getValidPeriods(): ReadonlySet<string> { return this.validPeriods; }

  /** Exact on-disk rollup totals (summed over every built partition) for the
   *  grain estimator's "current grain" baseline. null when nothing is built. */
  getStats(): { rows: number; bytes: number; months: number } | null {
    if (this.manifest === null) return null;
    const parts = Object.values(this.manifest.partitions);
    if (parts.length === 0) return null;
    let rows = 0;
    let bytes = 0;
    for (const p of parts) { rows += p.rows; bytes += p.bytes; }
    return { rows, bytes, months: parts.length };
  }

  /** Shape signature the on-disk partitions were actually built against (null
   *  when nothing is built). Lets callers tell whether a candidate grain matches
   *  what's already materialized. Keyed off the manifest — stays consistent with
   *  getStats (both null together) — not the in-memory `shape`, which may hold a
   *  not-yet-built candidate. */
  getBuiltSignature(): string | null {
    return this.manifest === null ? null : this.manifest.shapeSignature;
  }

  /** Serialize a mutation; the callback receives the epoch captured at enqueue
   *  time so it can detect a concurrent invalidate() and abort its commit. */
  private enqueue<T>(fn: (epoch: number) => Promise<T>): Promise<T> {
    const startEpoch = this.epoch;
    const run = this.queue.then(() => fn(startEpoch));
    // Keep the chain alive even if a step rejects.
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async readManifest(): Promise<RollupManifest | null> {
    try {
      const raw = await readFile(this.manifestPath(), 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return null;
      // Trust the shape loosely; validateManifest re-checks signature/version.
      return parsed as RollupManifest;
    } catch {
      return null;
    }
  }

  private async writeManifestAtomic(manifest: RollupManifest): Promise<void> {
    await mkdir(this.rollupDir(), { recursive: true });
    const tmp = `${this.manifestPath()}.tmp`;
    await writeFile(tmp, JSON.stringify(manifest, null, 2));
    await rename(tmp, this.manifestPath());
  }

  /** Read + validate the persisted manifest against the current shape and raw
   *  etags. Populates internal state and returns which periods are usable
   *  as-is vs need a (re)build. */
  async loadAndValidate(
    shape: RollupShape,
    etagsByPeriod: Readonly<Record<string, Readonly<Record<string, string>>>>,
  ): Promise<{ validPeriods: ReadonlySet<string>; stalePeriods: ReadonlySet<string>; fullyInvalid: boolean }> {
    this.shape = shape;
    const manifest = await this.readManifest();
    const result = validateManifest(manifest, {
      currentSignature: shape.signature,
      currentSchemaVersion: ROLLUP_SCHEMA_VERSION,
      etagsByPeriod,
    });
    if (result.fullyInvalid) {
      this.manifest = null;
      this.validPeriods = new Set();
    } else {
      this.manifest = manifest;
      this.validPeriods = new Set(result.validPeriods);
    }
    return result;
  }

  /** Per-query routing gate. Returns the rollup glob, or undefined to fall back
   *  to raw. */
  resolveSource(args: ResolveSourceArgs): string | undefined {
    if (args.tier !== 'daily') return undefined;
    if (this.manifest === null || this.shape === null) return undefined;
    if (args.requiredPeriods.length === 0) return undefined;
    const grain = new Set<string>([...this.shape.grainDimensions, 'cost', 'line_items']);
    for (const c of args.neededColumns) if (!grain.has(c)) return undefined;
    for (const p of args.requiredPeriods) if (!this.validPeriods.has(p)) return undefined;
    return this.rollupGlob(args.requiredPeriods);
  }

  /** Build (or replace) the given periods, updating the manifest atomically as
   *  each completes. Periods already valid under the current shape are skipped.
   *  Independent months build concurrently (bounded by `buildConcurrency`), each
   *  on a fresh connection, so a full-history rebuild is far faster than the old
   *  sequential pass. Aborts silently if a concurrent invalidate() changed the
   *  epoch. */
  maintainPeriods(
    periods: readonly string[],
    buildSql: BuildPartitionSql,
    etagsByPeriod: Readonly<Record<string, Readonly<Record<string, string>>>>,
    shape: RollupShape,
    opts: { readonly force?: boolean } = {},
  ): Promise<void> {
    return this.enqueue(async (startEpoch) => {
      // A shape change since enqueue invalidates this whole build.
      if (this.shape !== null && this.shape.signature !== shape.signature && this.epoch !== startEpoch) return;
      this.shape = shape;
      let manifest: RollupManifest = this.manifest !== null && this.manifest.shapeSignature === shape.signature
        ? this.manifest
        : { schemaVersion: ROLLUP_SCHEMA_VERSION, shapeSignature: shape.signature, builtAt: '', grainDimensions: shape.grainDimensions, partitions: {} };

      // Progress is reported completed-first: the renderer's status popover
      // labels chip `i` as built when `i < done`, so `periods[0..done)` must be
      // the finished months. Parallel builds complete out of submission order,
      // so we track completion order explicitly rather than assuming input order.
      const total = periods.length;
      let failures = 0;
      // Distinct build-error messages → how many periods hit each. A "14 of 14
      // failed" batch is almost always one systematic cause (bad SQL, missing
      // column, disk full), so the most common message is the reason worth
      // surfacing; we keep counts to note when failures are heterogeneous.
      const errorCounts = new Map<string, number>();
      const completed: string[] = [];
      const completedSet = new Set<string>();
      // `active` = periods whose build is in flight right now. The popover pulses
      // these chips, so a parallel batch — where `done` stays 0 until builds land
      // in a cluster — still visibly shows which months are being worked on.
      const active = new Set<string>();
      const reportProgress = (): void => {
        const pending = periods.filter(p => !completedSet.has(p));
        this.setStatus({ state: 'computing', done: completed.length, total, periods: [...completed, ...pending], active: [...active] });
      };
      const markDone = (period: string): void => {
        if (!completedSet.has(period)) { completedSet.add(period); completed.push(period); }
        reportProgress();
      };
      reportProgress();

      // Split into already-valid (skip) and to-build. Reading manifest.partitions
      // here is safe — it happens before any build starts, so the concurrent
      // commits below can't be mutating it yet.
      const toBuild: string[] = [];
      for (const period of periods) {
        const wantHash = computePartitionEtagHash(etagsByPeriod[period]);
        if (opts.force !== true && manifest.partitions[period]?.rawEtagHash === wantHash) {
          this.validPeriods.add(period);
          markDone(period);
        } else {
          toBuild.push(period);
        }
      }

      if (toBuild.length > 0) {
        // Manifest commits are serialized through this chain so concurrent builds
        // never race on the shared manifest object or its temp file. Each commit
        // re-checks the epoch so a mid-build invalidate() can't resurrect a
        // dropped rollup.
        let commitChain: Promise<void> = Promise.resolve();
        const commit = (period: string, meta: RollupPartitionMeta): Promise<void> => {
          const run = commitChain.then(async () => {
            if (this.epoch !== startEpoch) return;
            manifest = { ...manifest, builtAt: '', partitions: { ...manifest.partitions, [period]: meta } };
            this.manifest = manifest;
            this.validPeriods.add(period);
            await this.writeManifestAtomic(manifest);
          });
          commitChain = run.then(() => undefined, () => undefined);
          return run;
        };

        const buildOne = async (period: string): Promise<void> => {
          if (this.epoch !== startEpoch) return; // superseded before we started
          active.add(period);
          reportProgress(); // chip starts pulsing the moment this period's build begins
          const wantHash = computePartitionEtagHash(etagsByPeriod[period]);
          try {
            const outPath = this.partitionPath(period);
            await mkdir(this.partitionDir(period), { recursive: true });
            // buildSql may be async (it probes this period's parquet schema to
            // emit column-correct SQL) — await before handing it to runBuild.
            await this.runBuild(await buildSql(period, outPath));
            if (this.epoch !== startEpoch) { active.delete(period); return; } // a drop landed during the build
            const meta = await this.partitionMeta(outPath, wantHash);
            await commit(period, meta);
          } catch (err: unknown) {
            failures += 1;
            const msg = err instanceof Error ? err.message : String(err);
            errorCounts.set(msg, (errorCounts.get(msg) ?? 0) + 1);
            logger.warn(`rollup: build failed for ${period} — ${msg}`);
          }
          // Each finished period (built or failed) leaves the active set and
          // advances progress.
          active.delete(period);
          markDone(period);
        };

        await this.runBounded(toBuild, buildOne);
      }

      // A concurrent invalidate() since enqueue means a newer op owns the status.
      if (this.epoch !== startEpoch) return;
      this.setStatus(
        failures > 0
          ? { state: 'failed', message: `${String(failures)} of ${String(total)} rollup partition${total === 1 ? '' : 's'} failed to build`, reason: summarizeErrors(errorCounts), periods: this.validPeriods.size }
          : this.settledStatus(),
      );
    });
  }

  /** Run `worker` over `items` with at most `buildConcurrency` in flight. */
  private async runBounded(items: readonly string[], worker: (item: string) => Promise<void>): Promise<void> {
    let next = 0;
    const lanes = Math.min(this.buildConcurrency, items.length);
    const run = async (): Promise<void> => {
      while (next < items.length) {
        const item = items[next++];
        if (item !== undefined) await worker(item);
      }
    };
    await Promise.all(Array.from({ length: lanes }, run));
  }

  private async partitionMeta(outPath: string, rawEtagHash: string): Promise<RollupPartitionMeta> {
    const g = outPath.replaceAll('\\', '/').replaceAll("'", "''");
    const rows = await this.runQuery(`SELECT COUNT(*)::BIGINT AS n FROM read_parquet('${g}')`);
    const n = rows[0]?.['n'];
    const bytes = (await stat(outPath)).size;
    return { rawEtagHash, rows: typeof n === 'bigint' ? Number(n) : Number(n ?? 0), bytes };
  }

  /** Drop one period's partition + manifest entry (e.g. data:delete-period). */
  deletePeriod(period: string): Promise<void> {
    return this.enqueue(async (startEpoch) => {
      if (this.epoch !== startEpoch) return;
      await rm(this.partitionDir(period), { recursive: true, force: true });
      this.validPeriods.delete(period);
      if (this.manifest !== null && period in this.manifest.partitions) {
        const partitions = Object.fromEntries(Object.entries(this.manifest.partitions).filter(([k]) => k !== period));
        this.manifest = { ...this.manifest, partitions };
        await this.writeManifestAtomic(this.manifest);
      }
    });
  }

  /** Invalidate the whole rollup: bump the epoch (cancels in-flight builds),
   *  clear in-memory state, and remove the on-disk artifact. */
  invalidate(): Promise<void> {
    this.epoch += 1;
    this.manifest = null;
    this.validPeriods = new Set();
    // Signal "rebuilding" immediately — the caller re-warms right after, and the
    // ensuing warmup either drives this through to `ready` (via maintainPeriods,
    // which fills in the period list) or calls markSettled() when there's
    // nothing to rebuild.
    this.setStatus({ state: 'computing', done: 0, total: 0, periods: [], active: [] });
    // Resolve the directory eagerly, while the provider config the providerName
    // closure reads is guaranteed valid. The enqueued deletion runs in a later
    // microtask, by which point a caller (clearAllCaches) may already have
    // nulled that config — reading it there would throw 'No provider configured'
    // and reject the whole operation (remove-provider, bundle import, pull).
    const dir = this.rollupDir();
    return this.enqueue(async () => {
      await rm(dir, { recursive: true, force: true });
    });
  }
}
