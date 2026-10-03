import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type EncodedSourceMap, TraceMap, decodedMappings } from '@jridgewell/trace-mapping';
import { isStringRecord } from '../utils/json.js';
import type { IstanbulFileCoverage } from './types.js';

/**
 * Original source path → the 1-based lines at least one bundle mapping points
 * at, or why the map cannot be read that way.
 */
export type MappedSourceLines =
  | { readonly status: 'ok'; readonly lines: ReadonlyMap<string, ReadonlySet<number>> }
  | { readonly status: 'unsupported'; readonly reason: string };

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item): item is string => typeof item === 'string');
}

function isSourcesContent(value: unknown): value is (string | null)[] {
  return Array.isArray(value) && value.every(item => item === null || typeof item === 'string');
}

/**
 * Narrows a parsed `.map` file to the fields v8-to-istanbul and
 * `mappedSourceLines` read. Returns `null` without a string `mappings` and
 * string `sources`. `version` is not checked, as neither library checks it.
 */
export function parseSourceMap(value: unknown): EncodedSourceMap | null {
  if (!isStringRecord(value)) return null;
  const { mappings, sources, names, sourcesContent, sourceRoot, file } = value;
  if (typeof mappings !== 'string' || !isStringArray(sources)) return null;
  return {
    version: 3,
    mappings,
    sources,
    names: isStringArray(names) ? names : [],
    ...(isSourcesContent(sourcesContent) ? { sourcesContent } : {}),
    ...(typeof sourceRoot === 'string' ? { sourceRoot } : {}),
    ...(typeof file === 'string' ? { file } : {}),
  };
}

/**
 * Where v8-to-istanbul 9.x files a source: its `_resolveSource`, which keys
 * every entry of `toIstanbul()`. Mirrored rather than re-derived, so that a
 * line set is filed under exactly the path its coverage comes back on.
 * Throws where `fileURLToPath` does.
 */
function resolveLikeV8ToIstanbul(source: string, sourceRoot: string, bundlePath: string): string {
  if (source.startsWith('file://')) return fileURLToPath(source);
  const candidate = join(sourceRoot.replace('file://', ''), source.replace(/^webpack:\/\//, ''));
  return isAbsolute(candidate) ? candidate : resolve(dirname(bundlePath), candidate);
}

/**
 * The original lines each source of `map` has generated code for: every line
 * some mapping segment of the bundle points back at.
 *
 * v8-to-istanbul 9.x converts coverage subtractively — every source line starts
 * at count 1 and only drops when a V8 range spans it — and source the bundler
 * removed or folded away (an export nothing imports, a constant inlined at its
 * uses) gets no range, so it reads as covered whatever ran. A line outside
 * these sets is one of those. (A line WITH code can still read 1 when a count-0
 * range covers only part of it; that is v8-to-istanbul's line model, which this
 * does not fix.)
 *
 * `bundlePath` is the bundle's own path, against which relative sources
 * resolve. `unsupported` covers what v8-to-istanbul would mis-attribute rather
 * than fail on: a multi-source map whose sources trace-mapping resolves to a
 * different string (a `sourceRoot`, a `webpack://` source) has its V8 ranges
 * applied to the wrong file, and two sources resolving to one path come back as
 * one entry that none of the ranges lowered. Counts from either are wrong
 * before any line is zeroed, so the caller must not publish them.
 */
export function mappedSourceLines(map: EncodedSourceMap, bundlePath: string): MappedSourceLines {
  const root = map.sourceRoot ?? '';
  const traceMap = new TraceMap(map);
  let paths: string[];
  try {
    if (map.sources.length <= 1) {
      // A one-source map is filed under its source or, failing that, its
      // `file` or the bundle itself; its ranges have nowhere else to go.
      const candidate = map.sources.length === 1 ? map.sources[0] : map.file;
      const source = candidate === undefined || candidate === null || candidate === '' ? bundlePath : candidate;
      paths = [resolveLikeV8ToIstanbul(source, root, bundlePath)];
    } else {
      paths = map.sources.map(source => resolveLikeV8ToIstanbul(source ?? '', root, bundlePath));
    }
  } catch (error) {
    return { status: 'unsupported', reason: error instanceof Error ? error.message : String(error) };
  }

  if (map.sources.length > 1) {
    for (const [index, source] of map.sources.entries()) {
      if (traceMap.resolvedSources[index] !== source) {
        return {
          status: 'unsupported',
          reason: `source "${String(source)}" resolves to "${String(traceMap.resolvedSources[index])}", so v8-to-istanbul would credit its coverage to another file`,
        };
      }
    }
    if (new Set(paths).size !== paths.length) {
      return {
        status: 'unsupported',
        reason: 'two sources resolve to one path, which v8-to-istanbul reports from a copy no coverage reached',
      };
    }
  }

  const lines = paths.map(() => new Set<number>());
  for (const segments of decodedMappings(traceMap)) {
    for (const segment of segments) {
      // A one-field segment maps generated text to no source at all.
      if (segment.length === 1) continue;
      const [, sourceIndex, sourceLine] = segment;
      lines[map.sources.length <= 1 ? 0 : sourceIndex]?.add(sourceLine + 1);
    }
  }
  return { status: 'ok', lines: new Map(paths.map((path, index) => [path, lines[index] ?? new Set()])) };
}

/**
 * `data` with every statement on a line outside `mappedLines` set to count 0.
 *
 * Zero rather than dropped: Sonar adds the e2e count to the unit report's, so a
 * line the unit tests run stays covered, while a dead statement in a file only
 * e2e reaches still counts against it. Counts only ever go down. Functions and
 * branches pass through: v8-to-istanbul builds both from V8 ranges, which
 * start on mapped code.
 */
export function zeroUnmappedLines(
  data: IstanbulFileCoverage,
  mappedLines: ReadonlySet<number>,
): IstanbulFileCoverage {
  return {
    ...data,
    statements: data.statements.map(statement =>
      mappedLines.has(statement.line) ? statement : { ...statement, count: 0 },
    ),
  };
}
