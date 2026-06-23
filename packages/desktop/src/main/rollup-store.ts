import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  computePartitionEtagHash,
  logger,
  ROLLUP_SCHEMA_VERSION,
  validateManifest,
  type RollupManifest,
  type RollupPartitionMeta,
} from '@costgoblin/core';
import type { RawRow } from './duckdb-client.js';

/** Builds the `COPY (...) TO '<outPath>' (FORMAT PARQUET)` DDL for one period.
 *  Supplied by the caller (context.ts) so the store stays decoupled from the
 *  query builder. */
export type BuildPartitionSql = (period: string, outPath: string) => string;

export interface RollupShape {
  readonly signature: string;
  readonly grainDimensions: readonly string[];
  readonly availableColumns: readonly string[];
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
  readonly runQuery: (sql: string) => Promise<RawRow[]>;
}

/**
 * Persistent per-period pre-aggregated rollup, stored as Hive-style Parquet
 * partitions under `{dataDir}/aws/rollup/daily-YYYY-MM/rollup.parquet` with a
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
  private readonly runQuery: (sql: string) => Promise<RawRow[]>;

  private manifest: RollupManifest | null = null;
  private shape: RollupShape | null = null;
  private validPeriods = new Set<string>();
  private epoch = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(deps: RollupStoreDeps) {
    this.dataDir = deps.dataDir;
    this.runQuery = deps.runQuery;
  }

  private rollupDir(): string { return join(this.dataDir, 'aws', 'rollup'); }
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

  /** Build (or replace) the given periods, updating the manifest atomically
   *  after each. Periods already valid under the current shape are skipped.
   *  Aborts silently if a concurrent invalidate() changed the epoch. */
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
        : { schemaVersion: ROLLUP_SCHEMA_VERSION, shapeSignature: shape.signature, builtAt: '', grainDimensions: shape.grainDimensions, availableColumns: shape.availableColumns, partitions: {} };

      for (const period of periods) {
        if (this.epoch !== startEpoch) return; // superseded mid-build
        const wantHash = computePartitionEtagHash(etagsByPeriod[period]);
        if (opts.force !== true && manifest.partitions[period]?.rawEtagHash === wantHash) {
          this.validPeriods.add(period);
          continue;
        }
        try {
          const outPath = this.partitionPath(period);
          await mkdir(this.partitionDir(period), { recursive: true });
          await this.runQuery(buildSql(period, outPath));
          const meta = await this.partitionMeta(outPath, wantHash);
          if (this.epoch !== startEpoch) return; // a drop landed during the build
          manifest = { ...manifest, builtAt: '', partitions: { ...manifest.partitions, [period]: meta } };
          this.manifest = manifest;
          this.validPeriods.add(period);
          await this.writeManifestAtomic(manifest);
        } catch (err: unknown) {
          logger.warn(`rollup: build failed for ${period} — ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });
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
    return this.enqueue(async () => {
      await rm(this.rollupDir(), { recursive: true, force: true });
    });
  }
}
