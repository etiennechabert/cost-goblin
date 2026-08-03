import { spawn } from 'node:child_process';
import { mkdir, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../logger/logger.js';
import type { ProviderName } from '../types/branded.js';
import { canonicalizeGcpPeriod } from './gcp-canonicalize.js';
import { parseGcsPath } from './gcs-client.js';
import type { ManifestFileEntry } from './manifest.js';
import { providerMetaDir, providerRawDir } from './provider-paths.js';
import type { ProgressCallback } from './s3-client.js';
import { extractPeriodPrefix, getRawDirPrefix, groupByPeriod, saveEtags } from './sync-utils.js';

/** The GCP sync mirrors the AWS one seam for seam: the vendor SDK lists the
 *  bucket (change detection), and the vendor CLI moves the bytes. `gcloud
 *  storage rsync` is the sister of `aws s3 sync` — parallel transfers,
 *  resume, and integrity checks we would otherwise reimplement — so the app
 *  expects the gcloud CLI to be installed exactly as it already expects the
 *  AWS CLI. It is the same binary the "sign in again" affordance shells out
 *  to, so a working GCP setup already has it.
 *
 *  What is NOT shared with the AWS path: the downloaded shards are not the
 *  files the query layer reads. BigQuery cannot emit MAP-typed tags, so each
 *  period is canonicalized (`gcp-canonicalize.ts`) into a temp dir and then
 *  swapped into `raw/daily-YYYY-MM/` in one move. */

let cachedGcloudPath: string | null = null;

function findGcloudCli(): string {
  if (cachedGcloudPath !== null) return cachedGcloudPath;

  const candidates = process.platform === 'win32'
    ? [
        join(process.env['PROGRAMFILES'] ?? String.raw`C:\Program Files`, 'Google', 'Cloud SDK', 'google-cloud-sdk', 'bin', 'gcloud.cmd'),
        join(process.env['LOCALAPPDATA'] ?? '', 'Google', 'Cloud SDK', 'google-cloud-sdk', 'bin', 'gcloud.cmd'),
      ]
    : [
        '/opt/homebrew/bin/gcloud',
        '/usr/local/bin/gcloud',
        '/usr/bin/gcloud',
        '/opt/local/bin/gcloud',
        join(homedir(), 'google-cloud-sdk', 'bin', 'gcloud'),
      ];

  for (const p of candidates) {
    if (p.length > 0 && existsSync(p)) { cachedGcloudPath = p; return p; }
  }
  cachedGcloudPath = 'gcloud';
  return cachedGcloudPath;
}

/** `gcloud storage` reports transfer progress as
 *  `Completed files 3/10 | 12.0MiB/40.0MiB`. Sister of
 *  `parseAwsCompletedBytes`; the unit spellings differ in case between the
 *  two CLIs, so the match is case-insensitive. Returns null on any line
 *  without both byte counts so callers keep the previous numbers.
 *
 *  [LIVE-GATE] The exact wording is verified against a real `gcloud storage
 *  rsync` run at the live gate. A miss only costs a smoother progress bar —
 *  the file-count fraction is the documented fallback. */
export function parseGcloudCompletedBytes(line: string): { bytesDone: number; bytesTotal: number } | null {
  const match = /([\d.]+)\s*(B|KiB|MiB|GiB|TiB)\s*\/\s*([\d.]+)\s*(B|KiB|MiB|GiB|TiB)/i.exec(line);
  if (match === null) return null;
  const [, doneNum, doneUnit, totalNum, totalUnit] = match;
  if (doneNum === undefined || doneUnit === undefined || totalNum === undefined || totalUnit === undefined) return null;
  const doneFactor = unitBytes(doneUnit);
  const totalFactor = unitBytes(totalUnit);
  if (doneFactor === null || totalFactor === null) return null;
  const bytesDone = Number.parseFloat(doneNum) * doneFactor;
  const bytesTotal = Number.parseFloat(totalNum) * totalFactor;
  if (!Number.isFinite(bytesDone) || !Number.isFinite(bytesTotal) || bytesTotal <= 0) return null;
  return { bytesDone, bytesTotal };
}

function unitBytes(unit: string): number | null {
  switch (unit.toUpperCase()) {
    case 'B': return 1;
    case 'KIB': return 1024;
    case 'MIB': return 1024 * 1024;
    case 'GIB': return 1024 * 1024 * 1024;
    case 'TIB': return 1024 * 1024 * 1024 * 1024;
    default: return null;
  }
}

interface GcloudRsyncOptions {
  readonly source: string;
  readonly dest: string;
  readonly keyFile?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly onLine?: ((line: string) => void) | undefined;
}

function runGcloudStorageRsync(options: GcloudRsyncOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      'storage', 'rsync', options.source, options.dest,
      '--recursive',
      // The staging directory is ours alone, so mirroring deletions is safe —
      // and it is the fix for the export's stale-shard problem: a re-export
      // that produces fewer shards than the previous run would otherwise
      // leave orphans behind to be double-counted.
      '--delete-unmatched-destination-objects',
    ];

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (options.keyFile !== undefined) {
      // Points this invocation at a service-account key without touching the
      // user's global gcloud credential store (which `gcloud auth
      // activate-service-account` would rewrite). With no key file the CLI
      // uses Application Default Credentials, the documented default.
      env['CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE'] = options.keyFile;
    }

    const proc = spawn(findGcloudCli(), args, { stdio: ['ignore', 'pipe', 'pipe'], env });

    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        proc.kill();
        reject(new Error('Download cancelled'));
        return;
      }
      options.signal.addEventListener('abort', () => { proc.kill(); }, { once: true });
    }

    let stderr = '';

    const forward = (data: Buffer): void => {
      for (const line of data.toString().split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length > 0) options.onLine?.(trimmed);
      }
    };

    proc.stdout.on('data', forward);
    // `gcloud storage` writes its progress to stderr, so stderr is both the
    // progress feed and the failure text.
    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
      forward(data);
    });

    proc.on('error', (err: Error) => {
      if (err.message.includes('ENOENT')) {
        reject(new Error('Google Cloud CLI not found — install it with: brew install --cask google-cloud-sdk'));
      } else {
        reject(err);
      }
    });

    proc.on('close', (code, signal) => {
      if (signal === 'SIGTERM' || options.signal?.aborted) {
        reject(new Error('Download cancelled'));
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error(`gcloud storage rsync failed (exit ${String(code)}): ${stderr.trim()}`));
      }
    });
  });
}

export interface GcpSelectiveSyncOptions {
  readonly bucketPath: string;
  /** Absent means Application Default Credentials. */
  readonly keyFile?: string | undefined;
  readonly providerName: ProviderName;
  readonly dataDir: string;
  readonly files: readonly ManifestFileEntry[];
  readonly onProgress?: ProgressCallback | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** Staging lives under `meta/`, never under `raw/`. The query layer globs
 *  `raw/{tier}-*​/*.parquet`, so a staging dir named `daily-…` under `raw/`
 *  would be read live — mixing list-of-struct tags into a MAP-tag union and
 *  failing every tag expression mid-sync. */
function stagingDirFor(dataDir: string, provider: ProviderName, period: string): string {
  return join(providerMetaDir(dataDir, provider), 'staging-gcp', period);
}

/**
 * Download, canonicalize and install each requested period.
 *
 * Per period the sequence is: rsync into staging → canonicalize into a
 * sibling temp dir → swap that dir into `raw/daily-{period}/` → record
 * etags. Etags are written last on purpose: they are the "this period is
 * up to date" record, so writing them before the swap succeeds would mark a
 * period done that was never installed, and it would never be retried.
 */
export async function syncGcpSelectedFiles(
  options: GcpSelectiveSyncOptions,
): Promise<{ filesDownloaded: number; rowsProcessed: number }> {
  const { bucketPath, providerName, dataDir, files, onProgress } = options;
  const tier = 'daily';
  const gcsPath = parseGcsPath(bucketPath);

  const periods = groupByPeriod(files);
  const periodList = [...periods.entries()]
    .filter(([period]) => period !== 'unknown')
    .sort((a, b) => a[0].localeCompare(b[0]));

  const totalFiles = files.length;
  // Unlike `aws s3 sync`, the byte total is known up front: it comes from the
  // listing, so the progress bar is exact from the first tick instead of
  // waiting for the CLI's first "Completed" line.
  const bytesTotal = files.reduce((sum, f) => sum + f.size, 0);
  let filesDone = 0;
  /** Bytes transferred by periods that already finished. The CLI's own counts
   *  restart at zero for each invocation, so they are an offset from here. */
  let bytesBefore = 0;
  let totalFilesDownloaded = 0;
  let totalRows = 0;

  for (const [period, periodFiles] of periodList) {
    if (options.signal?.aborted) break;

    const firstFile = periodFiles[0];
    if (firstFile === undefined) continue;

    const periodPrefix = extractPeriodPrefix(firstFile.key);
    const source = `gs://${gcsPath.bucket}/${periodPrefix}`;
    const stagingDir = stagingDirFor(dataDir, providerName, period);
    const periodBytes = periodFiles.reduce((sum, f) => sum + f.size, 0);

    logger.info(`Processing GCP period ${period}: ${String(periodFiles.length)} shard(s)`);

    // A staging dir left behind by an interrupted run would otherwise be
    // reconciled by rsync against the current listing, which is *usually*
    // right but hides a half-written shard from a killed transfer.
    await rm(stagingDir, { recursive: true, force: true });
    await mkdir(stagingDir, { recursive: true });

    try {
      await runGcloudStorageRsync({
        source,
        dest: stagingDir,
        ...(options.keyFile === undefined ? {} : { keyFile: options.keyFile }),
        signal: options.signal,
        onLine: (line) => {
          logger.info(`[gcloud] ${line}`);
          const parsed = parseGcloudCompletedBytes(line);
          onProgress?.({
            phase: 'downloading',
            filesTotal: totalFiles,
            filesDone,
            bytesTotal,
            // Clamped: the CLI's total for this period can exceed the listed
            // size (it counts retried bytes), and a fraction above 1 would
            // run the progress bar off its track.
            bytesDone: Math.min(bytesBefore + (parsed?.bytesDone ?? 0), bytesTotal),
            ...(parsed === null ? {} : { message: line }),
          });
        },
      });

      filesDone += periodFiles.length;
      bytesBefore = Math.min(bytesBefore + periodBytes, bytesTotal);
      totalFilesDownloaded += periodFiles.length;

      // Reuses the existing worker/UI phase token rather than adding one:
      // "repartitioning" is already rendered as the post-download processing
      // step, which is exactly what canonicalization is.
      onProgress?.({ phase: 'repartitioning', filesTotal: periodList.length, filesDone: totalFilesDownloaded });

      totalRows += await installCanonicalPeriod({
        stagingDir,
        dataDir,
        providerName,
        period,
        tier,
      });

      await saveEtags(dataDir, providerName, tier, period, periodFiles);
    } finally {
      // Staging is pure scratch; leaving it behind would double the on-disk
      // footprint of every synced month.
      await rm(stagingDir, { recursive: true, force: true }).catch(() => { /* best effort */ });
    }
  }

  onProgress?.({ phase: 'done', filesTotal: totalFiles, filesDone: totalFiles, bytesTotal, bytesDone: bytesTotal });

  logger.info(`GCP sync complete: ${String(totalFilesDownloaded)} shard(s) across ${String(periodList.length)} period(s), ${String(totalRows)} rows`);
  return { filesDownloaded: totalFilesDownloaded, rowsProcessed: totalRows };
}

interface InstallOptions {
  readonly stagingDir: string;
  readonly dataDir: string;
  readonly providerName: ProviderName;
  readonly period: string;
  readonly tier: string;
}

/** Canonicalize into a temp dir, then replace the period directory with it.
 *
 *  The replacement can't be a single atomic `rename` — POSIX `rename()` fails
 *  with ENOTEMPTY over a non-empty directory — so it is remove-then-rename,
 *  with a sub-millisecond window where the period is absent. That is still
 *  the right shape: the alternative (writing into the live directory) leaves
 *  a period half-old half-new for the whole canonicalization, and a query
 *  landing there reads a file set that mixes two export generations.
 *
 *  The temp dir is a sibling under the same provider tree so the rename never
 *  crosses a filesystem boundary. */
async function installCanonicalPeriod(options: InstallOptions): Promise<number> {
  const rawDir = providerRawDir(options.dataDir, options.providerName);
  const periodDirName = `${getRawDirPrefix(options.tier)}-${options.period}`;
  const destDir = join(rawDir, periodDirName);
  const tmpDir = join(rawDir, `.tmp-${periodDirName}`);

  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });

  try {
    const result = await canonicalizeGcpPeriod({
      stagingDir: options.stagingDir,
      outputPath: join(tmpDir, 'part-0.parquet'),
    });

    await rm(destDir, { recursive: true, force: true });
    await rename(tmpDir, destDir);
    logger.info(`Canonicalized GCP period ${options.period}: ${String(result.rows)} rows`);
    if (result.synthesizedColumns.length > 0) {
      logger.info(`Synthesized column(s) absent from the GCP export: ${result.synthesizedColumns.join(', ')}`);
    }
    return result.rows;
  } finally {
    // On success the rename consumed tmpDir and this is a no-op; on failure
    // it removes a partial rewrite that must never be mistaken for data.
    await rm(tmpDir, { recursive: true, force: true }).catch(() => { /* best effort */ });
  }
}
