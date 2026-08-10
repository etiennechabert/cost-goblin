import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../logger/logger.js';
import type { ProviderName } from '../types/branded.js';
import { canonicalizeGcpPeriod } from './gcp-canonicalize.js';
import { parseGcsPath } from './gcs-client.js';
import type { ManifestFileEntry } from './manifest.js';
import { providerMetaDir, providerRawDir } from './provider-paths.js';
import type { ProgressCallback } from './s3-client.js';
import { extractPeriodPrefix, getRawDirPrefix, groupByPeriod, saveEtags } from './sync-utils.js';
import { findGcloudCli } from './trusted-binaries.js';

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

/** `gcloud storage rsync` announces each transfer as it STARTS:
 *
 *    Copying gs://bucket/some/key.parquet to file:///local/path
 *
 *  Verified against gcloud 578: that is the only per-file line it emits.
 *  There is no running byte count — the CLI draws a progress bar (`....`)
 *  instead — which is why byte progress here is derived from the manifest
 *  rather than scraped, unlike the AWS path. */
export function parseGcloudCopyingKey(line: string): string | null {
  const match = /^Copying gs:\/\/[^/]+\/(\S+) to /.exec(line);
  return match?.[1] ?? null;
}

/** Whether a stderr line is part of the progress feed rather than failure
 *  text. `gcloud storage` writes both to stderr, so the failure message has to
 *  filter — keeping the whole feed would not only bloat the message by
 *  megabytes but feed byte counts to the substring classifiers downstream: a
 *  `503.1MiB/1.2GiB` line makes `isGcloudDownloadFailure` match `503`, and a
 *  genuine 403 gets reported as an expired session. */
function isProgressNoise(line: string): boolean {
  if (line.length === 0) return true;
  if (/^[.\s]+$/.test(line)) return true;
  if (parseGcloudCopyingKey(line) !== null) return true;
  if (parseGcloudCompletedBytes(line) !== null) return true;
  return line.startsWith('Average throughput:');
}

/** Some gcloud builds do print an aggregate byte line. Kept as a refinement:
 *  when present it gives smooth intra-file progress, when absent (the
 *  observed default) the manifest-derived count carries it. Returns null on
 *  any line without both counts so callers keep the previous numbers. */
export function parseGcloudCompletedBytes(line: string): { bytesDone: number; bytesTotal: number } | null {
  const match = /(?<![\d.])([\d.]+)\s*(B|KiB|MiB|GiB|TiB)\s*\/\s*([\d.]+)\s*(B|KiB|MiB|GiB|TiB)/i.exec(line);
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
  readonly impersonateServiceAccount?: string | undefined;
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

    if (options.impersonateServiceAccount !== undefined) {
      // The download runs as gcloud's signed-in user by default — ADC
      // impersonation covers the listing SDK but not the CLI. Without this the
      // two halves of a sync would authenticate as different identities, and
      // the least-privilege service account would be bypassed for the half
      // that actually moves the data.
      args.push(`--impersonate-service-account=${options.impersonateServiceAccount}`);
    }

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (options.keyFile !== undefined) {
      // Points this invocation at a service-account key without touching the
      // user's global gcloud credential store (which `gcloud auth
      // activate-service-account` would rewrite). With no key file the CLI
      // uses Application Default Credentials, the documented default.
      env['CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE'] = options.keyFile;
    }

    // Absolute trusted install only — never a bare-name PATH lookup, which
    // would let a writable early PATH entry substitute the binary that holds
    // the GCP session. Same message as the ENOENT branch below so the failure
    // reads identically wherever it surfaces.
    const gcloudPath = findGcloudCli();
    if (gcloudPath === null) {
      reject(new Error('Google Cloud CLI not found — install it with: brew install --cask google-cloud-sdk'));
      return;
    }

    // The Windows Cloud SDK ships `gcloud.cmd`, and since Node 18.20.2 /
    // 20.12.2 (CVE-2024-27980) spawning a `.cmd` without a shell fails with
    // EINVAL — which is not in the emit-as-'error' list, so it would throw out
    // of this executor and every GCP sync would die before a byte moved.
    // Arguments are quoted because the staging destination is a user path that
    // routinely contains spaces; `isSafePeriodPrefix` has already rejected the
    // shell metacharacters that quoting alone would not contain.
    const useShell = process.platform === 'win32';
    const proc = spawn(
      useShell ? `"${gcloudPath}"` : gcloudPath,
      useShell ? args.map(arg => `"${arg}"`) : args,
      { stdio: ['ignore', 'pipe', 'pipe'], env, shell: useShell },
    );

    const onAbort = (): void => { proc.kill(); };
    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        proc.kill();
        reject(new Error('Download cancelled'));
        return;
      }
      options.signal.addEventListener('abort', onAbort, { once: true });
    }
    // `{ once: true }` fires once; it does NOT detach on normal completion.
    // One AbortSignal covers a whole sync, so a 24-month backfill left 24 dead
    // listeners on it — each pinning a finished ChildProcess and its two piped
    // streams — and Node warns about a leak from the 11th period on.
    const detachAbort = (): void => { options.signal?.removeEventListener('abort', onAbort); };

    /** The tail of stderr with the progress feed stripped — see
     *  `isProgressNoise`. Bounded so a run that fails after a long transfer
     *  still produces a readable message. */
    const stderrLines: string[] = [];
    const MAX_STDERR_LINES = 40;

    // A chunk boundary can fall anywhere, including mid-line and mid-UTF-8.
    // Splitting each chunk independently delivered `$ gcloud auth lo` + `gin`
    // as two lines, so the credential classifiers — which match on whole
    // phrases — saw neither, and the one failure with a one-click remedy was
    // reported as a bare exit code. StringDecoder holds partial code points;
    // the trailing fragment is carried to the next chunk.
    const makeSink = (capture: boolean): ((data: Buffer) => void) => {
      const decoder = new StringDecoder('utf8');
      let carry = '';
      return (data: Buffer): void => {
        const parts = (carry + decoder.write(data)).split('\n');
        carry = parts.pop() ?? '';
        for (const line of parts) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          options.onLine?.(trimmed);
          if (capture && !isProgressNoise(trimmed)) {
            stderrLines.push(trimmed);
            if (stderrLines.length > MAX_STDERR_LINES) stderrLines.shift();
          }
        }
      };
    };

    proc.stdout.on('data', makeSink(false));
    // `gcloud storage` writes its progress to stderr, so stderr is both the
    // progress feed and the failure text.
    const stderrSink = makeSink(true);
    proc.stderr.on('data', stderrSink);
    // gcloud's last line often has no trailing newline, so the final fragment
    // would otherwise be dropped — including, on a short failure, the entire
    // error. Flush it by feeding a newline once the stream ends.
    proc.stderr.on('end', () => { stderrSink(Buffer.from('\n')); });

    proc.on('error', (err: Error) => {
      detachAbort();
      if (err.message.includes('ENOENT')) {
        reject(new Error('Google Cloud CLI not found — install it with: brew install --cask google-cloud-sdk'));
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
        reject(new Error(`gcloud storage rsync failed (exit ${String(code)}): ${stderrLines.join('\n')}`));
      }
    });
  });
}

export interface GcpSelectiveSyncOptions {
  readonly bucketPath: string;
  /** Which grain this bucket holds — it decides the `raw/{tier}-{period}/`
   *  directory the canonicalized Parquet is installed into. Narrower than
   *  `ExpectedDataType` on purpose: GCP has no Cost Optimization Hub
   *  analogue, so that tier is unrepresentable here rather than merely
   *  rejected downstream. */
  readonly expectedDataType: 'daily' | 'hourly';
  /** Absent means Application Default Credentials. */
  readonly keyFile?: string | undefined;
  /** Service account to run as. See `GcpProviderConfig`. */
  readonly impersonateServiceAccount?: string | undefined;
  readonly providerName: ProviderName;
  readonly dataDir: string;
  readonly files: readonly ManifestFileEntry[];
  readonly onProgress?: ProgressCallback | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** Whether a period prefix is safe to hand to `gcloud storage rsync`.
 *
 *  Two failures it prevents, both silent:
 *   - `extractPeriodPrefix` returns `''` when the `billing_period=YYYY-MM`
 *     token is not followed by `/` (a flat layout: `billing_period=2026-01_a
 *     .parquet`). `extractPeriod` still matches, so the period survives the
 *     filter, and the source collapses to `gs://bucket/` — mirroring the WHOLE
 *     bucket into one period's staging dir, which the canonicalizer then folds
 *     into that month.
 *   - the prefix comes from a listed object key, and on Windows it reaches
 *     cmd.exe; a key carrying shell metacharacters is rejected rather than
 *     escaped. */
function isSafePeriodPrefix(prefix: string): boolean {
  if (!/billing_period=\d{4}-\d{2}\/$/.test(prefix)) return false;
  return !/["'`$%&|<>^\\\r\n]/.test(prefix);
}

/** Staging lives under `meta/`, never under `raw/`. The query layer globs
 *  `raw/{tier}-*​/*.parquet`, so a staging dir named `daily-…` under `raw/`
 *  would be read live — mixing list-of-struct tags into a MAP-tag union and
 *  failing every tag expression mid-sync.
 *
 *  The tier is part of the path: the exporter publishes daily and hourly under
 *  identical `billing_period=YYYY-MM/shard-*.parquet` names, so a period-only
 *  staging dir let a concurrent daily+hourly sync `rm -rf` each other's shards
 *  mid-transfer and install a cross-tier or partial month with etags recorded
 *  complete. Keying it by tier makes the two tiers' staging disjoint. */
function stagingDirFor(dataDir: string, provider: ProviderName, tier: string, period: string): string {
  return join(providerMetaDir(dataDir, provider), 'staging-gcp', tier, period);
}

/**
 * Download, canonicalize and install each requested period.
 *
 * Per period the sequence is: rsync into staging → canonicalize into a
 * sibling temp dir → swap that dir into `raw/{tier}-{period}/` → record
 * etags. Etags are written last on purpose: they are the "this period is
 * up to date" record, so writing them before the swap succeeds would mark a
 * period done that was never installed, and it would never be retried.
 */
export async function syncGcpSelectedFiles(
  options: GcpSelectiveSyncOptions,
): Promise<{ filesDownloaded: number; rowsProcessed: number }> {
  const { bucketPath, providerName, dataDir, files, onProgress } = options;
  const tier = options.expectedDataType;
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
  /** Files and bytes completed by periods that already finished — the running
   *  per-period counters below are offsets from these. */
  let filesBefore = 0;
  let bytesBefore = 0;
  let totalFilesDownloaded = 0;
  let periodsDone = 0;
  let totalRows = 0;
  /** Periods rejected by `isSafePeriodPrefix`. Collected rather than only
   *  logged: a run where every period was skipped used to return normally and
   *  report 100%, so the caller stamped the tier `completed` with a fresh
   *  `lastSync` while nothing had been installed — the UI said "synced just
   *  now", the inventory still said `missing`, and auto-sync repeated the
   *  identical no-op every interval forever. */
  const skipped: string[] = [];

  for (const [period, periodFiles] of periodList) {
    if (options.signal?.aborted) break;

    const firstFile = periodFiles[0];
    if (firstFile === undefined) continue;

    const periodPrefix = extractPeriodPrefix(firstFile.key);
    if (!isSafePeriodPrefix(periodPrefix)) {
      logger.warn(`Skipping GCP period ${period}: ${firstFile.key} is not under a billing_period=YYYY-MM/ folder`);
      skipped.push(period);
      continue;
    }
    const source = `gs://${gcsPath.bucket}/${periodPrefix}`;
    // rsync mirrors ONE prefix — the first file's. Etags must therefore record
    // only the files under that prefix: `extractPeriod` matches
    // `billing_period=YYYY-MM` anywhere in a key, so pointing the provider one
    // level too high (at `gs://b/focus` rather than `gs://b/focus/daily`) puts
    // the daily AND hourly trees in one group. Recording all of them marked the
    // un-downloaded half as up to date permanently, and inflated the file and
    // byte totals with data that never arrived.
    const syncedFiles = periodFiles.filter(f => f.key.startsWith(periodPrefix));
    const strayFiles = periodFiles.length - syncedFiles.length;
    if (strayFiles > 0) {
      logger.warn(
        `GCP period ${period}: ${String(strayFiles)} file(s) sit outside ${periodPrefix} and were not synced — `
        + `the provider's bucket path is probably above the tier folder the exporter writes to`,
      );
    }
    const stagingDir = stagingDirFor(dataDir, providerName, tier, period);
    const periodBytes = syncedFiles.reduce((sum, f) => sum + f.size, 0);
    const sizeByKey = new Map(syncedFiles.map(f => [f.key, f.size]));
    // The file gcloud most recently announced; it is in flight until the next
    // announcement (or until the process exits cleanly).
    let inFlightKey: string | null = null;
    let filesInPeriod = 0;
    let bytesInPeriod = 0;
    /** Last aggregate byte count scraped from gcloud, on the builds that print
     *  one. Retained across lines: recomputing it as `parsed?.bytesDone ?? 0`
     *  would drop back to the manifest count on every announcement line and
     *  run the progress bar backwards. */
    let scrapedBytes = 0;

    logger.info(`Processing GCP period ${period}: ${String(syncedFiles.length)} shard(s)`);

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
        ...(options.impersonateServiceAccount === undefined ? {} : { impersonateServiceAccount: options.impersonateServiceAccount }),
        signal: options.signal,
        onLine: (line) => {
          logger.info(`[gcloud] ${line}`);

          // Each "Copying" line means a transfer STARTED, so the previously
          // announced file has landed. Without this the bar sits at zero for
          // the whole period — gcloud emits no byte counts of its own.
          const startedKey = parseGcloudCopyingKey(line);
          if (startedKey !== null) {
            if (inFlightKey !== null) {
              filesInPeriod++;
              bytesInPeriod += sizeByKey.get(inFlightKey) ?? 0;
            }
            inFlightKey = startedKey;
          }

          const parsed = parseGcloudCompletedBytes(line);
          if (parsed !== null) scrapedBytes = parsed.bytesDone;
          onProgress?.({
            phase: 'downloading',
            filesTotal: totalFiles,
            filesDone: Math.min(filesBefore + filesInPeriod, totalFiles),
            bytesTotal,
            // Clamped: a byte line, where one exists, counts retried bytes and
            // can exceed the listed size — a fraction above 1 would run the
            // progress bar off its track.
            bytesDone: Math.min(bytesBefore + Math.max(bytesInPeriod, scrapedBytes), bytesTotal),
            ...(parsed === null ? {} : { message: line }),
          });
        },
      });

      // A clean exit means every file in the period landed, whatever the
      // running count reached — the last announced file has no successor to
      // imply its completion. Snap to the period's real totals.
      filesBefore = Math.min(filesBefore + syncedFiles.length, totalFiles);
      bytesBefore = Math.min(bytesBefore + periodBytes, bytesTotal);
      totalFilesDownloaded += syncedFiles.length;

      // Reuses the existing worker/UI phase token rather than adding one:
      // "repartitioning" is already rendered as the post-download processing
      // step, which is exactly what canonicalization is.
      //
      // Both numbers must be PERIODS. Reporting files-done against
      // periods-total mixes units — with two shards in one period that reads
      // "2 of 1", and the UI's fraction runs past 100%.
      periodsDone++;
      onProgress?.({ phase: 'repartitioning', filesTotal: periodList.length, filesDone: periodsDone });

      totalRows += await installCanonicalPeriod({
        stagingDir,
        dataDir,
        providerName,
        period,
        tier,
      });

      await saveEtags(dataDir, providerName, tier, period, syncedFiles);
    } finally {
      // Staging is pure scratch; leaving it behind would double the on-disk
      // footprint of every synced month.
      await rm(stagingDir, { recursive: true, force: true }).catch(() => { /* best effort */ });
    }
  }

  // Nothing installable in the whole request: fail loudly instead of
  // reporting a successful sync of zero files. The bucket layout is wrong, and
  // silence here is what let the app claim to be up to date indefinitely.
  if (skipped.length > 0 && skipped.length === periodList.length) {
    throw new Error(
      `No GCP period could be synced: ${String(skipped.length)} period(s) are not under a `
      + `billing_period=YYYY-MM/ folder (${skipped.join(', ')}). Point the provider at the `
      + `bucket prefix the exporter writes to, including its tier folder.`,
    );
  }
  if (skipped.length > 0) {
    logger.warn(`GCP sync skipped ${String(skipped.length)} period(s) with an unexpected layout: ${skipped.join(', ')}`);
  }

  onProgress?.({ phase: 'done', filesTotal: totalFiles, filesDone: totalFiles, bytesTotal, bytesDone: bytesTotal });

  logger.info(`GCP sync complete: ${String(totalFilesDownloaded)} shard(s) across ${String(periodList.length - skipped.length)} period(s), ${String(totalRows)} rows`);
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
