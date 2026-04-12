import { readFile, writeFile, mkdir, unlink, rm } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { logger } from '../logger/logger.js';
import type { SyncConfig } from '../types/config.js';
import type { DimensionsConfig } from '../types/config.js';
import type { SyncState } from './manifest.js';
import { createEmptySyncState, diffManifests } from './manifest.js';
import { createS3Handle, parseS3Path } from './s3-client.js';
import type { ProgressCallback } from './s3-client.js';
import { createLazyDuckDB } from './duckdb-lazy.js';

export interface SyncEngineOptions {
  readonly syncConfig: SyncConfig;
  readonly profile: string;
  readonly dataDir: string;
  readonly dimensionsConfig: DimensionsConfig;
  readonly onProgress?: ProgressCallback | undefined;
}

function tagColumnsFromConfig(options: SyncEngineOptions): readonly { key: string; column: string }[] {
  return options.dimensionsConfig.tags.map(t => ({
    key: `user_${t.tagName}`,
    column: `tag_${t.concept ?? t.tagName}`,
  }));
}

function getStateFilePath(dataDir: string): string {
  return join(dataDir, 'sync-state.json');
}

async function loadSyncState(dataDir: string): Promise<SyncState> {
  const path = getStateFilePath(dataDir);
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as SyncState;
  } catch {
    return createEmptySyncState();
  }
}

async function saveSyncState(dataDir: string, state: SyncState): Promise<void> {
  const path = getStateFilePath(dataDir);
  await mkdir(join(dataDir), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2));
}

async function repartitionToDaily(
  stagingDir: string,
  dailyDir: string,
  tagColumns: readonly { key: string; column: string }[],
  onProgress: ProgressCallback | undefined,
): Promise<number> {
  const db = await createLazyDuckDB();
  const conn = await db.connect();

  const tagSelect = tagColumns
    .map(t => `element_at(resource_tags, '${t.key}')[1] AS ${t.column}`)
    .join(',\n      ');

  const parquetGlob = `'${stagingDir}/**/*.parquet'`;

  // Find distinct dates
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

  logger.info(`Repartitioning ${String(dates.length)} dates`);

  let totalRows = 0;
  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
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
      onProgress({
        phase: 'repartitioning',
        filesTotal: dates.length,
        filesDone: i + 1,
      });
    }
  }

  return totalRows;
}

export async function runSync(options: SyncEngineOptions): Promise<{ filesDownloaded: number }> {
  const { syncConfig, profile, dataDir, onProgress } = options;

  const s3Path = parseS3Path(syncConfig.daily.bucket);
  const stagingDir = join(dataDir, 'aws', 'staging');
  const dailyDir = join(dataDir, 'aws', 'daily');

  await mkdir(stagingDir, { recursive: true });
  await mkdir(dailyDir, { recursive: true });

  // Phase 1: List S3 files
  logger.info(`Listing S3 files: ${s3Path.bucket}/${s3Path.prefix}`);
  if (onProgress !== undefined) {
    onProgress({ phase: 'downloading', filesTotal: 0, filesDone: 0, message: 'Listing S3 files...' });
  }

  const s3 = await createS3Handle(profile);
  const remoteFiles = await s3.listFiles(s3Path.bucket, s3Path.prefix);
  logger.info(`Found ${String(remoteFiles.length)} remote files`);

  // Phase 2: Diff against previous state
  const prevState = await loadSyncState(dataDir);
  const diff = diffManifests(prevState.manifest, {
    files: remoteFiles,
    lastSync: new Date().toISOString(),
    version: 1,
  });

  logger.info(`To download: ${String(diff.toDownload.length)}, to delete: ${String(diff.toDelete.length)}`);

  if (diff.toDownload.length === 0 && diff.toDelete.length === 0) {
    logger.info('Already up to date');
    return { filesDownloaded: 0 };
  }

  // Phase 3: Download new/changed files
  for (let i = 0; i < diff.toDownload.length; i++) {
    const file = diff.toDownload[i];
    if (file === undefined) continue;

    const localPath = join(stagingDir, basename(file.key));
    logger.info(`Downloading ${file.key} (${String(file.size)} bytes)`);

    await s3.downloadFile(s3Path.bucket, file.key, localPath);

    if (onProgress !== undefined) {
      onProgress({
        phase: 'downloading',
        filesTotal: diff.toDownload.length,
        filesDone: i + 1,
        message: `download: ${file.key}`,
      });
    }
  }

  // Phase 4: Delete removed files from local
  for (const key of diff.toDelete) {
    const localPath = join(stagingDir, basename(key));
    try {
      await unlink(localPath);
    } catch {
      // file may not exist locally
    }
  }

  // Phase 5: Repartition staging → daily
  logger.info('Repartitioning to daily partitions');
  const tagColumns = tagColumnsFromConfig(options);
  await repartitionToDaily(stagingDir, dailyDir, tagColumns, onProgress);

  // Phase 6: Clean staging
  try {
    await rm(stagingDir, { recursive: true });
  } catch {
    // staging cleanup is best-effort
  }

  // Phase 7: Save new state
  await saveSyncState(dataDir, {
    manifest: {
      files: remoteFiles,
      lastSync: new Date().toISOString(),
      version: 1,
    },
    lineage: diff.toDownload.map(f => ({
      sourceFile: f.key,
      partitions: [],
    })),
  });

  logger.info(`Sync complete: ${String(diff.toDownload.length)} files downloaded`);

  if (onProgress !== undefined) {
    onProgress({
      phase: 'done',
      filesTotal: diff.toDownload.length,
      filesDone: diff.toDownload.length,
    });
  }

  return { filesDownloaded: diff.toDownload.length };
}
