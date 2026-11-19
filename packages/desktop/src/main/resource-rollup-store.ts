import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  computePartitionEtagHash,
  isStringRecord,
  logger,
  RESOURCE_ROLLUP_KEY_COLUMNS,
  RESOURCE_ROLLUP_MEASURE_COLUMNS,
  RESOURCE_ROLLUP_PAIRS_PER_MONTH,
  RESOURCE_ROLLUP_SCHEMA_VERSION,
  sqlEscapeString,
  sqlStringLiteral,
  type ProviderName,
} from '@costgoblin/core';
import type { RawRow } from './duckdb-client.js';

/** What the stored bytes depend on: a digest of everything a build reads
 *  (the rollup's own signature covers it), and the columns a row holds. */
export interface ResourceRollupShape {
  readonly signature: string;
  readonly dimensionColumns: readonly string[];
}

/** The two build queries of a month, supplied by the caller (context.ts) so
 *  the store stays decoupled from the query builder. */
export interface ResourceBuildSql {
  /** Rank the month's pairs and write the top `pairs` plus one (`buildResourceTopQuery`). */
  readonly top: (period: string, outPath: string, pairs: number) => string;
  /** Write the month's rows of the pairs listed in `heavyPath` (`buildResourceRowsQuery`). */
  readonly rows: (period: string, outPath: string, heavyPath: string) => string;
}

export interface ResourceMaintainArgs {
  /** Every month the provider has on disk. */
  readonly periods: readonly string[];
  /** Months whose raw files just changed: rebuilt whatever their stamp says. */
  readonly changed?: readonly string[];
  /** Each month's raw-file etags, or null when they can't be read. */
  readonly etagsByPeriod: Readonly<Record<string, Readonly<Record<string, string>>>> | null;
  readonly shape: ResourceRollupShape;
  readonly sql: ResourceBuildSql;
  /** `currentEpoch()` from before `shape` and `sql` were worked out. A drop
   *  since then means they may describe the rollup that was dropped: the
   *  call then builds nothing. */
  readonly epoch?: number;
}

/** One built month. */
export interface ResourcePartitionMeta {
  /** Hash of the month's raw-file etags when its top pairs were ranked. */
  readonly rawEtagHash: string;
  /** Weight of the heaviest pair the month leaves out; 0 when it leaves none out. */
  readonly tailBound: number;
  /** True when the month's top list holds every pair it has. */
  readonly complete: boolean;
  readonly rows: number;
  readonly bytes: number;
}

interface ResourceRollupManifest {
  readonly schemaVersion: number;
  readonly shapeSignature: string;
  readonly pairsPerMonth: number;
  /** Names this build's files; every partition below belongs to it. */
  readonly generation: number;
  readonly dimensionColumns: readonly string[];
  readonly partitions: Readonly<Record<string, ResourcePartitionMeta>>;
}

/** Where a query over some months reads the resource rollup. */
export interface ResourceRollupSource {
  /** The months' rows, as a FROM source. */
  readonly source: string;
  /** The pairs stored whole in every month, as a FROM source. */
  readonly heavySource: string;
  /** No pair outside `heavySource` costs more than this over the months, in
   *  either direction and under any filter: the months' tail bounds, added. */
  readonly tailBound: number;
  /** True when no month leaves a pair out: the rows hold every pair. */
  readonly complete: boolean;
}

interface ResourceRollupStoreDeps {
  readonly dataDir: string;
  /** Which provider's tree (`{dataDir}/{name}/resource-rollup`) this store
   *  owns. Throws with no provider configured, as RollupStore's does. */
  readonly providerName: () => ProviderName;
  /** Runs the store's own small queries: the heavy set, a tail read, a row
   *  count. They are steps of a build, so whatever runs them must be out of
   *  reach of a view's cancel, as `runBuild` is. */
  readonly runQuery: (sql: string) => Promise<RawRow[]>;
  /** Runs a build query on a fresh connection. Defaults to `runQuery`. */
  readonly runBuild?: (sql: string) => Promise<RawRow[]>;
  /** Max months built at once. Defaults to 1. */
  readonly buildConcurrency?: number;
  /** Pairs each month adds to the heavy set. */
  readonly pairsPerMonth?: number;
}

const MANIFEST_FILE = 'manifest.json';
const PROVIDER_COLUMN = 'provider';
function partitionMetaOf(raw: unknown): ResourcePartitionMeta | null {
  if (!isStringRecord(raw)) return null;
  const { rawEtagHash, tailBound, complete, rows, bytes } = raw;
  if (typeof rawEtagHash !== 'string' || typeof complete !== 'boolean') return null;
  if (typeof rows !== 'number' || typeof bytes !== 'number') return null;
  // A bound that isn't a number (JSON has none for NaN or Infinity) bounds nothing.
  return { rawEtagHash, tailBound: typeof tailBound === 'number' ? tailBound : Number.POSITIVE_INFINITY, complete, rows, bytes };
}

/** A manifest file's contents, or null when they aren't a manifest. */
function parseManifest(raw: string): ResourceRollupManifest | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!isStringRecord(parsed)) return null;
  const { schemaVersion, shapeSignature, pairsPerMonth, generation, dimensionColumns, partitions } = parsed;
  if (typeof schemaVersion !== 'number' || typeof shapeSignature !== 'string') return null;
  if (typeof pairsPerMonth !== 'number' || typeof generation !== 'number') return null;
  if (!Array.isArray(dimensionColumns) || !isStringRecord(partitions)) return null;
  const columns = dimensionColumns.filter((c): c is string => typeof c === 'string');
  const metas: Record<string, ResourcePartitionMeta> = {};
  for (const [period, meta] of Object.entries(partitions)) {
    const parsedMeta = partitionMetaOf(meta);
    if (parsedMeta !== null) metas[period] = parsedMeta;
  }
  return { schemaVersion, shapeSignature, pairsPerMonth, generation, dimensionColumns: columns, partitions: metas };
}

function toNumber(v: unknown): number {
  if (typeof v === 'bigint') return Number(v);
  return typeof v === 'number' ? v : 0;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The persisted resource rollup of one provider (see resource-rollup.ts in
 * core for what it holds and why a page read from it is exact), under
 * `{dataDir}/{provider}/resource-rollup/`:
 *
 *   manifest.json                     the generation being served
 *   heavy-{generation}.parquet        the heavy set: resource_id, description
 *   daily-YYYY-MM/top.parquet         the month's ranked pairs
 *   daily-YYYY-MM/rows-{generation}.parquet   the month's rows of the heavy set
 *
 * A month is a billing period: one raw directory's files, whole, with the
 * days of other months they hold. A caller asks for the months its date range
 * reads (`periodsForRange`), and filters on the date itself.
 *
 * A month's top list depends on its raw files only. The heavy set is the
 * union of every month's top list, and every month's rows are extracted
 * against it, so one month's raw files changing rebuilds every month's rows:
 * a pair that just became heavy somewhere must be whole everywhere. That is a
 * keyed scan a month, cheap next to ranking.
 *
 * Correctness invariants:
 *  - All mutations are serialized through a single-writer queue, and
 *    `invalidate()` bumps an epoch that an in-flight build checks before it
 *    commits, as in RollupStore.
 *  - A build writes a new generation beside the one being served and commits
 *    it with one atomic manifest write, so a query never sees months
 *    extracted against two heavy sets. The files of the generation it
 *    replaces stay until the next build: a query planned a moment earlier
 *    still finds them.
 *  - `resolveSource` routes here only when every month asked for is in the
 *    committed generation under its current raw files. A month marked stale
 *    stays out until a build that started after the mark has rebuilt it.
 *  - A generation number is never used twice by one process, so the SQL text
 *    of a query over one generation never reads another: the result cache is
 *    keyed on that text.
 *  - A cancelled query is a failed one and is not run again. A view's cancel
 *    spares builds, so a cancel that reaches one is the cancel-everything of
 *    a caller about to drop what the build reads (a cache clear, a provider's
 *    removal): running it again would reopen those files. The warmup that
 *    follows such a drop rebuilds.
 */
export class ResourceRollupStore {
  private readonly dataDir: string;
  private readonly providerName: () => ProviderName;
  private readonly runQuery: (sql: string) => Promise<RawRow[]>;
  private readonly runBuild: (sql: string) => Promise<RawRow[]>;
  private readonly pairsPerMonth: number;
  private buildConcurrency: number;

  private manifest: ResourceRollupManifest | null = null;
  private validPeriods = new Set<string>();
  /** Months marked stale that no build has started on since. */
  private pendingStale = new Set<string>();
  /** The highest generation this process has written. */
  private lastGeneration = 0;
  private epoch = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(deps: ResourceRollupStoreDeps) {
    this.dataDir = deps.dataDir;
    this.providerName = deps.providerName;
    this.runQuery = deps.runQuery;
    this.runBuild = deps.runBuild ?? deps.runQuery;
    this.buildConcurrency = Math.max(1, deps.buildConcurrency ?? 1);
    this.pairsPerMonth = Math.max(1, Math.round(deps.pairsPerMonth ?? RESOURCE_ROLLUP_PAIRS_PER_MONTH));
  }

  setBuildConcurrency(n: number): void {
    this.buildConcurrency = Math.max(1, Math.round(n));
  }

  isReady(): boolean { return this.manifest !== null && this.validPeriods.size > 0; }
  /** Changes with every `invalidate()`: see `ResourceMaintainArgs.epoch`. */
  currentEpoch(): number { return this.epoch; }
  getValidPeriods(): ReadonlySet<string> { return this.validPeriods; }

  /** Settles once every mutation queued so far has run. */
  whenIdle(): Promise<void> {
    return this.queue.then(() => undefined);
  }

  private rollupDir(): string { return join(this.dataDir, String(this.providerName()), 'resource-rollup'); }
  private manifestPath(): string { return join(this.rollupDir(), MANIFEST_FILE); }
  private partitionDir(period: string): string { return join(this.rollupDir(), `daily-${period}`); }
  private topPath(period: string): string { return join(this.partitionDir(period), 'top.parquet'); }
  private rowsFile(generation: number): string { return `rows-${String(generation)}.parquet`; }
  private rowsPath(period: string, generation: number): string { return join(this.partitionDir(period), this.rowsFile(generation)); }
  private heavyFile(generation: number): string { return `heavy-${String(generation)}.parquet`; }
  private heavyPath(generation: number): string { return join(this.rollupDir(), this.heavyFile(generation)); }

  private enqueue<T>(fn: (epoch: number) => Promise<T>): Promise<T> {
    const startEpoch = this.epoch;
    const run = this.queue.then(() => fn(startEpoch));
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async readManifest(): Promise<ResourceRollupManifest | null> {
    try {
      return parseManifest(await readFile(this.manifestPath(), 'utf-8'));
    } catch {
      return null;
    }
  }

  private async writeManifestAtomic(manifest: ResourceRollupManifest): Promise<void> {
    await mkdir(this.rollupDir(), { recursive: true });
    const tmp = `${this.manifestPath()}.tmp`;
    await writeFile(tmp, JSON.stringify(manifest, null, 2));
    await rename(tmp, this.manifestPath());
  }

  /** `manifest` when it was built for `shape` by this build of the app, with
   *  this store's pair count. */
  private usable(manifest: ResourceRollupManifest | null, shape: ResourceRollupShape): ResourceRollupManifest | null {
    if (manifest === null) return null;
    const matches = manifest.schemaVersion === RESOURCE_ROLLUP_SCHEMA_VERSION
      && manifest.shapeSignature === shape.signature
      && manifest.pairsPerMonth === this.pairsPerMonth;
    return matches ? manifest : null;
  }

  /** Stop serving `periods` now: their raw files just changed. They stay
   *  out, whatever a build already running commits, until a `maintain` that
   *  starts after this call has rebuilt them. */
  markStale(periods: readonly string[]): void {
    for (const period of periods) {
      this.validPeriods.delete(period);
      this.pendingStale.add(period);
    }
  }

  /** Per-query routing gate: where to read `requiredPeriods` from, or
   *  undefined when the caller must read raw Parquet. The caller applies its
   *  own date-range WHERE, as with RollupStore. */
  resolveSource(args: { readonly requiredPeriods: readonly string[]; readonly neededColumns: readonly string[] }): ResourceRollupSource | undefined {
    const manifest = this.manifest;
    if (manifest === null || args.requiredPeriods.length === 0) return undefined;
    const columns = new Set<string>([...manifest.dimensionColumns, ...RESOURCE_ROLLUP_MEASURE_COLUMNS, PROVIDER_COLUMN]);
    if (args.neededColumns.some(c => !columns.has(c))) return undefined;
    let tailBound = 0;
    let complete = true;
    const paths: string[] = [];
    for (const period of args.requiredPeriods) {
      const meta = manifest.partitions[period];
      if (meta === undefined || !this.validPeriods.has(period)) return undefined;
      tailBound += meta.tailBound;
      complete &&= meta.complete;
      paths.push(sqlStringLiteral(this.rowsPath(period, manifest.generation).replaceAll('\\', '/')));
    }
    // `provider` comes back as the constant it is here: this store holds one
    // provider's tree, and partitions don't store the column (`buildSource`
    // injects it per branch on the raw path).
    const provider = sqlEscapeString(String(this.providerName()));
    return {
      source: `(SELECT *, '${provider}' AS ${PROVIDER_COLUMN} FROM read_parquet([${paths.join(', ')}]))`,
      heavySource: `read_parquet(${sqlStringLiteral(this.heavyPath(manifest.generation).replaceAll('\\', '/'))})`,
      tailBound,
      complete,
    };
  }

  /** Bring the rollup in line with the raw files: rank the months whose raw
   *  files changed, then extract every month's rows against the new heavy
   *  set, as one new generation. The first call after a start reads the
   *  manifest on disk; a call finding every month built from its current raw
   *  files builds nothing. A month whose build fails is left out, and
   *  ranges touching it read raw until the next call; the rest still serve.
   *  Never rejects. */
  maintain(args: ResourceMaintainArgs): Promise<void> {
    if (args.epoch !== undefined && args.epoch !== this.epoch) return Promise.resolve();
    return this.enqueue(async (startEpoch) => {
      // An invalidate() since this was queued dropped the tree; the warmup
      // that follows it rebuilds.
      if (this.epoch !== startEpoch) return;
      try {
        await this.rebuild(args, startEpoch);
      } catch (err: unknown) {
        logger.warn(`resource-rollup: build failed — ${errorMessage(err)}`);
      }
    });
  }

  private async rebuild(args: ResourceMaintainArgs, startEpoch: number): Promise<void> {
    const { periods, etagsByPeriod, shape, sql } = args;
    // A month marked stale is rebuilt whoever asked for this build.
    const changed = new Set([...(args.changed ?? []), ...this.pendingStale]);
    // After a restart, or a drop, the manifest on disk is the last word.
    const previous = this.usable(this.manifest ?? await this.readManifest(), shape);
    this.manifest = previous;

    if (etagsByPeriod === null) {
      // Nothing to check a month against, or to stamp a build with: serve
      // what was being served, minus the months that changed, and leave the
      // rebuild to the next call that can read the etags.
      for (const period of changed) this.validPeriods.delete(period);
      if (previous === null) this.validPeriods = new Set();
      return;
    }
    const stampFor = (period: string): string => computePartitionEtagHash(etagsByPeriod[period]);
    const current = (period: string): boolean => !changed.has(period) && previous?.partitions[period]?.rawEtagHash === stampFor(period);
    this.validPeriods = new Set(Object.keys(previous?.partitions ?? {}).filter(current));
    const stale = periods.filter(p => !current(p));
    // From here this build reads their current raw files: a mark made later
    // is for a later build.
    for (const period of changed) this.pendingStale.delete(period);
    if (stale.length === 0) return;

    const generation = Math.max(previous?.generation ?? 0, this.lastGeneration) + 1;
    this.lastGeneration = generation;
    await this.removeSupersededFiles(previous?.generation ?? null);

    // 1. Rank the months whose raw files changed. The others keep their list.
    const ranked = new Map<string, { readonly tailBound: number; readonly complete: boolean }>();
    for (const period of periods) {
      const kept = stale.includes(period) ? undefined : previous?.partitions[period];
      if (kept !== undefined) ranked.set(period, kept);
    }
    await this.runBounded(stale, async (period) => {
      // Dropped meanwhile: nothing built from here on could be committed.
      if (this.epoch !== startEpoch) return;
      try {
        await mkdir(this.partitionDir(period), { recursive: true });
        await this.runBuild(sql.top(period, this.topPath(period), this.pairsPerMonth));
        ranked.set(period, await this.readTailOf(period));
      } catch (err: unknown) {
        logger.warn(`resource-rollup: ranking ${period} failed — ${errorMessage(err)}`);
      }
    });
    if (this.epoch !== startEpoch || ranked.size === 0) return;

    // 2. The heavy set: every ranked month's top pairs.
    const builtPeriods = periods.filter(p => ranked.has(p));
    const tops = builtPeriods.map(p => sqlStringLiteral(this.topPath(p).replaceAll('\\', '/'))).join(', ');
    const key = RESOURCE_ROLLUP_KEY_COLUMNS.join(', ');
    const heavyPath = this.heavyPath(generation);
    await this.runQuery(
      `COPY (SELECT DISTINCT ${key} FROM read_parquet([${tops}]) WHERE rank <= ${String(this.pairsPerMonth)}) ` +
      `TO ${sqlStringLiteral(heavyPath)} (FORMAT PARQUET)`,
    );

    // 3. Every month's rows of the heavy set.
    const partitions: Record<string, ResourcePartitionMeta> = {};
    await this.runBounded(builtPeriods, async (period) => {
      const tail = ranked.get(period);
      if (tail === undefined || this.epoch !== startEpoch) return;
      try {
        const outPath = this.rowsPath(period, generation);
        await this.runBuild(sql.rows(period, outPath, heavyPath));
        const counted = await this.runQuery(`SELECT COUNT(*)::BIGINT AS n FROM read_parquet(${sqlStringLiteral(outPath.replaceAll('\\', '/'))})`);
        partitions[period] = {
          rawEtagHash: stampFor(period),
          tailBound: tail.tailBound,
          complete: tail.complete,
          rows: toNumber(counted[0]?.['n']),
          bytes: (await stat(outPath)).size,
        };
      } catch (err: unknown) {
        logger.warn(`resource-rollup: extracting ${period} failed — ${errorMessage(err)}`);
      }
    });
    if (this.epoch !== startEpoch) return;

    const manifest: ResourceRollupManifest = {
      schemaVersion: RESOURCE_ROLLUP_SCHEMA_VERSION,
      shapeSignature: shape.signature,
      pairsPerMonth: this.pairsPerMonth,
      generation,
      dimensionColumns: [...shape.dimensionColumns],
      partitions,
    };
    await this.writeManifestAtomic(manifest);
    // Dropped while the manifest was being written: the removal queued behind
    // this build takes the files, so nothing here may point at them.
    if (this.epoch !== startEpoch) return;
    this.manifest = manifest;
    // Not the months marked stale since this build started on them.
    this.validPeriods = new Set(Object.keys(partitions).filter(period => !this.pendingStale.has(period)));
  }

  /** The tail bound the month's ranked list holds: the weight of the row
   *  ranked past the kept pairs, when there is one. */
  private async readTailOf(period: string): Promise<{ tailBound: number; complete: boolean }> {
    const rows = await this.runQuery(
      `SELECT MAX(weight) AS tail_bound, COUNT(*)::BIGINT AS left_out ` +
      `FROM read_parquet(${sqlStringLiteral(this.topPath(period).replaceAll('\\', '/'))}) WHERE rank > ${String(this.pairsPerMonth)}`,
    );
    const leftOut = toNumber(rows[0]?.['left_out']);
    if (leftOut === 0) return { tailBound: 0, complete: true };
    const bound = rows[0]?.['tail_bound'];
    // A weight that isn't a finite number bounds nothing.
    return { tailBound: typeof bound === 'number' && Number.isFinite(bound) ? bound : Number.POSITIVE_INFINITY, complete: false };
  }

  private async runBounded(items: readonly string[], worker: (item: string) => Promise<void>): Promise<void> {
    let next = 0;
    const run = async (): Promise<void> => {
      while (next < items.length) {
        const item = items[next++];
        if (item !== undefined) await worker(item);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.buildConcurrency, items.length) }, run));
  }

  /** Delete the heavy sets and rows files of every generation but `served`:
   *  the one a build replaced the last time, and what an interrupted build
   *  left. Best-effort. */
  private async removeSupersededFiles(served: number | null): Promise<void> {
    const dir = this.rollupDir();
    const keep = served === null ? new Set<string>() : new Set([this.heavyFile(served), this.rowsFile(served)]);
    const superseded = (name: string, prefix: string): boolean => name.startsWith(prefix) && !keep.has(name);
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      const heavy = entries.filter(e => e.isFile() && superseded(e.name, 'heavy-')).map(e => join(dir, e.name));
      const months = entries.filter(e => e.isDirectory() && e.name.startsWith('daily-')).map(e => join(dir, e.name));
      const rows = await Promise.all(months.map(async month =>
        (await readdir(month)).filter(file => superseded(file, 'rows-')).map(file => join(month, file))));
      await Promise.all([...heavy, ...rows.flat()].map(file => rm(file, { force: true })));
    } catch (err: unknown) {
      if (!(err instanceof Error && 'code' in err && err.code === 'ENOENT')) {
        logger.warn(`resource-rollup: could not remove superseded files — ${errorMessage(err)}`);
      }
    }
  }

  /** Drop one month's partition and manifest entry (data:delete-period). The
   *  pairs it made heavy stay stored in the other months, where they are
   *  still whole. */
  deletePeriod(period: string): Promise<void> {
    return this.enqueue(async (startEpoch) => {
      if (this.epoch !== startEpoch) return;
      await rm(this.partitionDir(period), { recursive: true, force: true });
      this.validPeriods.delete(period);
      this.pendingStale.delete(period);
      const manifest = this.manifest ?? await this.readManifest();
      // Dropped meanwhile: the queued removal takes the whole tree.
      if (this.epoch !== startEpoch) return;
      if (manifest !== null && period in manifest.partitions) {
        const partitions = Object.fromEntries(Object.entries(manifest.partitions).filter(([k]) => k !== period));
        const next = { ...manifest, partitions };
        if (this.manifest !== null) this.manifest = next;
        await this.writeManifestAtomic(next);
      }
    });
  }

  /** Drop the whole rollup: bump the epoch (an in-flight build won't commit),
   *  clear in-memory state, remove the tree. Never rejects, and tolerates no
   *  provider being configured, for the reasons RollupStore.invalidate gives. */
  invalidate(): Promise<void> {
    this.epoch += 1;
    this.manifest = null;
    this.validPeriods = new Set();
    this.pendingStale = new Set();
    let dir: string | null = null;
    try {
      dir = this.rollupDir();
    } catch {
      dir = null;
    }
    return this.enqueue(async () => {
      if (dir === null) return;
      try {
        // Manifest first: once it is gone nothing left under `dir` is served.
        await rm(join(dir, MANIFEST_FILE), { force: true }).catch((err: unknown) => {
          if (!(err instanceof Error && 'code' in err && err.code === 'ENOTDIR')) throw err;
        });
        await rm(dir, { recursive: true, force: true });
      } catch (err: unknown) {
        logger.warn(`resource-rollup: could not remove the invalidated rollup — ${errorMessage(err)}`);
      }
    });
  }
}
