import { ipcMain } from 'electron';
import { applyNormalizationRule, buildGrainProbeQuery, buildSource, CHARGE_PERIOD_START_UTC_SQL, computeRollupEstimate, dimensionsConfigToYaml, emptyRollupEstimate, generateAliasSuggestions, isStringRecord, rollupGrainColumns, rollupGrainDimensions, sqlEscapeString } from '@costgoblin/core';
import type { AliasSuggestion, ColumnValuesPreview, DimensionsConfig, NormalizationRule, RollupGrainEstimate } from '@costgoblin/core';
import { type AppContext, loadOrgAccountsMap } from './context.js';
import { parseDimensionsPayload, parseDimensionsRewritePayload, parseDimensionsSavePayload, withAcceptedAliasSuggestion } from './dimensions-payload.js';
import { DEFAULT_BUILT_INS } from './dimensions-merge.js';
import { applyNormalizeAndStrip, mergeValuesByLabel, NO_STRIP_ISSUES, parsePreviewStripPatterns, type ValueCostPair } from './dimensions-preview.js';
import { rawGlobLiteral, toNum, toStr } from './query-utils.js';
import { tagDiscoverySince } from './query-windows.js';

/** The Region editor's preview with friendly names on: each code under its
 *  SSM long name (codes the snapshot doesn't name stay raw), merging values
 *  that share one. */
async function applyRegionPreview(
  values: ValueCostPair[],
  getRegionMap: () => Promise<ReadonlyMap<string, { longName: string }>>,
): Promise<ValueCostPair[]> {
  const regionMap = await getRegionMap();
  if (regionMap.size === 0) return values;
  return mergeValuesByLabel(values, (raw) => {
    const longName = regionMap.get(raw)?.longName ?? '';
    return longName.length > 0 ? longName : raw;
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

/** The columns the built-in editor's preview may embed in SQL: the default
 *  built-ins' fields and display fields, all buildSource output aliases, so
 *  the preview plans like the rest of the app. Derived rather than listed, so
 *  no built-in's editor is left previewing nothing (Resource and Provider once
 *  were). */
const PREVIEW_COLUMNS: ReadonlySet<string> = new Set(
  DEFAULT_BUILT_INS.flatMap(d => (d.displayField === undefined ? [d.field] : [d.field, d.displayField])),
);

export function registerDimensionsHandlers(app: AppContext): void {
  const { ctx, getConfig, getDimensions, getQueryDimensions, getQueryCostScope, getFirstProviderName, getQueryProviders, getOrgAccountsPath, getAccountReverseMap, getRegionMap, signatureForDimensions, invalidateDimensions, rollupStore, runQuery } = app;

  ipcMain.handle('dimensions:discover-tags', async (): Promise<{ tags: { key: string; sampleValues: string[]; rowCount: number; distinctCount: number; coveragePct: number }[]; samplePeriod: string }> => {
    const config = await getConfig();
    const provider = config.providers[0];
    if (provider === undefined) return { tags: [], samplePeriod: '' };

    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const dailyDir = path.join(ctx.dataDir, String(provider.name), 'raw');
    let dirs: string[] = [];
    try {
      dirs = (await fs.readdir(dailyDir)).filter(d => /^daily-\d{4}-(0[1-9]|1[0-2])$/.test(d)).sort((a, b) => a.localeCompare(b));
    } catch { /* no data */ }
    const recentDirs = dirs.slice(-2);
    const parquetGlobs = recentDirs.map(d => rawGlobLiteral(ctx.dataDir, String(provider.name), `${d}/*.parquet`)).join(', ');
    const rawParquet = recentDirs.length > 0
      ? `read_parquet([${parquetGlobs}])`
      : `read_parquet(${rawGlobLiteral(ctx.dataDir, String(provider.name), 'daily-*/*.parquet')})`;
    const thirtyDaysAgo = tagDiscoverySince(ctx.now());

    const totalSql = `SELECT COUNT(*) AS total FROM ${rawParquet} WHERE ${CHARGE_PERIOD_START_UTC_SQL} >= '${thirtyDaysAgo}'`;
    const totalRows = await runQuery(totalSql);
    const totalRowCount = totalRows[0] === undefined ? 0 : toNum(totalRows[0]['total']);

    const sql = `
      WITH tags AS (
        SELECT unnest(map_keys(Tags)) AS tag_key,
               unnest(map_values(Tags)) AS tag_val
        FROM ${rawParquet}
        WHERE Tags IS NOT NULL
          AND ${CHARGE_PERIOD_START_UTC_SQL} >= '${thirtyDaysAgo}'
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
  ipcMain.handle('dimensions:discover-column-values', async (_event, field: string, opts?: { useOrgAccounts?: boolean; accountNameFromTag?: string; nameStripPatterns?: readonly string[]; normalize?: NormalizationRule; useRegionNames?: boolean }): Promise<ColumnValuesPreview> => {
    // Renderer input, run on the main thread: shape-check the strip patterns
    // (string[] within the save caps) before any other work, then use only
    // the parsed list. `opts?.` is safe on any IPC value (null, a number, ...).
    const nameStripPatterns = parsePreviewStripPatterns(opts?.nameStripPatterns);
    const empty: ColumnValuesPreview = { values: [], distinctCount: 0, period: '', stripIssues: NO_STRIP_ISSUES };
    if (!PREVIEW_COLUMNS.has(field)) return empty;

    const providers = await getQueryProviders('daily');
    const firstProvider = providers[0];
    if (firstProvider === undefined) return empty;

    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const rawDir = path.join(ctx.dataDir, String(firstProvider.name), 'raw');
    let dirs: string[] = [];
    try {
      dirs = (await fs.readdir(rawDir)).filter(d => /^daily-\d{4}-(0[1-9]|1[0-2])$/.test(d)).sort((a, b) => a.localeCompare(b));
    } catch { /* no data */ }
    const latest = dirs.at(-1);
    if (latest === undefined) return empty;

    // Query through buildSource — the same projection the Explorer and rollup
    // use — so the preview sees aliased columns AND the marketplace
    // re-attribution (Bedrock etc.), instead of raw x_ServiceCode. `field`
    // is already a buildSource output alias (validated against ALLOWED above).
    const period = latest.replace(/^daily-/, '');
    const costScope = await getQueryCostScope();
    const orgAccountsPath = await getOrgAccountsPath();
    // Probe ONLY the provider whose latest month was just listed — handing
    // the same period to every provider's branch would emit zero-match globs
    // for providers without that month (DuckDB fails the whole union). A
    // single-provider preview is the deliberate fast path.
    const source = buildSource({
      dataDir: ctx.dataDir, tier: 'daily', dimensions: await getQueryDimensions(),
      orgAccountsPath,
      providers: [{ name: firstProvider.name, type: firstProvider.type, periods: [period] }],
      costMetric: 'billed',
      marketplaceAttribution: costScope.marketplaceAttribution,
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
      const orgMap = await loadOrgAccountsMap(ctx.stateDir, opts.accountNameFromTag);
      if (orgMap.size > 0) {
        values = values.map(v => ({ value: orgMap.get(v.value) ?? v.value, cost: v.cost }));
      }
    }

    if (field === 'region' && opts?.useRegionNames === true) {
      values = await applyRegionPreview(values, getRegionMap);
    }

    const transformed = applyNormalizeAndStrip(values, field, { normalize: opts?.normalize, nameStripPatterns });

    return { values: transformed.values, distinctCount, period: latest.replace(/^daily-/, ''), stripIssues: transformed.stripIssues };
  });

  // Validates before writing and serializes only the PARSED object, so a
  // renderer payload (or an edited draft) can never persist a dimensions.yaml
  // that fails the next load — it is rejected here, visibly, instead.
  async function saveDimensionsConfig(payload: unknown): Promise<void> {
    // Persisting: over-limit nameStripPatterns and tag-id clashes are rejected.
    await writeDimensionsConfig(parseDimensionsSavePayload(payload));
  }

  async function writeDimensionsConfig(config: DimensionsConfig): Promise<void> {
    const yaml = await import('yaml');
    const fs = await import('node:fs/promises');
    await fs.writeFile(ctx.dimensionsPath, yaml.stringify(dimensionsConfigToYaml(config)));
    invalidateDimensions();
  }

  ipcMain.handle('dimensions:save-config', async (_event, payload: unknown): Promise<void> => {
    await saveDimensionsConfig(payload);
  });

  // Grain cost/benefit estimator (rollup design §8). Probes the most recent
  // daily month for the candidate grain's cardinality and turns it into
  // directional size/compression/rebuild bands + per-dim raw-only flags. Cheap
  // (one scan, ~150–550 ms) so the UI can call it live as dims are toggled.
  ipcMain.handle('dimensions:estimate-rollup-grain', async (_event, candidate: unknown): Promise<RollupGrainEstimate> => {
    // Renderer input: validate before any fs or DuckDB work, then use only
    // the parsed result. Its field/displayField/pathSegment values land in
    // the probe SQL, which runs in the main process's DuckDB.
    const dims = parseDimensionsPayload(candidate);
    const current = rollupStore.getStats();
    const providers = await getQueryProviders('daily');
    const firstProvider = providers[0];
    if (firstProvider === undefined) return emptyRollupEstimate(current);

    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const rawDir = path.join(ctx.dataDir, String(firstProvider.name), 'raw');
    let dirs: string[] = [];
    try {
      dirs = (await fs.readdir(rawDir)).filter(d => /^daily-\d{4}-(0[1-9]|1[0-2])$/.test(d)).sort((a, b) => a.localeCompare(b));
    } catch { /* no data */ }
    const latest = dirs.at(-1);
    if (latest === undefined) return emptyRollupEstimate(current);

    const period = latest.replace(/^daily-/, '');
    const grainColumns = rollupGrainColumns(dims);
    const grainDims = rollupGrainDimensions(dims);

    const costScope = await getQueryCostScope();
    const orgAccountsPath = await getOrgAccountsPath();
    const accountReverseMap = await getAccountReverseMap();
    // Probe the first provider only — its latest month was listed above, and
    // the rollup this estimates is itself bound to the first provider.
    const sql = buildGrainProbeQuery(period, grainColumns, {
      dataDir: ctx.dataDir, dimensions: dims, orgAccountsPath, accountReverseMap, costScope,
      providers: [firstProvider],
    });
    const rows = await runQuery(sql);
    const row = rows[0];
    if (row === undefined) return { ...emptyRollupEstimate(current), probePeriod: period, months: dirs.length };

    // Actual on-disk size of the raw daily Parquet across the window — the
    // baseline the UI shows the estimated rollup against.
    const rawBytes = await sumParquetBytes(fs, path, rawDir, dirs);

    const dimCardinalities = grainDims.map((dim, i) => ({
      column: dim.column,
      cardinality: toNum(row[`card_${String(i)}`]),
      leaveOneOutGrainRows: toNum(row[`loo_${String(i)}`]),
    }));

    // Is the on-disk rollup actually built for THIS grain? Compare the
    // candidate's full shape signature to what the partitions were built
    // against (same signatureForDimensions path getRollupShape uses). When they
    // match, `current` is the real size of this grain, not an estimate.
    const builtSignature = rollupStore.getBuiltSignature();
    const candidateSignature = await signatureForDimensions(dims, firstProvider.type);
    const currentMatchesCandidate = current !== null && builtSignature !== null && builtSignature === candidateSignature;

    return computeRollupEstimate({
      probePeriod: period,
      months: dirs.length,
      probeGrainRows: toNum(row['grain_rows']),
      probeLineItems: toNum(row['line_items']),
      rawBytes,
      current,
      currentMatchesCandidate,
      dimCardinalities,
    });
  });

  ipcMain.handle('dimensions:get-alias-suggestions', async (_event, tagName: string): Promise<AliasSuggestion[]> => {
    if (tagName.length === 0) return [];

    const config = await getDimensions();
    const tag = config.tags.find(t => t.tagName === tagName);
    if (tag === undefined) return [];

    const provider = await getFirstProviderName();
    if (provider === null) return [];

    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const rawDir = path.join(ctx.dataDir, String(provider), 'raw');
    let dirs: string[] = [];
    try {
      dirs = (await fs.readdir(rawDir)).filter(d => /^daily-\d{4}-(0[1-9]|1[0-2])$/.test(d)).sort();
    } catch { /* no data */ }
    const latest = dirs.at(-1);
    if (latest === undefined) return [];

    const source = `read_parquet(${rawGlobLiteral(ctx.dataDir, String(provider), `${latest}/*.parquet`)})`;
    const rows = await runQuery(`
      WITH tags AS (
        SELECT unnest(map_keys(Tags)) AS tag_key,
               unnest(map_values(Tags)) AS tag_val
        FROM ${source}
        WHERE Tags IS NOT NULL
      )
      SELECT DISTINCT tag_val
      FROM tags
      WHERE tag_key = '${sqlEscapeString(tagName)}'
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
    const dismissed = await loadDismissedSuggestions(ctx.stateDir);
    return filterUncoveredSuggestions(suggestions, tag.aliases ?? {}, dismissed, tagName);
  });

  ipcMain.handle('dimensions:dismiss-suggestion', async (_event, tagName: string, canonical: string, aliases: string[]): Promise<void> => {
    const state = await loadDismissedSuggestions(ctx.stateDir);
    if (isDismissed(state, tagName, canonical, aliases)) return;
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const updated = [...state, { tagName, canonical, aliases, dismissedAt: new Date().toISOString() }];
    await fs.writeFile(
      path.join(ctx.stateDir, 'dismissed-suggestions.json'),
      JSON.stringify({ dismissed: updated }, null, 2),
    );
  });

  ipcMain.handle('dimensions:accept-suggestion', async (_event, tagName: string, canonical: string, aliases: string[]): Promise<void> => {
    const updated = withAcceptedAliasSuggestion(await getDimensions(), tagName, canonical, aliases);
    if (updated === null) return;
    // A write-back of the loaded config: a tag-id clash it already had isn't refused.
    await writeDimensionsConfig(parseDimensionsRewritePayload(updated));
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

async function loadDismissedSuggestions(stateDir: string): Promise<readonly DismissedEntry[]> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  try {
    const raw = await fs.readFile(path.join(stateDir, 'dismissed-suggestions.json'), 'utf-8');
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
