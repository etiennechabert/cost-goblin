import { spawn } from 'node:child_process';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../logger/logger.js';
import { parseS3Path } from './s3-client.js';
import type { ProgressCallback } from './s3-client.js';
import type { ManifestFileEntry } from './manifest.js';
import {
  type ExpectedDataType,
  extractDate,
  extractPeriodPrefix,
  getEtagFileName,
  groupByPeriod,
  parseEtagsJson,
} from './sync-utils.js';

export type { ExpectedDataType };

export interface SelectiveSyncOptions {
  readonly bucketPath: string;
  readonly profile: string;
  readonly dataDir: string;
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
    const args = ['s3', 'sync', options.source, options.dest, '--profile', options.profile];

    const proc = spawn('aws', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        proc.kill();
        reject(new Error('Download cancelled'));
        return;
      }
      const onAbort = () => { proc.kill(); };
      options.signal.addEventListener('abort', onAbort, { once: true });
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
      if (err.message.includes('ENOENT')) {
        reject(new Error('AWS CLI not found — install it with: brew install awscli'));
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
        reject(new Error(`aws s3 sync failed (exit ${String(code)}): ${stderr.trim()}`));
      }
    });
  });
}

async function saveEtags(
  dataDir: string,
  tier: string,
  period: string,
  periodFiles: readonly ManifestFileEntry[],
): Promise<void> {
  const etagPath = join(dataDir, getEtagFileName(tier));
  let savedEtags: Record<string, Record<string, string>> = {};
  try {
    const raw = await readFile(etagPath, 'utf-8');
    savedEtags = parseEtagsJson(raw);
  } catch {
    // first time
  }
  const periodEtags: Record<string, string> = {};
  for (const f of periodFiles) {
    periodEtags[f.key] = f.contentHash;
  }
  savedEtags[period] = periodEtags;
  await writeFile(etagPath, JSON.stringify(savedEtags, null, 2));
}

async function syncCostOptimization(options: SelectiveSyncOptions): Promise<{ filesDownloaded: number; rowsProcessed: number }> {
  const { bucketPath, profile, dataDir, files, onProgress } = options;
  const s3Path = parseS3Path(bucketPath);
  const outputDir = join(dataDir, 'aws', 'cost-optimization');
  await mkdir(outputDir, { recursive: true });

  const periods = groupByPeriod(files);
  const periodList = [...periods.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const totalFiles = files.length;
  let globalFilesDone = 0;
  let totalFilesDownloaded = 0;

  for (const [period, periodFiles] of periodList) {
    if (options.signal?.aborted) break;

    // Group files by date within the period
    const dateGroups = new Map<string, ManifestFileEntry[]>();
    for (const file of periodFiles) {
      const date = extractDate(file.key);
      if (date === undefined) continue;
      const existing = dateGroups.get(date);
      if (existing !== undefined) {
        existing.push(file);
      } else {
        dateGroups.set(date, [file]);
      }
    }

    logger.info(`Processing cost optimization period ${period}: ${String(dateGroups.size)} dates`);

    for (const [date, dateFiles] of dateGroups) {
      if (options.signal?.aborted) break;

      const firstFile = dateFiles[0];
      if (firstFile === undefined) continue;

      const datePrefix = extractPeriodPrefix(firstFile.key);
      const s3Source = `s3://${s3Path.bucket}/${datePrefix}`;
      const stagingDir = join(dataDir, 'aws', 'raw', `cost-opt-${date}`);
      await mkdir(stagingDir, { recursive: true });

      await runAwsS3Sync({
        source: s3Source,
        dest: stagingDir,
        profile,
        signal: options.signal,
        onLine: (line) => {
          logger.info(`[aws] ${line}`);
          if (line.startsWith('download:')) {
            globalFilesDone++;
          }
          if (onProgress !== undefined) {
            onProgress({
              phase: 'downloading',
              filesTotal: totalFiles,
              filesDone: globalFilesDone,
              message: line.startsWith('Completed') ? line : undefined,
            });
          }
        },
      });

      // Move downloaded files to the output dir (already daily-partitioned)
      const dateDir = join(outputDir, `usage_date=${date}`);
      await mkdir(dateDir, { recursive: true });

      const downloaded = await readdir(stagingDir);
      for (const f of downloaded) {
        if (f.endsWith('.parquet')) {
          await copyFile(join(stagingDir, f), join(dateDir, 'data.parquet'));
        }
      }

      totalFilesDownloaded += dateFiles.length;
    }

    if (onProgress !== undefined) {
      onProgress({ phase: 'repartitioning', filesTotal: 1, filesDone: 1 });
    }

    await saveEtags(dataDir, 'cost-optimization', period, periodFiles);
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

  const { bucketPath, profile, dataDir, files, onProgress } = options;
  const s3Path = parseS3Path(bucketPath);

  const periods = groupByPeriod(files);
  const periodList = [...periods.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  let totalFilesDownloaded = 0;
  const totalFiles = files.length;
  let globalFilesDone = 0;

  for (const [period, periodFiles] of periodList) {
    if (options.signal?.aborted) break;

    logger.info(`Processing period ${period}: ${String(periodFiles.length)} files`);

    const firstFile = periodFiles[0];
    if (firstFile === undefined) continue;

    const periodPrefix = extractPeriodPrefix(firstFile.key);
    const s3Source = `s3://${s3Path.bucket}/${periodPrefix}`;
    const stagingDir = join(dataDir, 'aws', 'raw', `${tier}-${period}`);
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
        if (onProgress !== undefined) {
          onProgress({
            phase: 'downloading',
            filesTotal: totalFiles,
            filesDone: globalFilesDone,
            message: line.startsWith('Completed') ? line : undefined,
          });
        }
      },
    });

    totalFilesDownloaded += periodFiles.length;

    await saveEtags(dataDir, tier, period, periodFiles);
  }

  if (onProgress !== undefined) {
    onProgress({ phase: 'done', filesTotal: totalFiles, filesDone: totalFiles });
  }

  logger.info(`Sync complete: ${String(totalFilesDownloaded)} files across ${String(periodList.length)} periods`);
  return { filesDownloaded: totalFilesDownloaded, rowsProcessed: 0 };
}
