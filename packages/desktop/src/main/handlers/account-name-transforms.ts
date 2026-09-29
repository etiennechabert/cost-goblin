/** Account-name post-processing for the id → name map. Kept free of electron
 *  (and of context.ts, whose telemetry import pulls in the Sentry main-process
 *  SDK) so it is unit-testable under Vitest. */

import { ACCOUNT_MAP_STRIP_BUDGET, applyNormalizationRule, logger, stripNamesBounded } from '@costgoblin/core';
import type { NormalizationRule, StripNamesResult } from '@costgoblin/core';

/** One log fragment describing the patterns a strip run could not apply, or
 *  null when every pattern applied. Indexes only: pattern text and account
 *  names come from shared config / a peer's org data and are never logged. */
export function describeStripIssues(
  result: Pick<StripNamesResult, 'invalidPatterns' | 'slowPatterns' | 'skippedPatterns'>,
): string | null {
  const parts: string[] = [];
  if (result.slowPatterns.length > 0) parts.push(`slow (timed out) at index [${result.slowPatterns.join(', ')}]`);
  if (result.invalidPatterns.length > 0) parts.push(`invalid at index [${result.invalidPatterns.join(', ')}]`);
  if (result.skippedPatterns.length > 0) parts.push(`not evaluated (time budget spent) at index [${result.skippedPatterns.join(', ')}]`);
  return parts.length === 0 ? null : parts.join('; ');
}

/** Normalize every resolved account name, then apply the account dimension's
 *  `nameStripPatterns` in ONE bounded run (`stripNamesBounded`), so a hostile
 *  or pathological pattern costs at most the account-map budget (~1 s) and
 *  can never throw out of the map build. A pattern that cannot be applied is
 *  skipped (names stay unstripped by it) and logged by index. */
export function applyAccountNameTransforms(
  raw: Map<string, string>,
  normalize: NormalizationRule | undefined,
  patterns: readonly string[] | undefined,
): Map<string, string> {
  if (normalize === undefined && (patterns === undefined || patterns.length === 0)) return raw;
  const entries = [...raw];
  const normalized = entries.map(([, name]) => (normalize === undefined ? name : applyNormalizationRule(name, normalize)));
  const result = stripNamesBounded(normalized, patterns, ACCOUNT_MAP_STRIP_BUDGET);
  const issues = describeStripIssues(result);
  if (issues !== null) {
    logger.warn(`Account-name strip patterns skipped (names are left unstripped by them): ${issues}`);
  }
  const map = new Map<string, string>();
  for (const [i, [id]] of entries.entries()) {
    map.set(id, result.names[i] ?? normalized[i] ?? '');
  }
  return map;
}
