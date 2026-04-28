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
  return value.toLowerCase().replace(/[-_\s]+/g, '');
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
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
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

export function generateAliasSuggestions(
  values: readonly string[],
  threshold = 0.8,
): readonly AliasSuggestion[] {
  if (values.length === 0) return [];

  const adjacent = new Map<string, Set<string>>();
  for (let i = 0; i < values.length; i++) {
    const a = values[i];
    if (a === undefined) continue;
    if (!adjacent.has(a)) adjacent.set(a, new Set());
    for (let j = i + 1; j < values.length; j++) {
      const b = values[j];
      if (b === undefined) continue;
      if (isSimilar(a, b, threshold)) {
        adjacent.get(a)?.add(b);
        if (!adjacent.has(b)) adjacent.set(b, new Set());
        adjacent.get(b)?.add(a);
      }
    }
  }

  const visited = new Set<string>();
  const suggestions: AliasSuggestion[] = [];

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
        for (const n of neighbors) {
          if (!visited.has(n)) stack.push(n);
        }
      }
    }
    if (cluster.length < 2) continue;
    cluster.sort((a, b) => a.length !== b.length ? a.length - b.length : a.localeCompare(b));
    const canonical = cluster[0];
    if (canonical !== undefined) {
      suggestions.push({ canonical, aliases: cluster.slice(1) });
    }
  }

  return suggestions;
}
