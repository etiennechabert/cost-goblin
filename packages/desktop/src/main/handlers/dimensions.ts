import { ipcMain } from 'electron';
import { applyNormalizationRule, applyStripPatterns, buildGrainProbeQuery, buildSource, computeRollupEstimate, dimensionsConfigToYaml, emptyRollupEstimate, generateAliasSuggestions, isStringRecord, rollupGrainColumns } from '@costgoblin/core';
import type { AliasSuggestion, DimensionsConfig, NormalizationRule, RollupGrainEstimate } from '@costgoblin/core';
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

function filterUncoveredSuggestions(
  suggestions: readonly AliasSuggestion[],
  existingAliases: Readonly<Record<string, readonly string[]>>,
  dismissed: readonly DismissedEntry[],
  tagName: string,
): AliasSuggestion[] {
  const coveredValues = new Set<string>();
  for (const [canonical, aliases] of Object.entries(existingAliases)) {
    coveredValues.add(canonical);
    for (const a of aliases) coveredValues.add(a);
  }

  const filtered: AliasSuggestion[] = [];
  for (const s of suggestions) {
    if (coveredValues.has(s.canonical)) continue;
    const uncovered = s.aliases.filter(a => !coveredValues.has(a));
    if (uncovered.length === 0) continue;
    const candidate: AliasSuggestion = { canonical: s.canonical, aliases: uncovered };
    if (isDismissed(dismissed, tagName, candidate.canonical, candidate.aliases)) continue;
    filtered.push(candidate);
  }
  return filtered;
}

export function registerDimensionsHandlers(app: AppContext): void {
  const { ctx, getConfig, getDimensions, getQueryDimensions, getCostScope, getAvailableColumns, getOrgAccountsPath, getAccountReverseMap, getRegionMap, invalidateDimensions, rollupStore, runQuery } = app;

  ipcMain.handle('dimensions:discover-tags', async (): Promise<{ tags: { key: string; sampleValues: string[]; rowCount: number; distinctCount: number; coveragePct: number }[]; samplePeriod: string }> => {
    const config = await getConfig();
    const provider = config.providers[0];
    if (provider === undefined) return { tags: [], samplePeriod: '' };

    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const dailyDir = path.join(ctx.dataDir, 'aws', 'raw');
    let dirs: string[] = [];
    try {
      dirs = (await fs.readdir(dailyDir)).filter(d => /^daily-\d{4}-(0[1-9]|1[0-2])$/.test(d)).sort((a, b) => a.localeCompare(b));
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
      dirs = (await fs.readdir(rawDir)).filter(d => /^daily-\d{4}-(0[1-9]|1[0-2])$/.test(d)).sort((a, b) => a.localeCompare(b));
    } catch { /* no data */ }
    const latest = dirs.at(-1);
    if (latest === undefined) return { values: [], distinctCount: 0, period: '' };

    // Query through buildSource — the same projection the Explorer and rollup
    // use — so the preview sees aliased columns AND the marketplace
    // re-attribution (Bedrock etc.), instead of raw product_servicecode. `field`
    // is already a buildSource output alias (validated against ALLOWED above).
    const period = latest.replace(/^daily-/, '');
    const costScope = await getCostScope().catch(() => undefined);
    const availableColumns = await getAvailableColumns('daily');
    const orgAccountsPath = await getOrgAccountsPath();
    const source = buildSource({
      dataDir: ctx.dataDir, tier: 'daily', dimensions: await getQueryDimensions(),
      orgAccountsPath, periods: [period], costMetric: 'unblended', availableColumns,
      marketplaceAttribution: costScope?.marketplaceAttribution,
    });

    const distinctSql = `SELECT COUNT(DISTINCT ${field}) AS n FROM ${source} WHERE ${field} IS NOT NULL AND ${field} != ''`;
    const valuesSql = `
      SELECT ${field} AS val, SUM(cost) AS cost
      FROM ${source}
      WHERE ${field} IS NOT NULL AND ${field} != ''
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
    await fs.writeFile(ctx.dimensionsPath, yaml.stringify(dimensionsConfigToYaml(config)));
    invalidateDimensions();
  }

  ipcMain.handle('dimensions:save-config', async (_event, config: DimensionsConfig): Promise<void> => {
    await saveDimensionsConfig(config);
  });

  // Grain cost/benefit estimator (rollup design §8). Probes the most recent
  // daily month for the candidate grain's cardinality and turns it into
  // directional size/compression/rebuild bands + per-dim raw-only flags. Cheap
  // (one scan, ~150–550 ms) so the UI can call it live as dims are toggled.
  ipcMain.handle('dimensions:estimate-rollup-grain', async (_event, candidate: DimensionsConfig): Promise<RollupGrainEstimate> => {
    const current = rollupStore.getStats();
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const rawDir = path.join(ctx.dataDir, 'aws', 'raw');
    let dirs: string[] = [];
    try {
      dirs = (await fs.readdir(rawDir)).filter(d => /^daily-\d{4}-(0[1-9]|1[0-2])$/.test(d)).sort((a, b) => a.localeCompare(b));
    } catch { /* no data */ }
    const latest = dirs.at(-1);
    if (latest === undefined) return emptyRollupEstimate(current);

    const period = latest.replace(/^daily-/, '');
    const grainColumns = rollupGrainColumns(candidate);
    const cardCols = grainColumns.filter(c => c !== 'usage_date');

    const costScope = await getCostScope().catch(() => undefined);
    const availableColumns = await getAvailableColumns('daily');
    const orgAccountsPath = await getOrgAccountsPath();
    const accountReverseMap = await getAccountReverseMap();
    const sql = buildGrainProbeQuery(period, grainColumns, {
      dataDir: ctx.dataDir, dimensions: candidate, orgAccountsPath, accountReverseMap, costScope, availableColumns,
    });
    const rows = await runQuery(sql);
    const row = rows[0];
    if (row === undefined) return { ...emptyRollupEstimate(current), probePeriod: period, months: dirs.length };

    // Actual on-disk size of the raw daily Parquet across the window — the
    // baseline the UI shows the estimated rollup against.
    const rawBytes = await sumParquetBytes(fs, path, rawDir, dirs);

    const dimCardinalities = cardCols.map((column, i) => ({ column, cardinality: toNum(row[`card_${String(i)}`]) }));
    return computeRollupEstimate({
      probePeriod: period,
      months: dirs.length,
      probeGrainRows: toNum(row['grain_rows']),
      probeLineItems: toNum(row['line_items']),
      rawBytes,
      current,
      dimCardinalities,
    });
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
      dirs = (await fs.readdir(rawDir)).filter(d => /^daily-\d{4}-(0[1-9]|1[0-2])$/.test(d)).sort();
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

    const normalizeRule = tag.normalize;
    if (normalizeRule !== undefined) {
      values = [...new Set(values.map(v => applyNormalizationRule(v, normalizeRule)))];
    }

    const suggestions = generateAliasSuggestions(values);
    const dismissed = await loadDismissedSuggestions(ctx.dataDir);
    return filterUncoveredSuggestions(suggestions, tag.aliases ?? {}, dismissed, tagName);
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

/** Sum the on-disk size of every `*.parquet` across the given daily raw dirs —
 *  the raw dataset size the rollup estimate is compared against. Best-effort:
 *  unreadable dirs/files are skipped. */
async function sumParquetBytes(
  fs: typeof import('node:fs/promises'),
  path: typeof import('node:path'),
  rawDir: string,
  dirs: readonly string[],
): Promise<number> {
  let total = 0;
  for (const dir of dirs) {
    const full = path.join(rawDir, dir);
    let files: string[] = [];
    try { files = await fs.readdir(full); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.parquet')) continue;
      try { total += (await fs.stat(path.join(full, f))).size; } catch { /* skip */ }
    }
  }
  return total;
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
