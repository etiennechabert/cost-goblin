/** Value transforms for the built-in dimension editor's preview
 *  (`dimensions:discover-column-values`). Kept free of electron and of
 *  dimensions.ts/context.ts so it is unit-testable under Vitest. */

import {
  ConfigValidationError,
  PREVIEW_STRIP_BUDGET,
  applyNormalizationRule,
  nameStripPatternViolations,
  stripNamesBounded,
} from '@costgoblin/core';
import type { NormalizationRule, StripPatternIssues } from '@costgoblin/core';

export type ValueCostPair = { value: string; cost: number };

export const NO_STRIP_ISSUES: StripPatternIssues = { invalid: [], slow: [], skipped: [] };

export function mergeValuesByLabel(values: ValueCostPair[], labelFn: (v: string) => string): ValueCostPair[] {
  const merged = new Map<string, number>();
  for (const v of values) {
    const label = labelFn(v.value);
    merged.set(label, (merged.get(label) ?? 0) + v.cost);
  }
  return [...merged.entries()].map(([value, cost]) => ({ value, cost })).sort((a, b) => b.cost - a.cost);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v: unknown) => typeof v === 'string');
}

/** Shape-check the renderer's `nameStripPatterns` before any work: undefined,
 *  or an array of strings within the same caps the save handler enforces.
 *  The renderer is untrusted, and this list is run on the main thread.
 *  @throws {ConfigValidationError} otherwise (the message never echoes
 *  pattern text) */
export function parsePreviewStripPatterns(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!isStringArray(value)) {
    throw new ConfigValidationError('nameStripPatterns must be an array of strings');
  }
  const violations = nameStripPatternViolations(value);
  if (violations.length > 0) {
    throw new ConfigValidationError(`nameStripPatterns: ${violations.join('; ')}`);
  }
  return [...value];
}

/** Apply the editor's normalization and (account dimension only) strip
 *  patterns to the preview values, merging values that land on the same
 *  label. Stripping is one bounded run under the preview budget (~300 ms);
 *  patterns it could not apply are reported, by index, in `stripIssues`. */
export function applyNormalizeAndStrip(
  values: ValueCostPair[],
  field: string,
  opts: { readonly normalize?: NormalizationRule | undefined; readonly nameStripPatterns?: readonly string[] | undefined } | undefined,
): { values: ValueCostPair[]; stripIssues: StripPatternIssues } {
  const stripPatterns = field === 'account_id' ? opts?.nameStripPatterns : undefined;
  const normalize = opts?.normalize;
  if (normalize === undefined && (stripPatterns === undefined || stripPatterns.length === 0)) {
    return { values, stripIssues: NO_STRIP_ISSUES };
  }
  const normalized = values.map(v => (normalize === undefined ? v.value : applyNormalizationRule(v.value, normalize)));
  const stripped = stripNamesBounded(normalized, stripPatterns, PREVIEW_STRIP_BUDGET);
  const relabeled = values.map((v, i) => ({ value: stripped.names[i] ?? v.value, cost: v.cost }));
  return {
    values: mergeValuesByLabel(relabeled, label => label),
    stripIssues: {
      invalid: stripped.invalidPatterns,
      slow: stripped.slowPatterns,
      skipped: stripped.skippedPatterns,
    },
  };
}
