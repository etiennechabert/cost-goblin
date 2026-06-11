import type { NormalizationRule, TagDimension } from '../types/config.js';
import type { TagValue } from '../types/branded.js';
import { asTagValue } from '../types/branded.js';

export function applyNormalizationRule(value: string, rule: NormalizationRule): string {
  switch (rule) {
    case 'lowercase':
      return value.toLowerCase();
    case 'uppercase':
      return value.toUpperCase();
    case 'lowercase-kebab':
      return value
        .replaceAll(/([a-z])([A-Z])/g, '$1-$2')
        .replaceAll(/[_\s]+/g, '-')
        .toLowerCase();
    case 'lowercase-underscore':
      return value
        .replaceAll(/([a-z])([A-Z])/g, '$1_$2')
        .replaceAll(/[-\s]+/g, '_')
        .toLowerCase();
    case 'camelCase':
      return value
        .replaceAll(/[-_ ]+([^-_ ])/g, (_, c: string) => c.toUpperCase())
        .replace(/^(.)/, (_, c: string) => c.toLowerCase());
  }
}

export function normalizeTagValue(value: string, rule: NormalizationRule | undefined): string {
  if (rule === undefined) {
    return value;
  }
  return applyNormalizationRule(value, rule);
}

export function resolveAlias(
  normalizedValue: string,
  aliases: Readonly<Record<string, readonly string[]>> | undefined,
): string {
  if (aliases === undefined) {
    return normalizedValue;
  }
  for (const [canonical, aliasList] of Object.entries(aliases)) {
    if (canonical === normalizedValue) {
      return canonical;
    }
    if (aliasList.includes(normalizedValue)) {
      return canonical;
    }
  }
  return normalizedValue;
}

/** Per-region metadata extracted from the SSM global-infrastructure namespace.
 *  Shared shape for alias injection across the Region, Country, and Continent
 *  built-ins. */
export interface RegionEnrichment {
  readonly longName: string;
  readonly country: string;
  readonly continent: string;
}

/** Injects SSM-derived aliases into the Region-family built-ins, so the same
 *  raw `region` column powers three distinct groupings:
 *   - `region`           + useRegionNames   → long names ("Europe (Frankfurt)")
 *   - `region_country`   → ISO country codes ("DE")
 *   - `region_continent` → AWS geo buckets ("EU")
 *
 *  Reuses the alias machinery (SQL CASE, resolveAlias, filter expansion) so
 *  cost queries, filter dropdowns, and entity drill-ins pick up enriched
 *  labels without separate plumbing.
 *
 *  User-defined aliases take precedence: if a region code is already covered
 *  by a user alias entry, we don't add an SSM-sourced entry that would
 *  compete. Codes with an empty value for the requested field are left alone
 *  so the raw code surfaces (better than collapsing everything unknown into
 *  a single bucket). */
function pickRegionField(d: { name: string; useRegionNames?: boolean | undefined }): ((e: RegionEnrichment) => string) | null {
  if (d.name === 'region_country') return (e) => e.country;
  if (d.name === 'region_continent') return (e) => e.continent;
  if (d.useRegionNames === true) return (e) => e.longName;
  return null;
}

function mergeRegionAliases(
  userAliases: Readonly<Record<string, readonly string[]>>,
  regionMap: ReadonlyMap<string, RegionEnrichment>,
  pick: (e: RegionEnrichment) => string,
): Record<string, string[]> {
  const userCovered = new Set<string>();
  for (const list of Object.values(userAliases)) {
    for (const a of list) userCovered.add(a);
  }
  const merged: Record<string, string[]> = {};
  for (const [canonical, list] of Object.entries(userAliases)) {
    merged[canonical] = [...list];
  }
  for (const [code, info] of regionMap) {
    if (userCovered.has(code)) continue;
    const label = pick(info);
    if (label.length === 0) continue;
    const existing = merged[label];
    if (existing === undefined) merged[label] = [code];
    else existing.push(code);
  }
  return merged;
}

export function applyRegionFriendlyNames(
  dims: import('../types/config.js').DimensionsConfig,
  regionMap: ReadonlyMap<string, RegionEnrichment>,
): import('../types/config.js').DimensionsConfig {
  if (regionMap.size === 0) return dims;
  const builtIn = dims.builtIn.map(d => {
    if (d.field !== 'region') return d;
    const pick = pickRegionField(d);
    if (pick === null) return d;
    const merged = mergeRegionAliases(d.aliases ?? {}, regionMap, pick);
    return { ...d, aliases: merged };
  });
  return { ...dims, builtIn };
}

export function applyStripPatterns(value: string, patterns: readonly string[] | undefined): string {
  if (patterns === undefined || patterns.length === 0) return value;
  let result = value;
  for (const p of patterns) {
    if (p.length === 0) continue;
    try {
      result = result.replaceAll(new RegExp(p, 'g'), '');
    } catch { /* invalid regex — skip silently so a typo doesn't blow up resolution */ }
  }
  return result.replaceAll(/\s+/g, ' ').trim();
}

export function normalizeAndResolve(value: string, dimension: TagDimension): TagValue {
  const normalized = normalizeTagValue(value, dimension.normalize);
  const resolved = resolveAlias(normalized, dimension.aliases);
  return asTagValue(resolved);
}

interface NormalizableDimension {
  readonly normalize?: NormalizationRule | undefined;
  readonly aliases?: Readonly<Record<string, readonly string[]>> | undefined;
}

/** DuckDB SQL that mirrors the JS `camelCase` rule in `applyNormalizationRule`.
 *  RE2 (DuckDB's regex engine) can't upper-case a captured group, so the
 *  transform is built from list primitives: split on runs of delimiters,
 *  upper-case the first character of every word after the first, then
 *  lower-case the very first character of the joined result. `expr` is a
 *  column/sub-expression produced by trusted config, never user data, so the
 *  duplicate interpolation is safe. */
function camelCaseSql(expr: string): string {
  const joined =
    `array_to_string(` +
      `list_transform(` +
        `regexp_split_to_array(${expr}, '[-_ ]+'), ` +
        `(w, i) -> CASE WHEN i = 1 OR length(w) = 0 THEN w ` +
                       `ELSE upper(substr(w, 1, 1)) || substr(w, 2) END` +
      `), ''` +
    `)`;
  return `(lower(substr(${joined}, 1, 1)) || substr(${joined}, 2))`;
}

const NORMALIZE_SQL: Record<NormalizationRule, (expr: string) => string> = {
  'lowercase': (expr) => `LOWER(${expr})`,
  'uppercase': (expr) => `UPPER(${expr})`,
  // The inner REGEXP_REPLACE needs the 'g' flag too: without it only the first
  // camelCase boundary is split, so multi-hump values (e.g. `fooBarBaz`)
  // diverged from the JS rule, which splits every boundary.
  'lowercase-kebab': (expr) => String.raw`LOWER(REGEXP_REPLACE(REGEXP_REPLACE(${expr}, '([a-z])([A-Z])', '\1-\2', 'g'), '[_\s]+', '-', 'g'))`,
  'lowercase-underscore': (expr) => String.raw`LOWER(REGEXP_REPLACE(REGEXP_REPLACE(${expr}, '([a-z])([A-Z])', '\1_\2', 'g'), '[-\s]+', '_', 'g'))`,
  'camelCase': camelCaseSql,
};

function buildAliasCases(
  fieldExpr: string,
  aliases: Readonly<Record<string, readonly string[]>>,
): string[] {
  return Object.entries(aliases).map(([canonical, aliasList]) => {
    const allValues = aliasList.map(a => `'${a.replaceAll("'", "''")}'`).join(', ');
    return `WHEN ${fieldExpr} IN (${allValues}) THEN '${canonical.replaceAll("'", "''")}'`;
  });
}

export function buildAliasSqlCase(
  fieldExpr: string,
  dimension: NormalizableDimension,
): string {
  if (dimension.normalize !== undefined) {
    fieldExpr = NORMALIZE_SQL[dimension.normalize](fieldExpr);
  }

  if (dimension.aliases === undefined) return fieldExpr;

  const cases = buildAliasCases(fieldExpr, dimension.aliases);
  if (cases.length === 0) return fieldExpr;

  return `CASE ${cases.join(' ')} ELSE ${fieldExpr} END`;
}
