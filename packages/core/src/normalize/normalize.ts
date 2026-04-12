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

export function normalizeAndResolve(value: string, dimension: TagDimension): TagValue {
  const normalized = normalizeTagValue(value, dimension.normalize);
  const resolved = resolveAlias(normalized, dimension.aliases);
  return asTagValue(resolved);
}

export function buildAliasSqlCase(
  fieldExpr: string,
  dimension: TagDimension,
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
