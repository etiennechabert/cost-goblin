import { spawn } from 'node:child_process';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../logger/logger.js';
import type { DimensionsConfig } from '../types/config.js';
import { parseS3Path } from './s3-client.js';
import type { ProgressCallback } from './s3-client.js';
import type { ManifestFileEntry } from './manifest.js';
import { createLazyDuckDB } from './duckdb-lazy.js';

export type ExpectedDataType = 'daily' | 'hourly' | 'cost-optimization';

export interface SelectiveSyncOptions {
  readonly bucketPath: string;
  readonly profile: string;
  readonly dataDir: string;
  readonly dimensionsConfig: DimensionsConfig;
  readonly expectedDataType?: ExpectedDataType | undefined;
  readonly files: readonly ManifestFileEntry[];
  readonly onProgress?: ProgressCallback | undefined;
  readonly signal?: AbortSignal | undefined;
}

const ETAG_FILES: Record<string, string> = {
  'daily': 'sync-etags.json',
  'hourly': 'sync-etags-hourly.json',
  'cost-optimization': 'sync-etags-cost-optimization.json',
};

function extractPeriod(key: string): string {
  const billingMatch = /BILLING_PERIOD=(\d{4}-\d{2})/.exec(key);
  if (billingMatch?.[1] !== undefined) return billingMatch[1];
  const dateMatch = /date=(\d{4}-\d{2})-\d{2}/.exec(key);
  return dateMatch?.[1] ?? 'unknown';
}

function extractPeriodPrefix(key: string): string {
  const billingMatch = /^(.*BILLING_PERIOD=\d{4}-\d{2}\/)/.exec(key);
  if (billingMatch?.[1] !== undefined) return billingMatch[1];
  const dateMatch = /^(.*date=\d{4}-\d{2}-\d{2}\/)/.exec(key);
  return dateMatch?.[1] ?? '';
}

function extractDate(key: string): string | undefined {
  const match = /date=(\d{4}-\d{2}-\d{2})/.exec(key);
  return match?.[1];
}

function groupByPeriod(files: readonly ManifestFileEntry[]): Map<string, ManifestFileEntry[]> {
  const groups = new Map<string, ManifestFileEntry[]>();
  for (const file of files) {
    const period = extractPeriod(file.key);
    const existing = groups.get(period);
    if (existing !== undefined) {
      existing.push(file);
    } else {
      groups.set(period, [file]);
    }
  }
  return groups;
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
  const etagFile = ETAG_FILES[tier] ?? 'sync-etags.json';
  const etagPath = join(dataDir, etagFile);
  let savedEtags: Record<string, Record<string, string>> = {};
  try {
    const raw = await readFile(etagPath, 'utf-8');
    savedEtags = JSON.parse(raw) as Record<string, Record<string, string>>;
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
  const tierDir = join(dataDir, 'aws', tier);

  await mkdir(tierDir, { recursive: true });

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

    // Phase 2: Repartition this period
    logger.info(`Repartitioning ${period}...`);

    if (onProgress !== undefined) {
      onProgress({ phase: 'repartitioning', filesTotal: 0, filesDone: 0 });
    }

    const db = await createLazyDuckDB();
    const conn = await db.connect();

    const tagColumns = options.dimensionsConfig.tags.map(t => ({
      key: `user_${t.tagName}`,
      column: `tag_${t.concept ?? t.tagName}`,
    }));
    const tagSelect = tagColumns
      .map(t => `element_at(resource_tags, '${t.key}')[1] AS ${t.column}`)
      .join(',\n      ');

    const parquetGlob = `'${stagingDir}/*.parquet'`;

    logger.info(`Reading dates from ${parquetGlob}...`);
    const dateResult = await conn.run(
      `SELECT DISTINCT line_item_usage_start_date::DATE::VARCHAR AS d FROM read_parquet(${parquetGlob}) ORDER BY d`,
    );
    const dates: string[] = [];
    let chunk = await dateResult.fetchChunk();
    while (chunk !== null && chunk.rowCount > 0) {
      for (let r = 0; r < chunk.rowCount; r++) {
        const val = chunk.getColumnVector(0).getItem(r);
        if (typeof val === 'string') dates.push(val);
      }
      chunk = await dateResult.fetchChunk();
    }
    logger.info(`Found ${String(dates.length)} dates to partition`);

    for (let di = 0; di < dates.length; di++) {
      const date = dates[di];
      if (date === undefined) continue;
      const dateDir = join(tierDir, `usage_date=${date}`);
      await mkdir(dateDir, { recursive: true });
      const outPath = join(dateDir, 'data.parquet');

      await conn.run(`
        COPY (
          SELECT
            line_item_usage_start_date::DATE AS usage_date,
            line_item_usage_account_id AS account_id,
            line_item_usage_account_name AS account_name,
            COALESCE(product_region_code, '') AS region,
            COALESCE(product_servicecode, '') AS service,
            COALESCE(product_product_family, '') AS service_family,
            COALESCE(line_item_line_item_description, '') AS description,
            COALESCE(line_item_resource_id, '') AS resource_id,
            COALESCE(line_item_usage_amount, 0) AS usage_amount,
            COALESCE(line_item_unblended_cost, 0) AS cost,
            COALESCE(pricing_public_on_demand_cost, 0) AS list_cost,
            COALESCE(line_item_line_item_type, '') AS line_item_type,
            COALESCE(line_item_operation, '') AS operation,
            COALESCE(line_item_usage_type, '') AS usage_type,
            ${tagSelect}
          FROM read_parquet(${parquetGlob})
          WHERE line_item_usage_start_date::DATE = '${date}'
        ) TO '${outPath}' (FORMAT PARQUET, COMPRESSION ZSTD)
      `);

      if (onProgress !== undefined) {
        onProgress({ phase: 'repartitioning', filesTotal: dates.length, filesDone: di + 1 });
      }
    }

    logger.info(`${period}: repartitioned into ${String(dates.length)} daily partitions`);

    await saveEtags(dataDir, tier, period, periodFiles);
  }

  if (onProgress !== undefined) {
    onProgress({ phase: 'done', filesTotal: totalFiles, filesDone: totalFiles });
  }

  logger.info(`Sync complete: ${String(totalFilesDownloaded)} files across ${String(periodList.length)} periods`);
  return { filesDownloaded: totalFilesDownloaded, rowsProcessed: 0 };
}
