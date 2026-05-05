function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const curr = [i] as number[];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (curr[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost,
      );
    }
    prev = curr;
  }
  return prev[n] ?? 0;
}

function normalize(value: string): string {
  return value.toLowerCase().replaceAll(/[-_\s]+/g, '');
}

function isSeparatorVariation(a: string, b: string): boolean {
  return normalize(a) === normalize(b);
}

function isAbbreviation(full: string, abbrev: string): boolean {
  if (full.length <= abbrev.length) return false;
  const nFull = normalize(full);
  const nAbbrev = normalize(abbrev);
  if (nAbbrev.length < 2) return false;

  // Prefix match (e.g. "prod" -> "production")
  if (nFull.startsWith(nAbbrev)) return true;

  // First-letter initials (e.g. "cb" -> "core-banking")
  const words = full
    .replaceAll(/([a-z])([A-Z])/g, '$1 $2')
    .replaceAll(/[-_]+/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 0);
  const initials = words
    .map(w => w[0]?.toLowerCase() ?? '')
    .filter(c => c.length > 0)
    .join('');
  return initials === nAbbrev;
}

function hasPatternMatch(a: string, b: string): boolean {
  if (isSeparatorVariation(a, b)) return true;
  if (isAbbreviation(a, b)) return true;
  if (isAbbreviation(b, a)) return true;
  return false;
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  return 1 - (levenshtein(a, b) / Math.max(a.length, b.length));
}

function isSimilar(a: string, b: string, threshold = 0.8): boolean {
  if (hasPatternMatch(a, b)) return true;
  return similarity(a, b) >= threshold;
}

export interface AliasSuggestion {
  readonly canonical: string;
  readonly aliases: readonly string[];
}

function getOrCreateSet(map: Map<string, Set<string>>, key: string): Set<string> {
  let set = map.get(key);
  if (set === undefined) {
    set = new Set();
    map.set(key, set);
  }
  return set;
}

function linkIfSimilar(adjacent: Map<string, Set<string>>, a: string, b: string, threshold: number): void {
  if (!isSimilar(a, b, threshold)) return;
  getOrCreateSet(adjacent, a).add(b);
  getOrCreateSet(adjacent, b).add(a);
}

function buildAdjacencyMap(
  values: readonly string[],
  threshold: number,
): Map<string, Set<string>> {
  const adjacent = new Map<string, Set<string>>();
  for (let i = 0; i < values.length; i++) {
    const a = values[i];
    if (a === undefined) continue;
    getOrCreateSet(adjacent, a);
    for (let j = i + 1; j < values.length; j++) {
      const b = values[j];
      if (b === undefined) continue;
      linkIfSimilar(adjacent, a, b, threshold);
    }
  }
  return adjacent;
}

function collectCluster(
  start: string,
  adjacent: ReadonlyMap<string, Set<string>>,
  visited: Set<string>,
): string[] {
  const cluster: string[] = [];
  const stack = [start];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);
    cluster.push(current);
    const neighbors = adjacent.get(current);
    if (neighbors === undefined) continue;
    for (const n of neighbors) {
      if (!visited.has(n)) stack.push(n);
    }
  }
  return cluster;
}

export function generateAliasSuggestions(
  values: readonly string[],
  threshold = 0.8,
): readonly AliasSuggestion[] {
  if (values.length === 0) return [];

  const adjacent = buildAdjacencyMap(values, threshold);
  const visited = new Set<string>();
  const suggestions: AliasSuggestion[] = [];

  for (const start of values) {
    if (visited.has(start)) continue;
    const cluster = collectCluster(start, adjacent, visited);
    if (cluster.length < 2) continue;
    cluster.sort((a, b) => a.length === b.length ? a.localeCompare(b) : a.length - b.length);
    const canonical = cluster[0];
    if (canonical !== undefined) {
      suggestions.push({ canonical, aliases: cluster.slice(1) });
    }
  }

  return suggestions;
}
