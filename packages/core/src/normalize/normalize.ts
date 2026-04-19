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
