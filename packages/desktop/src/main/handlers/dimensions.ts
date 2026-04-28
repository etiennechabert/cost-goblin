import { ipcMain } from 'electron';
import { applyNormalizationRule, applyStripPatterns, generateAliasSuggestions, isStringRecord } from '@costgoblin/core';
import type { AliasSuggestion, DimensionsConfig, NormalizationRule } from '@costgoblin/core';
import { type AppContext, loadOrgAccountsMap } from './context.js';
import { toNum, toStr } from './query-utils.js';

type ValueCostPair = { value: string; cost: number };

function mergeValuesByLabel(values: ValueCostPair[], labelFn: (v: string) => string): ValueCostPair[] {
  const merged = new Map<string, number>();
  for (const v of values) {
    const label = labelFn(v.value);
    merged.set(label, (merged.get(label) ?? 0) + v.cost);
  }
  return [...merged.entries()].map(([value, cost]) => ({ value, cost })).sort((a, b) => b.cost - a.cost);
}

async function applyRegionPreview(
  values: ValueCostPair[],
  opts: { dimName?: string; useRegionNames?: boolean } | undefined,
  getRegionMap: () => Promise<ReadonlyMap<string, { longName: string; country: string; continent: string }>>,
): Promise<ValueCostPair[]> {
  const regionMap = await getRegionMap();
  const pick: ((info: { longName: string; country: string; continent: string }) => string) | null = (() => {
    if (opts?.dimName === 'region_country') return (i: { country: string }) => i.country;
    if (opts?.dimName === 'region_continent') return (i: { continent: string }) => i.continent;
    if (opts?.useRegionNames === true) return (i: { longName: string }) => i.longName;
    return null;
  })();
  if (pick === null || regionMap.size === 0) return values;
  return mergeValuesByLabel(values, (raw) => {
    const info = regionMap.get(raw);
    if (info === undefined) return raw;
    const label = pick(info);
    return label.length > 0 ? label : raw;
  });
}

function applyNormalizeAndStrip(
  values: ValueCostPair[],
  field: string,
  opts: { normalize?: NormalizationRule; nameStripPatterns?: readonly string[] } | undefined,
): ValueCostPair[] {
  const stripPatterns = field === 'account_id' ? opts?.nameStripPatterns : undefined;
  const normalize = opts?.normalize;
  if (normalize === undefined && (stripPatterns === undefined || stripPatterns.length === 0)) return values;
  return mergeValuesByLabel(values, (raw) => {
    let key = raw;
    if (normalize !== undefined) key = applyNormalizationRule(key, normalize);
    if (stripPatterns !== undefined && stripPatterns.length > 0) key = applyStripPatterns(key, stripPatterns);
    return key;
  });
}

export function registerDimensionsHandlers(app: AppContext): void {
  const { ctx, getConfig, getDimensions, getRegionMap, invalidateDimensions, runQuery } = app;

  ipcMain.handle('dimensions:discover-tags', async (): Promise<{ tags: { key: string; sampleValues: string[]; rowCount: number; distinctCount: number; coveragePct: number }[]; samplePeriod: string }> => {
    const config = await getConfig();
    const provider = config.providers[0];
    if (provider === undefined) return { tags: [], samplePeriod: '' };

    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const dailyDir = path.join(ctx.dataDir, 'aws', 'raw');
    let dirs: string[] = [];
    try {
      dirs = (await fs.readdir(dailyDir)).filter(d => d.startsWith('daily-')).sort((a, b) => a.localeCompare(b));
    } catch { /* no data */ }
    const recentDirs = dirs.slice(-2);
    const parquetGlobs = recentDirs.map(d => `'${ctx.dataDir}/aws/raw/${d}/*.parquet'`).join(', ');
    const rawParquet = recentDirs.length > 0
      ? `read_parquet([${parquetGlobs}])`
      : `read_parquet('${ctx.dataDir}/aws/raw/daily-*/*.parquet')`;
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const totalSql = `SELECT COUNT(*) AS total FROM ${rawParquet} WHERE line_item_usage_start_date >= '${thirtyDaysAgo}'`;
    const totalRows = await runQuery(totalSql);
    const totalRowCount = totalRows[0] === undefined ? 0 : toNum(totalRows[0]['total']);

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
  ipcMain.handle('dimensions:discover-column-values', async (_event, field: string, opts?: { useOrgAccounts?: boolean; accountNameFromTag?: string; nameStripPatterns?: readonly string[]; normalize?: NormalizationRule; useRegionNames?: boolean; dimName?: string }): Promise<{ values: { value: string; cost: number }[]; distinctCount: number; period: string }> => {
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
      dirs = (await fs.readdir(rawDir)).filter(d => d.startsWith('daily-')).sort((a, b) => a.localeCompare(b));
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
    const distinctCount = distinctRows[0] === undefined ? 0 : toNum(distinctRows[0]['n']);
    let values = valueRows.map(r => ({ value: toStr(r['val']), cost: toNum(r['cost']) }));

    if (field === 'account_id' && opts?.useOrgAccounts === true) {
      const orgMap = await loadOrgAccountsMap(ctx.dataDir, opts.accountNameFromTag);
      if (orgMap.size > 0) {
        values = values.map(v => ({ value: orgMap.get(v.value) ?? v.value, cost: v.cost }));
      }
    }

    if (field === 'region') {
      values = await applyRegionPreview(values, opts, getRegionMap);
    }

    values = applyNormalizeAndStrip(values, field, opts);

    return { values, distinctCount, period: latest.replace(/^daily-/, '') };
  });

  async function saveDimensionsConfig(config: DimensionsConfig): Promise<void> {
    const yaml = await import('yaml');
    const fs = await import('node:fs/promises');

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
        ...(typeof d.accountNameFromTag === 'string' && d.accountNameFromTag.length > 0 ? { accountNameFromTag: d.accountNameFromTag } : {}),
        ...(d.nameStripPatterns !== undefined && d.nameStripPatterns.length > 0 ? { nameStripPatterns: [...d.nameStripPatterns] } : {}),
        // Persist useRegionNames whenever the user has set it explicitly
        // (either value), so toggling off sticks past a reload. Leaving it
        // unset lets mergeDefaultBuiltIns backfill `true` for the Region dim
        // on legacy configs — we only want that for first-time migration.
        ...(d.useRegionNames === undefined ? {} : { useRegionNames: d.useRegionNames }),
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
      ...(config.order === undefined ? {} : { order: [...config.order] }),
    });
    await fs.writeFile(ctx.dimensionsPath, output);
    invalidateDimensions();
  }

  ipcMain.handle('dimensions:save-config', async (_event, config: DimensionsConfig): Promise<void> => {
    await saveDimensionsConfig(config);
  });

  ipcMain.handle('dimensions:get-alias-suggestions', async (_event, tagName: string): Promise<AliasSuggestion[]> => {
    if (tagName.length === 0) return [];

    const config = await getDimensions();
    const tag = config.tags.find(t => t.tagName === tagName);
    if (tag === undefined) return [];

    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const rawDir = path.join(ctx.dataDir, 'aws', 'raw');
    let dirs: string[] = [];
    try {
      dirs = (await fs.readdir(rawDir)).filter(d => d.startsWith('daily-')).sort();
    } catch { /* no data */ }
    const latest = dirs.at(-1);
    if (latest === undefined) return [];

    const source = `read_parquet('${ctx.dataDir}/aws/raw/${latest}/*.parquet')`;
    const rows = await runQuery(`
      WITH tags AS (
        SELECT unnest(map_keys(resource_tags)) AS tag_key,
               unnest(map_values(resource_tags)) AS tag_val
        FROM ${source}
        WHERE resource_tags IS NOT NULL
      )
      SELECT DISTINCT tag_val
      FROM tags
      WHERE tag_key = '${tagName}'
        AND tag_val IS NOT NULL AND tag_val != ''
      ORDER BY tag_val
    `);
    let values = rows.map(r => toStr(r['tag_val'])).filter(v => v.length > 0);
    if (values.length === 0) return [];

    // Apply normalization before clustering so case/format variations
    // already handled by the normalize rule don't produce noise
    const normalizeRule = tag.normalize;
    if (normalizeRule !== undefined) {
      values = [...new Set(values.map(v => applyNormalizationRule(v, normalizeRule)))];
    }

    const suggestions = generateAliasSuggestions(values);

    // Filter out suggestions already covered by existing alias rules
    const existingAliases = tag.aliases ?? {};
    const coveredValues = new Set<string>();
    for (const [canonical, aliases] of Object.entries(existingAliases)) {
      coveredValues.add(canonical);
      for (const a of aliases) coveredValues.add(a);
    }

    const dismissed = await loadDismissedSuggestions(ctx.dataDir);
    const filtered: AliasSuggestion[] = [];
    for (const s of suggestions) {
      const uncovered = s.aliases.filter(a => !coveredValues.has(a));
      if (uncovered.length === 0) continue;
      if (coveredValues.has(s.canonical) && uncovered.length === 0) continue;
      const candidate: AliasSuggestion = { canonical: s.canonical, aliases: uncovered };
      if (isDismissed(dismissed, tagName, candidate.canonical, candidate.aliases)) continue;
      filtered.push(candidate);
    }
    return filtered;
  });

  ipcMain.handle('dimensions:dismiss-suggestion', async (_event, tagName: string, canonical: string, aliases: string[]): Promise<void> => {
    const state = await loadDismissedSuggestions(ctx.dataDir);
    if (isDismissed(state, tagName, canonical, aliases)) return;
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const updated = [...state, { tagName, canonical, aliases, dismissedAt: new Date().toISOString() }];
    await fs.writeFile(
      path.join(path.dirname(ctx.dataDir), 'dismissed-suggestions.json'),
      JSON.stringify({ dismissed: updated }, null, 2),
    );
  });

  ipcMain.handle('dimensions:accept-suggestion', async (_event, tagName: string, canonical: string, aliases: string[]): Promise<void> => {
    const config = await getDimensions();
    const tagIndex = config.tags.findIndex(t => t.tagName === tagName);
    if (tagIndex === -1) return;
    const tag = config.tags[tagIndex];
    if (tag === undefined) return;

    const existing = tag.aliases ?? {};
    const updatedAliases: Record<string, readonly string[]> = { ...existing, [canonical]: aliases };
    const updatedTags = [
      ...config.tags.slice(0, tagIndex),
      { ...tag, aliases: updatedAliases },
      ...config.tags.slice(tagIndex + 1),
    ];
    await saveDimensionsConfig({ ...config, tags: updatedTags });
  });
}

interface DismissedEntry {
  readonly tagName: string;
  readonly canonical: string;
  readonly aliases: readonly string[];
  readonly dismissedAt: string;
}

async function loadDismissedSuggestions(dataDir: string): Promise<readonly DismissedEntry[]> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  try {
    const raw = await fs.readFile(path.join(path.dirname(dataDir), 'dismissed-suggestions.json'), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!isStringRecord(parsed) || !Array.isArray(parsed['dismissed'])) return [];
    return parsed['dismissed'].filter((d: unknown): d is DismissedEntry =>
      isStringRecord(d) &&
      typeof d['tagName'] === 'string' &&
      typeof d['canonical'] === 'string' &&
      Array.isArray(d['aliases']) &&
      (d['aliases'] as unknown[]).every((a: unknown) => typeof a === 'string') &&
      typeof d['dismissedAt'] === 'string',
    );
  } catch {
    return [];
  }
}

function isDismissed(
  entries: readonly DismissedEntry[],
  tagName: string,
  canonical: string,
  aliases: readonly string[],
): boolean {
  const aliasSet = new Set(aliases);
  return entries.some(
    d => d.tagName === tagName &&
      d.canonical === canonical &&
      d.aliases.length === aliases.length &&
      d.aliases.every(a => aliasSet.has(a)),
  );
}
