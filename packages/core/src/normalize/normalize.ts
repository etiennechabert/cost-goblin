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
        .replace(/([a-z])([A-Z])/g, '$1-$2')
        .replace(/[_\s]+/g, '-')
        .toLowerCase();
    case 'lowercase-underscore':
      return value
        .replace(/([a-z])([A-Z])/g, '$1_$2')
        .replace(/[-\s]+/g, '_')
        .toLowerCase();
    case 'camelCase':
      return value
        .replace(/[-_\s]+(.)/g, (_, c: string) => c.toUpperCase())
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
    if (aliasList.some(a => a === normalizedValue)) {
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
export function applyRegionFriendlyNames(
  dims: import('../types/config.js').DimensionsConfig,
  regionMap: ReadonlyMap<string, RegionEnrichment>,
): import('../types/config.js').DimensionsConfig {
  if (regionMap.size === 0) return dims;
  const builtIn = dims.builtIn.map(d => {
    if (d.field !== 'region') return d;
    const pick: ((e: RegionEnrichment) => string) | null =
      d.name === 'region_country' ? (e) => e.country
        : d.name === 'region_continent' ? (e) => e.continent
          : d.useRegionNames === true ? (e) => e.longName
            : null;
    if (pick === null) return d;
    const userAliases = d.aliases ?? {};
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
      result = result.replace(new RegExp(p, 'g'), '');
    } catch { /* invalid regex — skip silently so a typo doesn't blow up resolution */ }
  }
  return result.replace(/\s+/g, ' ').trim();
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

export function buildAliasSqlCase(
  fieldExpr: string,
  dimension: NormalizableDimension,
): string {
  const cases: string[] = [];

  if (dimension.normalize !== undefined) {
    switch (dimension.normalize) {
      case 'lowercase':
        fieldExpr = `LOWER(${fieldExpr})`;
        break;
      case 'uppercase':
        fieldExpr = `UPPER(${fieldExpr})`;
        break;
      case 'lowercase-kebab':
        fieldExpr = `LOWER(REGEXP_REPLACE(REGEXP_REPLACE(${fieldExpr}, '([a-z])([A-Z])', '\\1-\\2'), '[_\\s]+', '-', 'g'))`;
        break;
      case 'lowercase-underscore':
        fieldExpr = `LOWER(REGEXP_REPLACE(REGEXP_REPLACE(${fieldExpr}, '([a-z])([A-Z])', '\\1_\\2'), '[-\\s]+', '_', 'g'))`;
        break;
      case 'camelCase':
        // SQL approximation for grouping — true camelCase applied in TypeScript
        fieldExpr = `LOWER(REPLACE(REPLACE(REPLACE(${fieldExpr}, '-', ''), '_', ''), ' ', ''))`;
        break;
    }
  }

  if (dimension.aliases !== undefined) {
    for (const [canonical, aliasList] of Object.entries(dimension.aliases)) {
      const allValues = aliasList.map(a => `'${a.replaceAll("'", "''")}'`).join(', ');
      cases.push(`WHEN ${fieldExpr} IN (${allValues}) THEN '${canonical.replaceAll("'", "''")}'`);
    }
  }

  if (cases.length === 0) {
    return fieldExpr;
  }

  return `CASE ${cases.join(' ')} ELSE ${fieldExpr} END`;
}
