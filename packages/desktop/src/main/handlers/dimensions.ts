import { ipcMain } from 'electron';
import type { DimensionsConfig } from '@costgoblin/core';
import type { AppContext } from './context.js';
import { queryAll, toNum, toStr } from './query-utils.js';

export function registerDimensionsHandlers(app: AppContext): void {
  const { ctx, getConfig, getDimensions, invalidateDimensions } = app;

  ipcMain.handle('dimensions:discover-tags', async (): Promise<{ tags: { key: string; sampleValues: string[]; rowCount: number; distinctCount: number; coveragePct: number }[]; samplePeriod: string }> => {
    const config = await getConfig();
    const provider = config.providers[0];
    if (provider === undefined) return { tags: [], samplePeriod: '' };

    const conn = await ctx.db.connect();
    try {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const dailyDir = path.join(ctx.dataDir, 'aws', 'raw');
      let dirs: string[] = [];
      try {
        dirs = (await fs.readdir(dailyDir)).filter(d => d.startsWith('daily-')).sort();
      } catch { /* no data */ }
      const recentDirs = dirs.slice(-2);
      const rawParquet = recentDirs.length > 0
        ? `read_parquet([${recentDirs.map(d => `'${ctx.dataDir}/aws/raw/${d}/*.parquet'`).join(', ')}])`
        : `read_parquet('${ctx.dataDir}/aws/raw/daily-*/*.parquet')`;
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

      const totalSql = `SELECT COUNT(*) AS total FROM ${rawParquet} WHERE line_item_usage_start_date >= '${thirtyDaysAgo}'`;
      const totalRows = await queryAll(conn, totalSql);
      const totalRowCount = totalRows[0] !== undefined ? toNum(totalRows[0]['total']) : 0;

      const sql = `
        WITH tags AS (
          SELECT unnest(map_keys(resource_tags)) AS tag_key,
                 unnest(map_values(resource_tags)) AS tag_val
          FROM ${rawParquet}
          WHERE resource_tags IS NOT NULL
            AND line_item_usage_start_date >= '${thirtyDaysAgo}'
        ),
        grouped AS (
          SELECT tag_key, tag_val, COUNT(*) AS val_cnt
          FROM tags
          WHERE tag_val IS NOT NULL AND tag_val != ''
          GROUP BY tag_key, tag_val
        ),
        with_stats AS (
          SELECT *,
                 SUM(val_cnt) OVER (PARTITION BY tag_key) AS key_cnt,
                 COUNT(*) OVER (PARTITION BY tag_key) AS distinct_cnt,
                 ROW_NUMBER() OVER (PARTITION BY tag_key ORDER BY val_cnt DESC) AS rn
          FROM grouped
        )
        SELECT tag_key, key_cnt, distinct_cnt, tag_val, val_cnt
        FROM with_stats
        ORDER BY key_cnt DESC, tag_key, rn
      `;
      const rows = await queryAll(conn, sql);

      const tagMap = new Map<string, { rowCount: number; distinctCount: number; values: { val: string; cnt: number }[] }>();
      for (const row of rows) {
        const key = toStr(row['tag_key']);
        if (key.length === 0) continue;
        let entry = tagMap.get(key);
        if (entry === undefined) {
          entry = { rowCount: toNum(row['key_cnt']), distinctCount: toNum(row['distinct_cnt']), values: [] };
          tagMap.set(key, entry);
        }
        entry.values.push({ val: toStr(row['tag_val']), cnt: toNum(row['val_cnt']) });
      }

      const tagKeys = [...tagMap.entries()].map(([key, data]) => ({
        key,
        sampleValues: data.values.map(v => v.val),
        rowCount: data.rowCount,
        distinctCount: data.distinctCount,
        coveragePct: totalRowCount > 0 ? Math.round((data.rowCount / totalRowCount) * 100) : 0,
      }));

      const samplePeriod = `last 30 days (since ${thirtyDaysAgo})`;
      return { tags: tagKeys, samplePeriod };
    } finally {
      conn.disconnectSync();
    }
  });

  ipcMain.handle('dimensions:get-config', async (): Promise<DimensionsConfig> => {
    return getDimensions();
  });

  ipcMain.handle('dimensions:save-config', async (_event, config: DimensionsConfig): Promise<void> => {
    const yaml = await import('yaml');
    const fs = await import('node:fs/promises');
    const output = yaml.stringify({
      builtIn: config.builtIn.map(d => ({
        name: d.name,
        label: d.label,
        field: d.field,
        ...(d.displayField === undefined ? {} : { displayField: d.displayField }),
      })),
      tags: config.tags.map(t => ({
        tagName: t.tagName,
        label: t.label,
        ...(t.concept === undefined ? {} : { concept: t.concept }),
        ...(t.normalize === undefined ? {} : { normalize: t.normalize }),
        ...(t.separator === undefined ? {} : { separator: t.separator }),
        ...(t.aliases === undefined ? {} : { aliases: Object.fromEntries(Object.entries(t.aliases).map(([k, v]) => [k, [...v]])) }),
        ...(t.accountTagFallback === undefined ? {} : { accountTagFallback: t.accountTagFallback }),
        ...(t.missingValueTemplate === undefined ? {} : { missingValueTemplate: t.missingValueTemplate }),
      })),
    });
    await fs.writeFile(ctx.dimensionsPath, output);
    invalidateDimensions();
  });
}
