import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TraceMap, decodedMappings } from '@jridgewell/trace-mapping';
import { isStringRecord } from '../utils/json.js';
import type { IstanbulFileCoverage } from './types.js';

/** Original source path → the 1-based lines at least one bundle mapping points at. */
export type MappedSourceLines = ReadonlyMap<string, ReadonlySet<number>>;

/** Index of the source in a decoded segment, and of its 0-based original line. */
const SOURCES_INDEX = 1;
const SOURCE_LINE = 2;

/**
 * Where v8-to-istanbul 9.x files a source map's `sources[i]`: its
 * `_resolveSource`, which keys every entry of `toIstanbul()` for a multi-source
 * map, and the path of the single entry of a one-source map. Mirrored rather
 * than re-derived (trace-mapping's `resolvedSources` resolves differently), so
 * that a line set is filed under exactly the path its coverage comes back on.
 */
function resolveLikeV8ToIstanbul(source: string, sourceRoot: string, bundlePath: string): string {
  if (source.startsWith('file://')) return fileURLToPath(source);
  const candidate = join(sourceRoot.replace('file://', ''), source.replace(/^webpack:\/\//, ''));
  return isAbsolute(candidate) ? candidate : resolve(dirname(bundlePath), candidate);
}

/**
 * The original lines each source of `sourceMap` has generated code for: every
 * line some mapping segment of the bundle points back at.
 *
 * v8-to-istanbul 9.x converts coverage subtractively — every source line starts
 * at count 1 and only drops when a V8 range lands on it — and a range can only
 * land on a line the bundle has code for. Source the bundler removed or folded
 * away (an export nothing imports, a constant inlined at its uses, a type) has
 * no mapping, so it is never lowered and reads as covered, whatever ran. This
 * is the set of lines whose count means anything.
 *
 * `bundlePath` is the bundle's own path, against which relative sources
 * resolve. Returns `null` when `sourceMap` is not a version-3 map with a string
 * `mappings` and string `sources` — the caller cannot tell which lines a bundle
 * covers without one, and must not guess.
 */
export function mappedSourceLines(sourceMap: unknown, bundlePath: string): MappedSourceLines | null {
  if (!isStringRecord(sourceMap)) return null;
  const { version, mappings, sources, sourceRoot } = sourceMap;
  if (version !== 3 || typeof mappings !== 'string' || !Array.isArray(sources)) return null;
  const sourcePaths: string[] = [];
  for (const source of sources) {
    if (typeof source !== 'string') return null;
    sourcePaths.push(source);
  }
  const root = typeof sourceRoot === 'string' ? sourceRoot : '';

  const linesBySource = sourcePaths.map(() => new Set<number>());
  const decoded = decodedMappings(new TraceMap({ version: 3, sources: sourcePaths, names: [], mappings }));
  for (const line of decoded) {
    for (const segment of line) {
      // A one-field segment maps generated text to no source at all.
      if (segment.length === 1) continue;
      linesBySource[segment[SOURCES_INDEX]]?.add(segment[SOURCE_LINE] + 1);
    }
  }

  // Two sources resolving to one path (`a.ts` and `./a.ts`) are one file to
  // v8-to-istanbul too: the union is what its merged entry can have code on.
  const result = new Map<string, Set<number>>();
  for (const [index, source] of sourcePaths.entries()) {
    const path = resolveLikeV8ToIstanbul(source, root, bundlePath);
    const lines = result.get(path) ?? new Set<number>();
    for (const line of linesBySource[index] ?? []) lines.add(line);
    result.set(path, lines);
  }
  return result;
}

/**
 * `data` with every statement on a line outside `mappedLines` set to count 0.
 *
 * Zero rather than dropped: Sonar adds the e2e count to the unit report's, so a
 * line the unit tests run stays covered, while dead code in a file only e2e
 * reaches still counts against it. Counts only ever go down, so no line can
 * come out covered that went in uncovered. Functions and branches pass through
 * unchanged: v8-to-istanbul builds both from V8 ranges, which exist only for
 * code the bundle has.
 */
export function zeroUnmappedLines(
  data: IstanbulFileCoverage,
  mappedLines: ReadonlySet<number>,
): IstanbulFileCoverage {
  return {
    statements: data.statements.map(statement =>
      mappedLines.has(statement.line) ? statement : { line: statement.line, count: 0 },
    ),
    functions: data.functions,
    branches: data.branches,
  };
}
