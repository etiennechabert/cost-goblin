import { ipcMain } from 'electron';
import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { applyNormalizationRule, applyStripPatterns, getRawDirPrefix, isStringRecord, logger } from '@costgoblin/core';
import type { DimensionsConfig, NormalizationRule, TagDimension } from '@costgoblin/core';
import type { AppContext } from './context.js';
import { toNum, toStr } from './query-utils.js';
import { removeAllSidecars } from '../optimize.js';

/** Returns a hash-like fingerprint of the fields that affect sidecar output
 *  for a tag. Aliases are excluded (they apply at query time, not at sidecar
 *  generation). When this fingerprint changes for a tag, its sidecars are
 *  stale and must be regenerated. */
function tagFingerprint(tag: TagDimension): string {
  return JSON.stringify({
    tagName: tag.tagName,
    fallback: tag.accountTagFallback ?? null,
    template: tag.missingValueTemplate ?? null,
  });
}

/** One-shot read of org-accounts.json → id→name map. No caching here (the
 *  preview handler wants fresh data on every toggle change). */
async function loadOrgAccountsMap(dataDir: string): Promise<Map<string, string>> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const map = new Map<string, string>();
  try {
    const raw = await fs.readFile(path.join(path.dirname(dataDir), 'org-accounts.json'), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (isStringRecord(parsed) && Array.isArray(parsed['accounts'])) {
      for (const acct of parsed['accounts']) {
        if (!isStringRecord(acct)) continue;
        const id = acct['id'];
        const name = acct['name'];
        if (typeof id === 'string' && typeof name === 'string' && id.length > 0 && name.length > 0) {
          map.set(id, name);
        }
      }
    }
  } catch { /* no org sync */ }
  return map;
}

/** Snapshot of existing raw files for a tier, used to enqueue regen jobs. */
async function listRawFilesForTier(dataDir: string, tier: 'daily' | 'hourly'): Promise<string[]> {
  const prefix = getRawDirPrefix(tier);
  const rawDir = join(dataDir, 'aws', 'raw');
  const paths: string[] = [];
  try {
    const periods = await readdir(rawDir);
    for (const periodDir of periods) {
      if (!periodDir.startsWith(`${prefix}-`)) continue;
      try {
        const files = await readdir(join(rawDir, periodDir));
        for (const f of files) {
          if (f.endsWith('.parquet')) paths.push(join(rawDir, periodDir, f));
        }
      } catch { /* vanished */ }
    }
  } catch { /* raw dir doesn't exist yet */ }
  return paths;
}

export function registerDimensionsHandlers(app: AppContext): void {
  const { ctx, getConfig, getDimensions, getRegionMap, invalidateDimensions, runQuery, optimizeQueue } = app;

  ipcMain.handle('dimensions:discover-tags', async (): Promise<{ tags: { key: string; sampleValues: string[]; rowCount: number; distinctCount: number; coveragePct: number }[]; samplePeriod: string }> => {
    const config = await getConfig();
    const provider = config.providers[0];
    if (provider === undefined) return { tags: [], samplePeriod: '' };

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
    const totalRows = await runQuery(totalSql);
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
    const rows = await runQuery(sql);

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
  });

  ipcMain.handle('dimensions:get-config', async (): Promise<DimensionsConfig> => {
    return getDimensions();
  });

  // Distinct values + cost for a built-in column — powers the preview on the
  // built-in editor ("Service has 120 distinct values, top 20 by cost are...").
  // Scans the most recent daily period so the preview loads fast.
  ipcMain.handle('dimensions:discover-column-values', async (_event, field: string, opts?: { useOrgAccounts?: boolean; nameStripPatterns?: readonly string[]; normalize?: NormalizationRule }): Promise<{ values: { value: string; cost: number }[]; distinctCount: number; period: string }> => {
    // Whitelist columns we know are safe to embed in SQL. These match the
    // aliases emitted by buildSource so the query plans identically to what
    // the rest of the app does.
    const ALLOWED = new Set(['account_id', 'account_name', 'region', 'service', 'service_family', 'line_item_type', 'operation', 'usage_type']);
    if (!ALLOWED.has(field)) return { values: [], distinctCount: 0, period: '' };

    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const rawDir = path.join(ctx.dataDir, 'aws', 'raw');
    let dirs: string[] = [];
    try {
      dirs = (await fs.readdir(rawDir)).filter(d => d.startsWith('daily-')).sort();
    } catch { /* no data */ }
    const latest = dirs.at(-1);
    if (latest === undefined) return { values: [], distinctCount: 0, period: '' };

    const source = `read_parquet('${ctx.dataDir}/aws/raw/${latest}/*.parquet')`;
    // The raw CUR columns aren't aliased — we need to map the UI-facing field
    // back to the underlying column.
    const RAW_COL: Record<string, string> = {
      account_id: 'line_item_usage_account_id',
      account_name: 'line_item_usage_account_name',
      region: 'product_region_code',
      service: 'product_servicecode',
      service_family: 'product_product_family',
      line_item_type: 'line_item_line_item_type',
      operation: 'line_item_operation',
      usage_type: 'line_item_usage_type',
    };
    const col = RAW_COL[field] ?? field;

    const distinctSql = `SELECT COUNT(DISTINCT ${col}) AS n FROM ${source} WHERE ${col} IS NOT NULL AND ${col} != ''`;
    const valuesSql = `
      SELECT ${col} AS val, SUM(line_item_unblended_cost) AS cost
      FROM ${source}
      WHERE ${col} IS NOT NULL AND ${col} != ''
      GROUP BY val
      ORDER BY cost DESC
      LIMIT 200
    `;
    const [distinctRows, valueRows] = await Promise.all([runQuery(distinctSql), runQuery(valuesSql)]);
    const distinctCount = distinctRows[0] !== undefined ? toNum(distinctRows[0]['n']) : 0;
    let values = valueRows.map(r => ({ value: toStr(r['val']), cost: toNum(r['cost']) }));

    // Account-specific: map each id to its org-data name for the preview. We
    // read org-accounts.json fresh every call so the preview reflects the
    // toggle before the config is saved (otherwise the cached accountMap
    // might be from the wrong source).
    if (field === 'account_id' && opts?.useOrgAccounts === true) {
      const orgMap = await loadOrgAccountsMap(ctx.dataDir);
      if (orgMap.size > 0) {
        values = values.map(v => ({ value: orgMap.get(v.value) ?? v.value, cost: v.cost }));
      }
    }
    // Region: always-on friendly-name resolution from region-names.json. No
    // opt needed — codes not in the map fall through unchanged.
    if (field === 'region') {
      const regionMap = await getRegionMap();
      if (regionMap.size > 0) {
        values = values.map(v => ({ value: regionMap.get(v.value) ?? v.value, cost: v.cost }));
      }
    }
    // Apply the same display-time transforms the live queries use. Order
    // matches the editor's visual top-down flow: normalize first, then strip.
    // After either runs, re-aggregate by the resulting key so two raw values
    // that collapse to the same display value don't show up as duplicate chips.
    const stripPatterns = field === 'account_id' ? opts?.nameStripPatterns : undefined;
    const normalize = opts?.normalize;
    if (normalize !== undefined || (stripPatterns !== undefined && stripPatterns.length > 0)) {
      const merged = new Map<string, number>();
      for (const v of values) {
        let key = v.value;
        if (normalize !== undefined) key = applyNormalizationRule(key, normalize);
        if (stripPatterns !== undefined && stripPatterns.length > 0) key = applyStripPatterns(key, stripPatterns);
        merged.set(key, (merged.get(key) ?? 0) + v.cost);
      }
      values = [...merged.entries()].map(([value, cost]) => ({ value, cost })).sort((a, b) => b.cost - a.cost);
    }

    return { values, distinctCount, period: latest.replace(/^daily-/, '') };
  });

  ipcMain.handle('dimensions:save-config', async (_event, config: DimensionsConfig): Promise<void> => {
    const yaml = await import('yaml');
    const fs = await import('node:fs/promises');

    // Diff the old config against the incoming one to decide which sidecars
    // need to be removed (tags dropped or meaningfully changed) and which raw
    // files need re-optimization (added tags, or changed-fingerprint tags).
    let previousTags: readonly TagDimension[] = [];
    try {
      previousTags = (await getDimensions()).tags;
    } catch {
      // First-time save or config file missing — treat as no previous tags.
    }

    const output = yaml.stringify({
      builtIn: config.builtIn.map(d => ({
        name: d.name,
        label: d.label,
        field: d.field,
        ...(d.displayField === undefined ? {} : { displayField: d.displayField }),
        ...(d.description === undefined ? {} : { description: d.description }),
        ...(d.normalize === undefined ? {} : { normalize: d.normalize }),
        ...(d.aliases === undefined ? {} : { aliases: Object.fromEntries(Object.entries(d.aliases).map(([k, v]) => [k, [...v]])) }),
        ...(d.useOrgAccounts === true ? { useOrgAccounts: true } : {}),
        ...(d.nameStripPatterns !== undefined && d.nameStripPatterns.length > 0 ? { nameStripPatterns: [...d.nameStripPatterns] } : {}),
        ...(d.enabled === false ? { enabled: false } : {}),
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
        ...(t.description === undefined ? {} : { description: t.description }),
        ...(t.enabled === false ? { enabled: false } : {}),
      })),
    });
    await fs.writeFile(ctx.dimensionsPath, output);
    invalidateDimensions();

    // Sidecar housekeeping: wide combined-sidecar design means ANY storage-
    // affecting tag change invalidates the whole sidecar file. Alias-only edits
    // apply at query time and don't touch disk.
    const prevByName = new Map(previousTags.map(t => [t.tagName, t]));
    const nextByName = new Map(config.tags.map(t => [t.tagName, t]));
    const columnsRoot = join(ctx.dataDir, 'aws', 'columns');

    let needsRegen = false;
    for (const [name, prev] of prevByName) {
      const next = nextByName.get(name);
      if (next === undefined || tagFingerprint(prev) !== tagFingerprint(next)) { needsRegen = true; break; }
    }
    if (!needsRegen) {
      for (const name of nextByName.keys()) {
        if (!prevByName.has(name)) { needsRegen = true; break; }
      }
    }

    if (needsRegen) {
      const removed = await removeAllSidecars(columnsRoot);
      if (removed > 0) logger.info(`dimensions: removed ${String(removed)} stale sidecar(s)`);
      const daily = await listRawFilesForTier(ctx.dataDir, 'daily');
      const hourly = await listRawFilesForTier(ctx.dataDir, 'hourly');
      for (const p of [...daily, ...hourly]) optimizeQueue.enqueue(p);
      logger.info(`dimensions: enqueued ${String(daily.length + hourly.length)} files for sidecar regen`);
    }
  });
}
