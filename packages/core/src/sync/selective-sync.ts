import { spawn } from 'node:child_process';
import { mkdir, rm, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { logger } from '../logger/logger.js';
import type { ProviderName } from '../types/branded.js';
import { providerRawDir, providerRoot } from './provider-paths.js';
import { parseS3Path } from './s3-client.js';
import type { ProgressCallback } from './s3-client.js';
import type { ManifestFileEntry } from './manifest.js';
import type { ExpectedDataType } from './sync-utils.js';
import {
  extractDate,
  extractPeriodPrefix,
  groupByPeriod,
  parseAwsCompletedBytes,
  saveEtags,
} from './sync-utils.js';
import { findAwsCli } from './trusted-binaries.js';

export type { ExpectedDataType } from './sync-utils.js';

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
  /**
   * Called as each file finishes downloading, with the local path. Used by
   * the desktop handler to enqueue post-download optimization (sort + sidecar
   * generation) in parallel with ongoing downloads of other files.
   */
  readonly onFileDownloaded?: ((localPath: string) => void) | undefined;
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

    const args = ['s3', 'sync', options.source, options.dest, '--profile', options.profile];
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

    proc.stdout.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length > 0) {
          options.onLine?.(trimmed);
        }
      }
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
      const lines = data.toString().split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length > 0) {
          options.onLine?.(trimmed);
        }
      }
    });

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
 * must be the period's complete file set (callers flatMap whole-period
 * manifests). Best-effort: a failed deletion never fails a successful sync.
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

function groupFilesByDate(periodFiles: readonly ManifestFileEntry[]): Map<string, ManifestFileEntry[]> {
  const dateGroups = new Map<string, ManifestFileEntry[]>();
  for (const file of periodFiles) {
    const date = extractDate(file.key);
    if (date === undefined) continue;
    const existing = dateGroups.get(date);
    if (existing === undefined) {
      dateGroups.set(date, [file]);
    } else {
      existing.push(file);
    }
  }
  return dateGroups;
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

interface SyncDateGroupOptions {
  readonly date: string;
  readonly dateFiles: readonly ManifestFileEntry[];
  readonly s3Bucket: string;
  readonly dataDir: string;
  readonly providerName: ProviderName;
  readonly profile: string;
  readonly signal: AbortSignal | undefined;
  readonly onLine: (line: string) => void;
}

async function syncDateGroup(opts: SyncDateGroupOptions): Promise<number> {
  const { date, dateFiles, s3Bucket, dataDir, providerName, profile, signal, onLine } = opts;
  const firstFile = dateFiles[0];
  if (firstFile === undefined) return 0;

  const datePrefix = extractPeriodPrefix(firstFile.key);
  const s3Source = `s3://${s3Bucket}/${datePrefix}`;
  // This raw dir is the copy the Savings query actually reads
  // (query-recommendations reads {providerName}/raw/cost-opt-*/*.parquet).
  const destDir = join(providerRawDir(dataDir, providerName), `cost-opt-${date}`);
  await mkdir(destDir, { recursive: true });

  await runAwsS3Sync({ source: s3Source, dest: destDir, profile, signal, onLine });
  await pruneStaleFiles(destDir, dateFiles);

  return dateFiles.length;
}

async function syncCostOptimization(options: SelectiveSyncOptions): Promise<{ filesDownloaded: number; rowsProcessed: number }> {
  const { bucketPath, profile, dataDir, providerName, files, onProgress } = options;
  const s3Path = parseS3Path(bucketPath);

  // Cost-optimization data is read straight from {provider}/raw/cost-opt-*/
  // (see query-recommendations). An earlier version also copied each day into
  // a Hive-partitioned cost-optimization/usage_date=*/ tree that nothing ever
  // read and prune never cleaned — so it leaked unbounded. Stop writing it and
  // drop any legacy copy left behind (best-effort: cosmetic, never fail a sync).
  await rm(join(providerRoot(dataDir, providerName), 'cost-optimization'), { recursive: true, force: true })
    .catch(() => { /* legacy dir may not exist */ });

  const periods = groupByPeriod(files);
  const periodList = [...periods.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const totalFiles = files.length;
  const counter = { filesDone: 0 };
  const bytes: ByteState = { bytesDone: undefined, bytesTotal: undefined };
  let totalFilesDownloaded = 0;

  for (const [period, periodFiles] of periodList) {
    if (options.signal?.aborted) break;

    const dateGroups = groupFilesByDate(periodFiles);
    logger.info(`Processing cost optimization period ${period}: ${String(dateGroups.size)} dates`);

    for (const [date, dateFiles] of dateGroups) {
      if (options.signal?.aborted) break;
      totalFilesDownloaded += await syncDateGroup({
        date, dateFiles, s3Bucket: s3Path.bucket, dataDir, providerName, profile,
        signal: options.signal, onLine: makeLineHandler(onProgress, totalFiles, counter, bytes),
      });
    }

    if (onProgress !== undefined) {
      onProgress({ phase: 'repartitioning', filesTotal: 1, filesDone: 1 });
    }

    await saveEtags(dataDir, providerName, 'cost-optimization', period, periodFiles);
  }

  if (onProgress !== undefined) {
    onProgress({ phase: 'done', filesTotal: totalFiles, filesDone: totalFiles });
  }

  logger.info(`Cost optimization sync complete: ${String(totalFilesDownloaded)} files`);
  return { filesDownloaded: totalFilesDownloaded, rowsProcessed: 0 };
}

export async function syncSelectedFiles(options: SelectiveSyncOptions): Promise<{ filesDownloaded: number; rowsProcessed: number }> {
  const tier = options.expectedDataType ?? 'daily';

  if (tier === 'cost-optimization') {
    return syncCostOptimization(options);
  }

  const { bucketPath, profile, dataDir, providerName, files, onProgress } = options;
  const s3Path = parseS3Path(bucketPath);

  const periods = groupByPeriod(files);
  const periodList = [...periods.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  let totalFilesDownloaded = 0;
  const totalFiles = files.length;
  let globalFilesDone = 0;
  const bytes: ByteState = { bytesDone: undefined, bytesTotal: undefined };
  /** Count of periods whose keys had no recognizable period prefix — see the
   *  guard below. Tracked so an all-skipped run fails loudly instead of
   *  reporting a successful sync of nothing (mirrors the GCP arm's handling). */
  let skippedCount = 0;

  for (const [period, periodFiles] of periodList) {
    if (options.signal?.aborted) break;

    logger.info(`Processing period ${period}: ${String(periodFiles.length)} files`);

    const firstFile = periodFiles[0];
    if (firstFile === undefined) continue;

    const periodPrefix = extractPeriodPrefix(firstFile.key);
    if (periodPrefix.length === 0) {
      // No `billing_period=`/`date=` folder in the key → the source would
      // collapse to `s3://bucket/` and `aws s3 sync` would mirror the WHOLE
      // bucket into this one period's staging dir. Skip it (mirrors GCP's
      // isSafePeriodPrefix guard) rather than pull the entire bucket.
      logger.warn(`Skipping period ${period}: ${firstFile.key} is not under a billing_period=/date= folder`);
      skippedCount += 1;
      continue;
    }
    const s3Source = `s3://${s3Path.bucket}/${periodPrefix}`;
    const stagingDir = join(providerRawDir(dataDir, providerName), `${tier}-${period}`);
    await mkdir(stagingDir, { recursive: true });

    // Phase 1: Download using aws s3 sync
    logger.info(`Running: aws s3 sync ${s3Source} ${stagingDir}`);

    await runAwsS3Sync({
      source: s3Source,
      dest: stagingDir,
      profile,
      signal: options.signal,
      onLine: (line) => {
        logger.info(`[aws] ${line}`);
        if (line.startsWith('download:')) {
          globalFilesDone++;
          // Extract the local path from `download: s3://bucket/key to /local/path`.
          // Kicks off optimize in parallel with the next download.
          if (options.onFileDownloaded !== undefined) {
            const match = / to (.+)$/.exec(line);
            if (match?.[1] !== undefined) {
              options.onFileDownloaded(match[1]);
            }
          }
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
            filesDone: globalFilesDone,
            bytesTotal: bytes.bytesTotal,
            bytesDone: bytes.bytesDone,
            message: line.startsWith('Completed') ? line : undefined,
          });
        }
      },
    });

    totalFilesDownloaded += periodFiles.length;

    await pruneStaleFiles(stagingDir, periodFiles);
    await saveEtags(dataDir, providerName, tier, period, periodFiles);
  }

  // Every period had an unrecognizable layout: fail loudly instead of stamping
  // the tier 'completed' with a fresh lastSync while nothing was installed (the
  // silent "up to date forever" trap the GCP arm also guards against).
  if (skippedCount > 0 && skippedCount === periodList.length) {
    throw new Error(
      `None of the ${String(periodList.length)} period(s) sit under a billing_period=/date= folder — `
      + `the provider's bucket path is probably wrong. Point it at the FOCUS export prefix that contains data/ and metadata/.`,
    );
  }

  if (onProgress !== undefined) {
    onProgress({ phase: 'done', filesTotal: totalFiles, filesDone: totalFiles });
  }

  logger.info(`Sync complete: ${String(totalFilesDownloaded)} files across ${String(periodList.length - skippedCount)} periods`);
  return { filesDownloaded: totalFilesDownloaded, rowsProcessed: 0 };
}
