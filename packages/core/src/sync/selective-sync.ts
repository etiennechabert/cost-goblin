import { spawn } from 'node:child_process';
import { mkdir, rm, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { logger } from '../logger/logger.js';
import type { ProviderName } from '../types/branded.js';
import { providerRawDir, providerRoot } from './provider-paths.js';
import { parseS3Path } from './s3-client.js';
import type { ProgressCallback } from './s3-client.js';
import type { ManifestFileEntry } from './manifest.js';
import type { ExpectedDataType } from './tiers.js';
import { getRawDirPrefix } from './tiers.js';
import {
  parseAwsCompletedBytes,
  parsePartition,
  partitionFolderLabel,
  saveEtags,
} from './sync-utils.js';
import { findAwsCli } from './trusted-binaries.js';

/** One const for the pre-spawn guard and the ENOENT race below, so the two
 *  user-facing copies cannot drift. The 'AWS CLI not found' head is pinned by
 *  tests; the tail must never contain the word 'credential' — the credential
 *  classifier's catch-all /credential/i would reclassify the message as an
 *  expired session. */
const AWS_CLI_MISSING = process.platform === 'darwin'
  ? 'AWS CLI not found — install it with: brew install awscli'
  : 'AWS CLI not found — install it: https://aws.amazon.com/cli/';

export interface SelectiveSyncOptions {
  readonly bucketPath: string;
  readonly profile: string;
  readonly dataDir: string;
  /** Which provider's tree (`{dataDir}/{providerName}/raw|meta`) receives
   *  the download. Always a validated `ProviderName` from config. */
  readonly providerName: ProviderName;
  readonly expectedDataType?: ExpectedDataType | undefined;
  readonly files: readonly ManifestFileEntry[];
  readonly onProgress?: ProgressCallback | undefined;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Line-buffers one output stream. A chunk boundary can fall anywhere —
 * mid-line and mid-UTF-8 code point — so each chunk is decoded with a
 * StringDecoder (which holds partial code points) and the trailing fragment is
 * carried to the next chunk. `\r` is a line break too: aws-cli 2.x redraws its
 * `Completed …` progress with a bare `\r`, so without it a `download:` line
 * that follows in the same chunk was part of the progress "line" and never
 * counted.
 *
 * `write` and `flush` return the decoded text so the caller can keep the raw
 * stderr for the failure message (the s3-client classifiers read it).
 */
function makeLineSplitter(onLine: ((line: string) => void) | undefined): {
  readonly write: (data: Buffer) => string;
  readonly flush: () => string;
} {
  const decoder = new StringDecoder('utf8');
  let carry = '';
  const emit = (text: string, final: boolean): void => {
    const parts = (carry + text).split(/\r\n|\r|\n/);
    carry = final ? '' : parts.pop() ?? '';
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed.length > 0) onLine?.(trimmed);
    }
  };
  return {
    write: (data) => {
      const text = decoder.write(data);
      emit(text, false);
      return text;
    },
    flush: () => {
      const text = decoder.end();
      emit(text, true);
      return text;
    },
  };
}

function runAwsS3Sync(options: {
  readonly source: string;
  readonly dest: string;
  readonly profile: string;
  readonly signal?: AbortSignal | undefined;
  readonly onLine?: ((line: string) => void) | undefined;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    // Absolute trusted install only — never a bare-name PATH lookup, which
    // would let a writable early PATH entry substitute the binary that holds
    // the AWS session.
    const awsBin = findAwsCli();
    if (awsBin === null) {
      reject(new Error(AWS_CLI_MISSING));
      return;
    }

    // Checked BEFORE spawning: an early return after spawn would leave a
    // process whose 'error' event has no listener yet, and an unlistened
    // ChildProcess 'error' is an uncaught exception in the worker.
    if (options.signal?.aborted) {
      reject(new Error('Download cancelled'));
      return;
    }

    // Parquet only. Filters apply in order and the later one wins, so this
    // excludes everything and then re-includes `*.parquet`: a stray object in
    // the partition folder (a manifest, a CSV, someone else's dump) is never
    // copied onto the laptop. No shell is involved, so `*` needs no quoting.
    const args = [
      's3', 'sync', options.source, options.dest,
      '--exclude', '*', '--include', '*.parquet',
      '--profile', options.profile,
    ];
    const proc = spawn(awsBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const onAbort = (): void => { proc.kill(); };
    // `{ once: true }` fires once; it does NOT detach on normal completion.
    // One AbortSignal covers a whole sync, so without the detach below a long
    // backfill leaves one dead listener per period, each pinning a finished
    // ChildProcess and its piped streams — the leak the gcloud runner had
    // already fixed.
    const detachAbort = (): void => { options.signal?.removeEventListener('abort', onAbort); };
    if (options.signal !== undefined) {
      options.signal.addEventListener('abort', onAbort, { once: true });
      // Aborted between the head check and the attach: a past abort never
      // re-fires the listener, so kill directly ('close' rejects below).
      if (options.signal.aborted) proc.kill();
    }

    let stderr = '';
    const stdoutLines = makeLineSplitter(options.onLine);
    const stderrLines = makeLineSplitter(options.onLine);

    proc.stdout.on('data', (data: Buffer) => { stdoutLines.write(data); });
    proc.stderr.on('data', (data: Buffer) => { stderr += stderrLines.write(data); });

    proc.on('error', (err: Error) => {
      detachAbort();
      if (err.message.includes('ENOENT')) {
        reject(new Error(AWS_CLI_MISSING));
      } else {
        reject(err);
      }
    });

    proc.on('close', (code, signal) => {
      detachAbort();
      // The last line often has no terminator; flush it (and any held partial
      // code point) before settling so it is neither lost nor counted late.
      stdoutLines.flush();
      stderr += stderrLines.flush();
      if (signal === 'SIGTERM' || options.signal?.aborted) {
        reject(new Error('Download cancelled'));
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error(`aws s3 sync failed (exit ${String(code)}): ${stderr.trim()}`));
      }
    });
  });
}

/**
 * Deletes any local `.parquet` not in the current manifest. `aws s3 sync` runs
 * without `--delete`, so a previous CUR export's part files linger when AWS
 * re-chunks a period — and get double-counted at query time. `manifestFiles`
 * must be the complete file set of the prefix synced into `destDir`.
 * Best-effort: a failed deletion never fails a successful sync.
 */
async function pruneStaleFiles(destDir: string, manifestFiles: readonly ManifestFileEntry[]): Promise<number> {
  // An empty manifest must never be read as "delete everything in the dir".
  if (manifestFiles.length === 0) return 0;
  const expected = new Set(manifestFiles.map(f => basename(f.key)));
  let entries: string[];
  try {
    entries = await readdir(destDir);
  } catch {
    return 0; // dir vanished or was never created — nothing to prune
  }
  let removed = 0;
  for (const name of entries) {
    if (!name.endsWith('.parquet') || expected.has(name)) continue;
    try {
      await rm(join(destDir, name), { force: true });
      removed++;
    } catch (err) {
      // A locked / permission-denied stale file must not fail a sync whose
      // download already succeeded (mirrors the legacy-dir cleanup below).
      logger.warn(`Failed to prune stale file ${name} from ${destDir}`, { err });
    }
  }
  if (removed > 0) {
    logger.info(`Pruned ${String(removed)} stale file(s) not in current manifest from ${destDir}`);
  }
  return removed;
}

interface ByteState {
  bytesDone: number | undefined;
  bytesTotal: number | undefined;
}

function makeLineHandler(
  onProgress: ProgressCallback | undefined,
  totalFiles: number,
  counter: { filesDone: number },
  bytes: ByteState,
): (line: string) => void {
  return (line) => {
    logger.info(`[aws] ${line}`);
    if (line.startsWith('download:')) {
      counter.filesDone++;
    }
    if (line.startsWith('Completed')) {
      const parsed = parseAwsCompletedBytes(line);
      if (parsed !== null) {
        bytes.bytesDone = parsed.bytesDone;
        bytes.bytesTotal = parsed.bytesTotal;
      }
    }
    if (onProgress !== undefined) {
      onProgress({
        phase: 'downloading',
        filesTotal: totalFiles,
        filesDone: counter.filesDone,
        bytesTotal: bytes.bytesTotal,
        bytesDone: bytes.bytesDone,
        message: line.startsWith('Completed') ? line : undefined,
      });
    }
  };
}

/** One `aws s3 sync` run: a single partition folder into a single local dir. */
interface SyncGroup {
  readonly period: string;
  /** Directory under `raw/`: `daily-2026-03`, `cost-opt-2026-03-15`. The
   *  Savings query reads `{providerName}/raw/cost-opt-*` directly. */
  readonly dirName: string;
  readonly prefix: string;
  /** Exactly the listed files under `prefix` — what etags, pruning and the
   *  file counts cover. */
  readonly files: readonly ManifestFileEntry[];
}

interface GroupCandidates {
  readonly period: string;
  readonly entries: { readonly file: ManifestFileEntry; readonly prefix: string }[];
}

/** Code-unit order, independent of the host locale. */
function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Two prefixes synced into one local dir would double-count at query time,
 *  so a group only ever syncs one: the lexicographically smallest. The rest
 *  stay out of the etags and so keep reading 'stale'. */
function pickOnePrefix(dirName: string, candidates: GroupCandidates): SyncGroup | null {
  const prefixes = [...new Set(candidates.entries.map(e => e.prefix))].sort(compareCodeUnits);
  const prefix = prefixes[0];
  if (prefix === undefined) return null;
  const files = candidates.entries.filter(e => e.prefix === prefix).map(e => e.file);
  if (prefixes.length > 1) {
    logger.warn(
      `${dirName}: ${String(candidates.entries.length - files.length)} file(s) sit in another partition folder `
      + `(${prefixes.slice(1).join(', ')}) and were not synced — only ${prefix} is`,
    );
  }
  return { period: candidates.period, dirName, prefix, files };
}

/**
 * Splits the requested files into one sync group per local dir. A file is
 * usable only when its key sits directly in the tier's partition folder
 * (`parsePartition`) AND that folder is under the configured bucket prefix.
 *
 * The second check is a sink check: the keys can arrive from the renderer over
 * `data:sync-periods` unvalidated, and the folder becomes the `aws s3 sync`
 * source. It is a plain string-prefix test — the same semantics as the
 * ListObjectsV2 `Prefix` the inventory listed with — so it accepts exactly the
 * keys a listing of the bucket path could have returned.
 */
function planSyncGroups(files: readonly ManifestFileEntry[], tier: ExpectedDataType, bucketPath: string): SyncGroup[] {
  const configuredPrefix = parseS3Path(bucketPath).prefix;
  const dirPrefix = getRawDirPrefix(tier);
  const candidates = new Map<string, GroupCandidates>();
  let unusable = 0;

  for (const file of files) {
    const partition = parsePartition(file.key, tier);
    if (partition === null || !partition.prefix.startsWith(configuredPrefix)) {
      unusable++;
      continue;
    }
    const dirName = `${dirPrefix}-${partition.kind === 'date' ? partition.date : partition.period}`;
    const entry = { file, prefix: partition.prefix };
    const existing = candidates.get(dirName);
    if (existing === undefined) {
      candidates.set(dirName, { period: partition.period, entries: [entry] });
    } else {
      existing.entries.push(entry);
    }
  }

  if (unusable > 0) {
    logger.warn(
      `Skipping ${String(unusable)} file(s) that do not sit directly in a ${partitionFolderLabel(tier)} folder under ${bucketPath}`,
    );
  }

  const groups: SyncGroup[] = [];
  for (const [dirName, group] of candidates) {
    const picked = pickOnePrefix(dirName, group);
    if (picked !== null) groups.push(picked);
  }
  return groups.sort((a, b) => compareCodeUnits(a.dirName, b.dirName));
}

/** Groups arrive sorted by dir name, which orders by period first. */
function byPeriod(groups: readonly SyncGroup[]): Map<string, SyncGroup[]> {
  const periods = new Map<string, SyncGroup[]>();
  for (const group of groups) {
    const existing = periods.get(group.period);
    if (existing === undefined) {
      periods.set(group.period, [group]);
    } else {
      existing.push(group);
    }
  }
  return periods;
}

function noUsableFilesMessage(tier: ExpectedDataType, fileCount: number): string {
  const head = `None of the ${String(fileCount)} file(s) sit directly in a ${partitionFolderLabel(tier)} folder under the provider's bucket path`;
  return tier === 'cost-optimization'
    ? `${head} — point the cost-optimization bucket at the Cost Optimization Hub export prefix.`
    : `${head} — it is probably wrong. Point it at the FOCUS export prefix that contains data/ and metadata/.`;
}

interface PeriodRun {
  readonly options: SelectiveSyncOptions;
  readonly s3Bucket: string;
  readonly onLine: (line: string) => void;
}

/** Syncs each group of one period in turn; returns the files actually synced.
 *  An abort between groups stops early, leaving the rest unsynced. */
async function syncPeriodGroups(run: PeriodRun, groups: readonly SyncGroup[]): Promise<ManifestFileEntry[]> {
  const { dataDir, providerName, profile, signal } = run.options;
  const synced: ManifestFileEntry[] = [];
  for (const group of groups) {
    if (signal?.aborted) break;
    const source = `s3://${run.s3Bucket}/${group.prefix}`;
    const dest = join(providerRawDir(dataDir, providerName), group.dirName);
    await mkdir(dest, { recursive: true });
    logger.info(`Running: aws s3 sync ${source} ${dest}`);
    await runAwsS3Sync({ source, dest, profile, signal, onLine: run.onLine });
    await pruneStaleFiles(dest, group.files);
    synced.push(...group.files);
  }
  return synced;
}

export async function syncSelectedFiles(options: SelectiveSyncOptions): Promise<{ filesDownloaded: number; rowsProcessed: number }> {
  const tier = options.expectedDataType ?? 'daily';
  const { bucketPath, dataDir, providerName, files, onProgress } = options;

  const groups = planSyncGroups(files, tier, bucketPath);
  // Every requested file was unusable: fail loudly instead of stamping the
  // tier 'completed' with a fresh lastSync while nothing was installed (the
  // silent "up to date forever" trap the GCP arm also guards against).
  if (groups.length === 0 && files.length > 0 && options.signal?.aborted !== true) {
    throw new Error(noUsableFilesMessage(tier, files.length));
  }

  if (tier === 'cost-optimization') {
    // Cost-optimization data is read straight from {provider}/raw/cost-opt-*/
    // (see query-recommendations). An earlier version also copied each day into
    // a Hive-partitioned cost-optimization/usage_date=*/ tree that nothing ever
    // read and prune never cleaned — so it leaked unbounded. Stop writing it and
    // drop any legacy copy left behind (best-effort: cosmetic, never fail a sync).
    await rm(join(providerRoot(dataDir, providerName), 'cost-optimization'), { recursive: true, force: true })
      .catch(() => { /* legacy dir may not exist */ });
  }

  const totalFiles = groups.reduce((sum, g) => sum + g.files.length, 0);
  const bytes: ByteState = { bytesDone: undefined, bytesTotal: undefined };
  const run: PeriodRun = {
    options,
    s3Bucket: parseS3Path(bucketPath).bucket,
    onLine: makeLineHandler(onProgress, totalFiles, { filesDone: 0 }, bytes),
  };
  const periods = byPeriod(groups);
  let filesDownloaded = 0;

  for (const [period, periodGroups] of periods) {
    if (options.signal?.aborted) break;
    logger.info(`Processing ${tier} period ${period}: ${String(periodGroups.length)} partition folder(s)`);

    const synced = await syncPeriodGroups(run, periodGroups);

    if (tier === 'cost-optimization' && onProgress !== undefined) {
      onProgress({ phase: 'repartitioning', filesTotal: 1, filesDone: 1 });
    }
    // Etags are the "this file is current" record, so they cover only what
    // was actually synced — never a group skipped by an abort, and never a
    // period with nothing synced.
    if (synced.length > 0) {
      await saveEtags(dataDir, providerName, tier, period, synced);
    }
    filesDownloaded += synced.length;
  }

  if (onProgress !== undefined) {
    onProgress({ phase: 'done', filesTotal: totalFiles, filesDone: totalFiles });
  }

  logger.info(`Sync complete: ${String(filesDownloaded)} ${tier} file(s) across ${String(periods.size)} period(s)`);
  return { filesDownloaded, rowsProcessed: 0 };
}
