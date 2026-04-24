import { distance } from 'fastest-levenshtein';

/** Normalize a string for pattern matching by converting to lowercase and
 *  removing common separators (hyphens, underscores, spaces).
 *  Used for detecting case and separator variations. */
export function normalizeForPatternMatching(value: string): string {
  return value
    .toLowerCase()
    .replace(/[-_\s]+/g, '');
}

/** Returns true if two strings are identical when case is ignored.
 *  Example: "prod" === "Prod" === "PROD" */
export function isCaseVariation(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Returns true if two strings are identical when separators are normalized.
 *  Example: "core-banking" === "core_banking" === "corebanking"
 *  Also handles case variations: "CoreBanking" === "core-banking" */
export function isSeparatorVariation(a: string, b: string): boolean {
  return normalizeForPatternMatching(a) === normalizeForPatternMatching(b);
}

/** Returns true if `abbrev` could be an abbreviation of `full`.
 *  Checks if abbrev matches the first letters of words in full,
 *  or is a simple prefix truncation.
 *  Examples: "prd" is abbreviation of "production", "prod" is abbreviation of "production" */
export function isPotentialAbbreviation(full: string, abbrev: string): boolean {
  if (full.length <= abbrev.length) return false;

  const normalizedFull = normalizeForPatternMatching(full);
  const normalizedAbbrev = normalizeForPatternMatching(abbrev);

  if (normalizedAbbrev.length === 0 || normalizedFull.length === 0) return false;

  // Check if abbrev is a simple prefix of full
  if (normalizedFull.startsWith(normalizedAbbrev)) return true;

  // Check if abbrev matches first letters of words
  // Split on case boundaries and separators to extract word starts
  const words = full
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 0);

  if (words.length === 0) return false;

  // Collect first letters of words
  const firstLetters = words
    .map(w => w[0]?.toLowerCase() ?? '')
    .filter(c => c.length > 0)
    .join('');

  return firstLetters === normalizedAbbrev;
}

/** Returns true if two strings match any pattern-based rule:
 *  case variation, separator variation, or abbreviation.
 *  This is a faster check than fuzzy similarity for exact pattern matches. */
export function hasPatternMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (isCaseVariation(a, b)) return true;
  if (isSeparatorVariation(a, b)) return true;
  if (isPotentialAbbreviation(a, b)) return true;
  if (isPotentialAbbreviation(b, a)) return true;
  return false;
}

/** Normalized similarity score between 0 (no match) and 1 (identical).
 *  Uses Levenshtein distance normalized by the length of the longer string. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const lev = distance(a, b);
  const maxLen = Math.max(a.length, b.length);
  return 1 - (lev / maxLen);
}

/** Returns true if two strings are similar enough to be considered potential aliases.
 *  Default threshold of 0.8 catches common typos and minor variations while avoiding
 *  false positives. Threshold must be in range [0, 1].
 *  Pattern matches (case, separator, abbreviation) are checked first as a fast path. */
export function isSimilar(
  a: string,
  b: string,
  threshold: number = 0.8,
): boolean {
  if (threshold < 0 || threshold > 1) {
    throw new RangeError('threshold must be between 0 and 1');
  }

  // Fast path: check pattern-based matches first
  if (hasPatternMatch(a, b)) return true;

  return similarity(a, b) >= threshold;
}

/** Finds all values in a list that are similar to the target value above the threshold.
 *  Returns an array of [value, score] tuples sorted by descending similarity score.
 *  Does not include the target value itself in results.
 *  Pattern matches (case, separator, abbreviation) are given a perfect score of 1.0. */
export function findSimilar(
  target: string,
  values: readonly string[],
  threshold: number = 0.8,
): ReadonlyArray<readonly [string, number]> {
  const results: Array<readonly [string, number]> = [];

  for (const value of values) {
    if (value === target) continue;

    // Check pattern match first (fast path with perfect score)
    if (hasPatternMatch(target, value)) {
      results.push([value, 1.0] as const);
      continue;
    }

    const score = similarity(target, value);
    if (score >= threshold) {
      results.push([value, score] as const);
    }
  }

  return results.sort((a, b) => b[1] - a[1]);
}

/** Groups values by similarity, returning clusters where all members are similar
 *  to at least one other member in the cluster (transitive closure).
 *  Each cluster is sorted with the most canonical value first (shortest, then lexicographic).
 *  Returns only clusters with 2+ members. */
export function clusterBySimilarity(
  values: readonly string[],
  threshold: number = 0.8,
): ReadonlyArray<readonly string[]> {
  if (values.length === 0) return [];

  // Build adjacency list of similar values
  const adjacent = new Map<string, Set<string>>();
  for (let i = 0; i < values.length; i++) {
    const a = values[i];
    if (a === undefined) continue;

    if (!adjacent.has(a)) {
      adjacent.set(a, new Set());
    }

    for (let j = i + 1; j < values.length; j++) {
      const b = values[j];
      if (b === undefined) continue;

      if (isSimilar(a, b, threshold)) {
        adjacent.get(a)?.add(b);
        if (!adjacent.has(b)) {
          adjacent.set(b, new Set());
        }
        adjacent.get(b)?.add(a);
      }
    }
  }

  // Find connected components via DFS
  const visited = new Set<string>();
  const clusters: Array<string[]> = [];

  for (const start of values) {
    if (visited.has(start)) continue;

    const cluster: string[] = [];
    const stack = [start];

    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined || visited.has(current)) continue;

      visited.add(current);
      cluster.push(current);

      const neighbors = adjacent.get(current);
      if (neighbors !== undefined) {
        for (const neighbor of neighbors) {
          if (!visited.has(neighbor)) {
            stack.push(neighbor);
          }
        }
      }
    }

    if (cluster.length >= 2) {
      // Sort cluster: shortest first, then lexicographic
      cluster.sort((a, b) => {
        if (a.length !== b.length) return a.length - b.length;
        return a.localeCompare(b);
      });
      clusters.push(cluster);
    }
  }

  return clusters;
}
