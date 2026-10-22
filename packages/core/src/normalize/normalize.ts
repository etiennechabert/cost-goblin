import type { NormalizationRule, TagDimension } from '../types/config.js';
import type { TagValue } from '../types/branded.js';
import { asTagValue } from '../types/branded.js';
// A dependency-free leaf module, safe for the browser entry.
import { SecurityError } from '../query/identifier-validator.js';

function stripSeparatorRuns(value: string): string {
  let out = '';
  let pending = '';
  for (const ch of value) {
    if (ch === '-' || ch === '_' || ch === ' ') {
      pending += ch;
    } else if (pending === '') {
      out += ch;
    } else {
      out += ch.toUpperCase();
      pending = '';
    }
  }
  return out + pending;
}

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
      return stripSeparatorRuns(value).replace(/^(.)/, (_, c: string) => c.toLowerCase());
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
 *  Only `longName` labels a dimension. `country` and `continent` are stored
 *  and shown with the snapshot; `continent` holds SSM's geolocationRegion, an
 *  ISO 3166-2 subdivision ("IE-D"), under its historical name. */
export interface RegionEnrichment {
  readonly longName: string;
  readonly country: string;
  readonly continent: string;
}

/** Injects SSM-derived aliases into the Region built-in when useRegionNames is
 *  on, so raw codes group under long names ("Europe (Frankfurt)").
 *
 *  Reuses the alias machinery (SQL CASE, resolveAlias, filter expansion) so
 *  cost queries, filter dropdowns, and entity drill-ins pick up enriched
 *  labels without separate plumbing.
 *
 *  User-defined aliases take precedence: if a region code is already covered
 *  by a user alias entry, we don't add an SSM-sourced entry that would
 *  compete. Codes with no long name are left alone so the raw code surfaces
 *  (better than collapsing everything unknown into a single bucket). */
function mergeRegionAliases(
  userAliases: Readonly<Record<string, readonly string[]>>,
  regionMap: ReadonlyMap<string, RegionEnrichment>,
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
    const label = info.longName;
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
    if (d.field !== 'region' || d.useRegionNames !== true) return d;
    return { ...d, aliases: mergeRegionAliases(d.aliases ?? {}, regionMap) };
  });
  return { ...dims, builtIn };
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
  // Empty alias lists are semantic no-ops (resolveAlias only maps
  // canonical→canonical for them) but would emit `IN ()` — a DuckDB parse
  // error that breaks every query touching the dimension.
  return Object.entries(aliases)
    .filter(([, aliasList]) => aliasList.length > 0)
    .map(([canonical, aliasList]) => {
      const allValues = aliasList.map(a => `'${a.replaceAll("'", "''")}'`).join(', ');
      return `WHEN ${fieldExpr} IN (${allValues}) THEN '${canonical.replaceAll("'", "''")}'`;
    });
}

export function buildAliasSqlCase(
  fieldExpr: string,
  dimension: NormalizableDimension,
): string {
  if (dimension.normalize !== undefined) {
    const rule = dimension.normalize;
    // Own-property check: an unvalidated config can carry any string, and an
    // inherited key like 'toString' would otherwise resolve to an
    // Object.prototype method and emit garbage SQL.
    if (!Object.hasOwn(NORMALIZE_SQL, rule)) {
      throw new SecurityError(`Unknown normalize rule "${rule.slice(0, 40)}"`);
    }
    fieldExpr = NORMALIZE_SQL[rule](fieldExpr);
  }

  if (dimension.aliases === undefined) return fieldExpr;

  const cases = buildAliasCases(fieldExpr, dimension.aliases);
  if (cases.length === 0) return fieldExpr;

  return `CASE ${cases.join(' ')} ELSE ${fieldExpr} END`;
}
