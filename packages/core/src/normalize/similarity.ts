import { distance } from 'fastest-levenshtein';

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
 *  false positives. Threshold must be in range [0, 1]. */
export function isSimilar(
  a: string,
  b: string,
  threshold: number = 0.8,
): boolean {
  if (threshold < 0 || threshold > 1) {
    throw new RangeError('threshold must be between 0 and 1');
  }
  return similarity(a, b) >= threshold;
}

/** Finds all values in a list that are similar to the target value above the threshold.
 *  Returns an array of [value, score] tuples sorted by descending similarity score.
 *  Does not include the target value itself in results. */
export function findSimilar(
  target: string,
  values: readonly string[],
  threshold: number = 0.8,
): ReadonlyArray<readonly [string, number]> {
  const results: Array<readonly [string, number]> = [];

  for (const value of values) {
    if (value === target) continue;
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
