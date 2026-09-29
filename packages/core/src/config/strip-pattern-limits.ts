/** Caps on a built-in dimension's `nameStripPatterns`.
 *
 *  Pure and dependency-free, so the renderer can import it through the browser
 *  entry to validate the editor as the user types. The caps bound how much
 *  regex work a shared config can ask for; the wall-clock bound that makes a
 *  catastrophically backtracking pattern harmless lives in the Node-only
 *  `normalize/strip-bounded.ts`. Real configs use one to five short patterns. */
export const MAX_NAME_STRIP_PATTERNS = 16;
export const MAX_NAME_STRIP_PATTERN_LENGTH = 256;

/** Human-readable reasons `patterns` breaks the caps; empty when it is within
 *  them. Messages name patterns by 1-based position and never echo pattern
 *  text, so they are safe to log and to show. Uncompilable patterns are NOT a
 *  violation: an invalid regex is skipped at run time, never fatal. */
export function nameStripPatternViolations(patterns: readonly string[]): string[] {
  const violations: string[] = [];
  if (patterns.length > MAX_NAME_STRIP_PATTERNS) {
    violations.push(`${String(patterns.length)} patterns — at most ${String(MAX_NAME_STRIP_PATTERNS)} are allowed`);
  }
  for (const [i, pattern] of patterns.entries()) {
    if (pattern.length > MAX_NAME_STRIP_PATTERN_LENGTH) {
      violations.push(`pattern ${String(i + 1)} is ${String(pattern.length)} characters — at most ${String(MAX_NAME_STRIP_PATTERN_LENGTH)} are allowed`);
    }
  }
  return violations;
}
