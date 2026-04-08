import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { logger } from '../logger/logger.js';
import type { DimensionsConfig } from '../types/config.js';
import { createS3Handle, parseS3Path } from './s3-client.js';
import type { ProgressCallback } from './s3-client.js';
import type { ManifestFileEntry } from './manifest.js';
import { createLazyDuckDB } from './duckdb-lazy.js';

export interface SelectiveSyncOptions {
  readonly bucketPath: string;
  readonly profile: string;
  readonly dataDir: string;
  readonly dimensionsConfig: DimensionsConfig;
  readonly files: readonly ManifestFileEntry[];
  readonly onProgress?: ProgressCallback | undefined;
}

function extractPeriod(key: string): string {
  const match = /BILLING_PERIOD=(\d{4}-\d{2})/.exec(key);
  return match?.[1] ?? 'unknown';
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

export async function syncSelectedFiles(options: SelectiveSyncOptions): Promise<{ filesDownloaded: number; rowsProcessed: number }> {
  const { bucketPath, profile, dataDir, files, onProgress } = options;
  const s3Path = parseS3Path(bucketPath);
  const dailyDir = join(dataDir, 'aws', 'daily');

  await mkdir(dailyDir, { recursive: true });

  const s3 = await createS3Handle(profile);
  const periods = groupByPeriod(files);
  const periodList = [...periods.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  let totalFilesDownloaded = 0;
  const totalFiles = files.length;
  let globalFilesDone = 0;
  for (const [period, periodFiles] of periodList) {
    logger.info(`Processing period ${period}: ${String(periodFiles.length)} files`);

    // Phase 1: Download this period's files to a period-specific staging dir
    const stagingDir = join(dataDir, 'aws', 'staging', period);
    await mkdir(stagingDir, { recursive: true });

    for (const file of periodFiles) {
      const localPath = join(stagingDir, basename(file.key));
      logger.info(`Downloading ${basename(file.key)} (${String(Math.round(file.size / 1024 / 1024))}MB)`);

      await s3.downloadFile(s3Path.bucket, file.key, localPath);
      globalFilesDone++;

      if (onProgress !== undefined) {
        onProgress({
          phase: 'downloading',
          filesTotal: totalFiles,
          filesDone: globalFilesDone,
          bytesTotal: 0,
          bytesDone: 0,
        });
      }
    }

    totalFilesDownloaded += periodFiles.length;

    // Phase 2: Repartition this period
    logger.info(`Repartitioning ${period}...`);

    if (onProgress !== undefined) {
      onProgress({ phase: 'repartitioning', filesTotal: 0, filesDone: 0, bytesTotal: 0, bytesDone: 0 });
    }

    logger.info('Creating DuckDB instance for repartitioning...');
    const db = await createLazyDuckDB();
    logger.info('DuckDB instance created, connecting...');
    const conn = await db.connect();
    logger.info('DuckDB connected');

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
      const dateDir = join(dailyDir, `usage_date=${date}`);
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
        onProgress({ phase: 'repartitioning', filesTotal: dates.length, filesDone: di + 1, bytesTotal: 0, bytesDone: 0 });
      }
    }

    logger.info(`${period}: repartitioned into ${String(dates.length)} daily partitions`);

    // Save ETags for this period so we can detect stale data later
    const etagPath = join(dataDir, 'sync-etags.json');
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

    // Phase 3: Clean this period's staging
    try {
      await rm(stagingDir, { recursive: true });
    } catch {
      // ignore
    }
  }

  // Clean parent staging dir if empty
  try {
    await rm(join(dataDir, 'aws', 'staging'), { recursive: true });
  } catch {
    // ignore
  }

  if (onProgress !== undefined) {
    onProgress({ phase: 'done', filesTotal: totalFiles, filesDone: totalFiles, bytesTotal: 0, bytesDone: 0 });
  }

  logger.info(`Sync complete: ${String(totalFilesDownloaded)} files across ${String(periodList.length)} periods`);
  return { filesDownloaded: totalFilesDownloaded, rowsProcessed: 0 };
}
