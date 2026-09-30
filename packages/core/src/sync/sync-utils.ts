import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { isStringRecord } from '../utils/json.js';
import { logger } from '../logger/logger.js';
import type { ProviderName } from '../types/branded.js';
import type { ProviderConfig } from '../types/config.js';
import type { ManifestFileEntry } from './manifest.js';
import { providerEtagPath, providerMetaDir } from './provider-paths.js';

export type ExpectedDataType = 'daily' | 'hourly' | 'cost-optimization';

const TIER_ETAG_FILES: Record<ExpectedDataType, string> = {
  'daily': 'sync-etags.json',
  'hourly': 'sync-etags-hourly.json',
  'cost-optimization': 'sync-etags-cost-optimization.json',
};

const TIER_RAW_PREFIXES: Record<ExpectedDataType, string> = {
  'daily': 'daily',
  'hourly': 'hourly',
  'cost-optimization': 'cost-opt',
};

export function getEtagFileName(tier: string): string {
  if (tier === 'hourly' || tier === 'cost-optimization' || tier === 'daily') {
    return TIER_ETAG_FILES[tier];
  }
  return TIER_ETAG_FILES['daily'];
}

/**
 * Returns the directory-name prefix used under {providerName}/raw/ for a
 * given tier. Files for a period live under {providerName}/raw/{prefix}-{period}/
 * — e.g. aws-main/raw/daily-2026-04/, aws-main/raw/cost-opt-2026-04-08/.
 */
export function getRawDirPrefix(tier: string): string {
  if (tier === 'hourly' || tier === 'cost-optimization' || tier === 'daily') {
    return TIER_RAW_PREFIXES[tier];
  }
  return TIER_RAW_PREFIXES['daily'];
}

/**
 * Bucket location for one provider's tier. Shared by manual and background
 * sync so both resolve buckets identically.
 *
 * The `gcp` arm is checked first and deliberately does NOT take the AWS
 * fallback below (`hourly ?? daily`). An unconfigured GCP hourly tier means
 * the exporter is not publishing that grain at all, so falling back would sync
 * rolled-up daily rows into `raw/hourly-*` — the intraday views would then
 * render one flat 24-hour block per day and look like a data bug rather than a
 * missing configuration.
 */
export function resolveBucketPath(provider: ProviderConfig, tier: ExpectedDataType): string {
  if (provider.type === 'gcp') {
    if (tier === 'cost-optimization') {
      throw new Error(`Provider "${provider.name}" is a GCP billing export, which has no Cost Optimization Hub analogue`);
    }
    if (tier === 'hourly') {
      const hourlyBucket = provider.sync.hourly?.bucket;
      if (hourlyBucket === undefined) {
        throw new Error(`Provider "${provider.name}" has no sync.hourly bucket — set TIERS=daily,hourly on the exporter and add sync.hourly to the provider`);
      }
      return hourlyBucket;
    }
    return provider.sync.daily.bucket;
  }
  if (tier === 'hourly') {
    return provider.sync.hourly?.bucket ?? provider.sync.daily.bucket;
  }
  if (tier === 'cost-optimization') {
    const costOptBucket = provider.sync.costOptimization?.bucket;
    if (costOptBucket === undefined) throw new Error('Cost optimization not configured');
    return costOptBucket;
  }
  return provider.sync.daily.bucket;
}

/**
 * Lists YYYY-MM period directories on disk for one provider's tier. Used by
 * query handlers to intersect a date range's required months with what's
 * actually been synced — DuckDB's read_parquet errors on glob patterns that
 * match zero files, so missing months must be filtered out before query time.
 */
export async function listLocalMonths(dataDir: string, provider: ProviderName, tier: string): Promise<string[]> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const prefix = getRawDirPrefix(tier);
  const rawDir = path.join(dataDir, String(provider), 'raw');
  try {
    const entries = await fs.readdir(rawDir);
    const months = new Set<string>();
    for (const entry of entries) {
      if (!entry.startsWith(`${prefix}-`)) continue;
      const period = entry.slice(prefix.length + 1).slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(period)) continue;
      // Must contain at least one .parquet — otherwise DuckDB errors on the
      // glob. Empty dirs can linger after interrupted downloads or partial
      // deletes; silently skip them.
      try {
        const files = await fs.readdir(path.join(rawDir, entry));
        if (files.some(f => f.endsWith('.parquet'))) months.add(period);
      } catch { /* dir vanished mid-scan */ }
    }
    return [...months].sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

// AWS Data Exports partition the delivery by billing period. FOCUS 1.2
// exports use lowercase `billing_period=YYYY-MM`. The match is deliberately
// case-SENSITIVE: CUR 2.0 used uppercase `BILLING_PERIOD=`, and a bucket
// still holding a leftover CUR subtree next to the FOCUS export must not
// have both grouped into one period (that would sync mixed-schema files
// into the same local dir). CUR-era keys are simply invisible.
export function extractPeriod(key: string): string {
  const billingMatch = /billing_period=(\d{4}-\d{2})/.exec(key);
  if (billingMatch?.[1] !== undefined) return billingMatch[1];
  const dateMatch = /date=(\d{4}-\d{2})-\d{2}/.exec(key);
  return dateMatch?.[1] ?? 'unknown';
}

export function extractPeriodPrefix(key: string): string {
  const billingMatch = /^(.*billing_period=\d{4}-\d{2}\/)/.exec(key);
  if (billingMatch?.[1] !== undefined) return billingMatch[1];
  const dateMatch = /^(.*date=\d{4}-\d{2}-\d{2}\/)/.exec(key);
  return dateMatch?.[1] ?? '';
}

export function extractDate(key: string): string | undefined {
  const match = /date=(\d{4}-\d{2}-\d{2})/.exec(key);
  return match?.[1];
}

/** Where one listed Parquet key sits in its export's partition layout. */
export type Partition =
  | { readonly kind: 'billing-period'; readonly prefix: string; readonly period: string }
  | { readonly kind: 'date'; readonly prefix: string; readonly period: string; readonly date: string };

const BILLING_PERIOD_SEGMENT = /^billing_period=(\d{4}-\d{2})$/;
const DATE_SEGMENT = /^date=((\d{4}-\d{2})-\d{2})$/;

/** The partition folder each tier expects, for user-facing messages. */
export function partitionFolderLabel(tier: ExpectedDataType): string {
  return tier === 'cost-optimization' ? 'date=YYYY-MM-DD/' : 'billing_period=YYYY-MM/';
}

/**
 * Reads a key's partition from its LAST folder segment — never the file name,
 * never a substring. The returned `prefix` is the folder `aws s3 sync` mirrors,
 * so it must be a whole partition folder: the substring matchers above let
 * `date=2026-01-01_part-0.parquet` produce a period with an empty prefix, which
 * collapsed the sync source to the bucket root.
 *
 *  - daily / hourly: exactly lowercase `billing_period=YYYY-MM`. No `date=`
 *    fallback, and CUR-era uppercase `BILLING_PERIOD=` stays invisible (see
 *    `extractPeriod`).
 *  - cost-optimization: exactly `date=YYYY-MM-DD`; the period is its YYYY-MM.
 *
 * `prefix` is every segment up to and including the partition folder, plus `/`.
 */
export function parsePartition(key: string, tier: ExpectedDataType): Partition | null {
  const segments = key.split('/');
  const fileName = segments.at(-1);
  const folder = segments.at(-2);
  if (fileName === undefined || fileName.length === 0 || folder === undefined) return null;
  const prefix = `${segments.slice(0, -1).join('/')}/`;

  if (tier === 'cost-optimization') {
    const match = DATE_SEGMENT.exec(folder);
    const date = match?.[1];
    const period = match?.[2];
    if (date === undefined || period === undefined) return null;
    return { kind: 'date', prefix, period, date };
  }

  const period = BILLING_PERIOD_SEGMENT.exec(folder)?.[1];
  if (period === undefined) return null;
  return { kind: 'billing-period', prefix, period };
}

export function groupByPeriod(files: readonly ManifestFileEntry[]): Map<string, ManifestFileEntry[]> {
  const groups = new Map<string, ManifestFileEntry[]>();
  for (const file of files) {
    const period = extractPeriod(file.key);
    const existing = groups.get(period);
    if (existing === undefined) {
      groups.set(period, [file]);
    } else {
      existing.push(file);
    }
  }
  return groups;
}

const AWS_UNIT_BYTES: Record<string, number> = {
  B: 1,
  KiB: 1024,
  MiB: 1024 * 1024,
  GiB: 1024 * 1024 * 1024,
  TiB: 1024 * 1024 * 1024 * 1024,
};

/**
 * Parses an `aws s3 sync` "Completed" progress line into byte counts. Format
 * varies — typical shape: `Completed 203.6 MiB/404.2 MiB (3.0 MiB/s) with 7
 * file(s) remaining`. Returns null when the line is in a form without
 * total-known byte counts (e.g. `Completed N file(s) ...`), so callers can
 * leave the previous numbers in place.
 */
export function parseAwsCompletedBytes(line: string): { bytesDone: number; bytesTotal: number } | null {
  const match = /^Completed\s+([\d.]+)\s+(B|KiB|MiB|GiB|TiB)\/([\d.]+)\s+(B|KiB|MiB|GiB|TiB)\b/.exec(line);
  if (match === null) return null;
  const [, doneNum, doneUnit, totalNum, totalUnit] = match;
  if (doneNum === undefined || doneUnit === undefined || totalNum === undefined || totalUnit === undefined) return null;
  const doneFactor = AWS_UNIT_BYTES[doneUnit];
  const totalFactor = AWS_UNIT_BYTES[totalUnit];
  if (doneFactor === undefined || totalFactor === undefined) return null;
  const bytesDone = Number.parseFloat(doneNum) * doneFactor;
  const bytesTotal = Number.parseFloat(totalNum) * totalFactor;
  if (!Number.isFinite(bytesDone) || !Number.isFinite(bytesTotal) || bytesTotal <= 0) return null;
  return { bytesDone, bytesTotal };
}

/**
 * Parses a sync-etags JSON file. Returns an empty record on any malformed input.
 * Shape: `{ [period: string]: { [fileKey: string]: contentHash } }`
 */
export function parseEtagsJson(raw: string): Record<string, Record<string, string>> {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {
    logger.warn('Failed to parse sync-etags JSON — will re-download all files', { rawLength: raw.length });
    return {};
  }
  if (!isStringRecord(parsed)) {
    logger.warn('sync-etags JSON is not a valid object — will re-download all files');
    return {};
  }

  const result: Record<string, Record<string, string>> = {};
  for (const [period, periodEtags] of Object.entries(parsed)) {
    if (!isStringRecord(periodEtags)) continue;
    const stringEtags: Record<string, string> = {};
    for (const [key, hash] of Object.entries(periodEtags)) {
      if (typeof hash === 'string') stringEtags[key] = hash;
    }
    result[period] = stringEtags;
  }
  return result;
}

type EtagSidecar = Record<string, Record<string, string>>;

function hasErrnoCode(err: unknown, codes: readonly string[]): boolean {
  return err instanceof Error && 'code' in err && typeof err.code === 'string' && codes.includes(err.code);
}

// A Windows antivirus, indexer or backup tool can briefly hold the sidecar or
// a just-written temp file (EPERM/EACCES/EBUSY on open or rename), and a busy
// process can momentarily run out of descriptors (EMFILE). Those are retried
// with backoff; anything else, or one that outlasts the backoff, propagates.
const TRANSIENT_FS_ERRORS: readonly string[] = ['EPERM', 'EACCES', 'EBUSY', 'EMFILE'];
const TRANSIENT_RETRY_DELAYS_MS: readonly number[] = [25, 50, 100, 200, 400, 800];

async function retryTransient<T>(op: () => Promise<T>): Promise<T> {
  for (const delayMs of TRANSIENT_RETRY_DELAYS_MS) {
    try {
      return await op();
    } catch (err: unknown) {
      if (!hasErrnoCode(err, TRANSIENT_FS_ERRORS)) throw err;
      await sleep(delayMs);
    }
  }
  return op();
}

/** Raw sidecar text, or null when there is none yet. Only ENOENT means that:
 *  reading any other failure as an empty sidecar would rewrite it with just
 *  the caller's change and turn every other period stale. */
async function readEtagSidecarRaw(etagPath: string): Promise<string | null> {
  try {
    return await retryTransient(() => readFile(etagPath, 'utf-8'));
  } catch (err: unknown) {
    if (hasErrnoCode(err, ['ENOENT'])) return null;
    throw err;
  }
}

// A writer that dies between writing its temp file and renaming it (the sync
// worker dies with the app; a crash) never reaches its cleanup, and the temp's
// random name is never reused, so sweep them. A live update's temp is
// milliseconds old: an hour is far past anything still in flight.
const STALE_TEMP_AGE_MS = 60 * 60 * 1000;

async function sweepStaleTemps(etagPath: string): Promise<void> {
  const dir = dirname(etagPath);
  const prefix = `${basename(etagPath)}.`;
  const names = await readdir(dir).catch((): string[] => []);
  const cutoff = Date.now() - STALE_TEMP_AGE_MS;
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
    const tmpPath = join(dir, name);
    const info = await stat(tmpPath).catch(() => null);
    if (info !== null && info.mtimeMs < cutoff) {
      await rm(tmpPath, { force: true }).catch(() => { /* best effort */ });
    }
  }
}

/** Times one update re-applies itself to a sidecar another thread replaced
 *  underneath it before giving up. Committing anyway would overwrite that
 *  thread's change with a merge onto a stale read. */
const MAX_REMERGES = 5;

async function replaceEtagSidecar(
  etagPath: string,
  mutate: (etags: EtagSidecar) => EtagSidecar | null,
): Promise<void> {
  await sweepStaleTemps(etagPath);
  // Beside the sidecar so the rename never crosses a filesystem; unique so two
  // threads' updates never share one.
  const tmpPath = `${etagPath}.${randomUUID()}.tmp`;
  let tmpWritten = false;
  try {
    let raw = await readEtagSidecarRaw(etagPath);
    let tmpIsCurrent = false;
    let remerges = 0;
    let renameRetries = 0;
    for (;;) {
      if (!tmpIsCurrent) {
        const next = mutate(raw === null ? {} : parseEtagsJson(raw));
        if (next === null) return;
        tmpWritten = true;
        // Flushed, so the rename can't reach the disk before the data does and
        // leave a power cut with a renamed but empty sidecar.
        await retryTransient(() => writeFile(tmpPath, JSON.stringify(next, null, 2), { flush: true }));
        tmpIsCurrent = true;
      }
      // Re-read and merge before every rename attempt (backoff retries too): if
      // another thread replaced the sidecar since our read, re-apply our change
      // to its version rather than overwrite it.
      const current = await readEtagSidecarRaw(etagPath);
      if (current !== raw) {
        if (remerges >= MAX_REMERGES) {
          throw new Error(`${etagPath} kept changing during the update; gave up after ${String(MAX_REMERGES)} re-merges`);
        }
        raw = current;
        tmpIsCurrent = false;
        remerges++;
        continue;
      }
      try {
        await rename(tmpPath, etagPath);
        tmpWritten = false;
        return;
      } catch (err: unknown) {
        const delayMs = TRANSIENT_RETRY_DELAYS_MS[renameRetries];
        if (delayMs === undefined || !hasErrnoCode(err, TRANSIENT_FS_ERRORS)) throw err;
        renameRetries++;
        await sleep(delayMs);
      }
    }
  } finally {
    if (tmpWritten) await rm(tmpPath, { force: true }).catch(() => { /* best effort */ });
  }
}

// Updates to one sidecar run one at a time in this thread, so two can't
// interleave their read-modify-write; different sidecars never wait on each
// other. An entry lives only while updates to its sidecar are queued.
const sidecarChains = new Map<string, Promise<void>>();

/**
 * Read-modify-write one etag sidecar. `mutate` receives the current contents
 * and returns the replacement, or null to leave the file untouched (no write,
 * so a missing sidecar stays missing — `hasSyncedTier` relies on that).
 *
 *  - Strict read: only ENOENT is "no sidecar yet". Transient lock/descriptor
 *    errors are retried briefly; anything else rejects and nothing is written.
 *  - Atomic: the new contents are flushed to a temp file that is renamed over
 *    the sidecar. A writer killed mid-write (the sync worker dies with the app,
 *    a crash, power loss) leaves the previous sidecar intact, never truncated
 *    JSON that `parseEtagsJson` would read as `{}` — the whole tier stale.
 *  - Serialized per sidecar within the calling thread (`sidecarChains`).
 *  - Re-read and merge across threads: before each rename attempt the sidecar
 *    is re-read, and if another thread replaced it meanwhile, `mutate` is
 *    re-applied to that version (giving up after MAX_REMERGES).
 *
 * Remaining window: the two writers — `saveEtags` in the sync worker and
 * `pruneEtagPeriod` on the main thread — don't share a chain, and nothing
 * locks across threads. A replace by the other thread that lands between our
 * last re-read and our rename is still overwritten. That window is a read
 * plus a rename wide (it used to span the whole read-modify-write). A lost
 * save leaves one period stale, so the next sync re-downloads it. A lost prune
 * leaves etags behind for a deleted period: inventory still reports it missing
 * (it checks for the local files first), rollup validation only looks at its
 * own partitions, and the next completed sync of that period overwrites them —
 * only a re-sync of it interrupted mid-period could then read as up to date.
 * A real cross-thread lock (lock files, plus stale-lock recovery for a worker
 * killed while holding one) would cost more than that.
 */
function updateEtagSidecar(
  etagPath: string,
  mutate: (etags: EtagSidecar) => EtagSidecar | null,
): Promise<void> {
  const run = (): Promise<void> => replaceEtagSidecar(etagPath, mutate);
  // Run regardless of whether the previous update settled or rejected; the
  // returned promise carries this update's own outcome to the caller.
  const update = (sidecarChains.get(etagPath) ?? Promise.resolve()).then(run, run);
  sidecarChains.set(etagPath, update);
  const forget = (): void => {
    if (sidecarChains.get(etagPath) === update) sidecarChains.delete(etagPath);
  };
  void update.then(forget, forget);
  return update;
}

/**
 * Record the content hashes of one period's remote files, so the next
 * inventory can tell an up-to-date period from a stale one. Merges into the
 * existing sidecar — other periods' entries are preserved. See
 * `updateEtagSidecar` for the read, write and concurrency guarantees.
 *
 * Shared by both provider sync paths (#517): the sidecar format and the
 * "written only once the period is actually installed" contract are
 * transport-neutral, and a second copy would be a second thing to keep in
 * step with `getPeriodStatus`.
 */
export async function saveEtags(
  dataDir: string,
  providerName: ProviderName,
  tier: string,
  period: string,
  periodFiles: readonly ManifestFileEntry[],
): Promise<void> {
  await mkdir(providerMetaDir(dataDir, providerName), { recursive: true });
  const periodEtags: Record<string, string> = {};
  for (const f of periodFiles) {
    periodEtags[f.key] = f.contentHash;
  }
  await updateEtagSidecar(providerEtagPath(dataDir, providerName, tier), (savedEtags) => {
    savedEtags[period] = periodEtags;
    return savedEtags;
  });
}

/**
 * Forget a deleted period's etags: the `period` key and any key under it
 * (`${period}-…`), the same match `deleteLocalPeriodFiles` applies to raw dirs.
 * Writes nothing when no entry matches or the sidecar doesn't exist. The
 * counterpart of `saveEtags`, with the same guarantees.
 */
export async function pruneEtagPeriod(
  dataDir: string,
  providerName: ProviderName,
  tier: ExpectedDataType,
  period: string,
): Promise<void> {
  // A prefix match on a malformed period ('2026') would drop a whole year.
  if (!/^\d{4}-\d{2}(-\d{2})?$/.test(period)) {
    throw new Error(`Invalid period "${period}" — expected YYYY-MM or YYYY-MM-DD`);
  }
  await updateEtagSidecar(providerEtagPath(dataDir, providerName, tier), (savedEtags) => {
    const kept = Object.fromEntries(
      Object.entries(savedEtags).filter(([key]) => key !== period && !key.startsWith(`${period}-`)),
    );
    return Object.keys(kept).length === Object.keys(savedEtags).length ? null : kept;
  });
}
