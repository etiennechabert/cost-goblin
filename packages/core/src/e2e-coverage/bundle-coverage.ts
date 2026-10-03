import type { Profiler } from 'node:inspector';
import { pathToFileURL } from 'node:url';
import astV8ToIstanbul from 'ast-v8-to-istanbul';
import v8ToIstanbul from 'v8-to-istanbul';
import { parseAstAsync } from 'vite';
import { isStringRecord, parseJsonObject } from '../utils/json.js';
import { createCoverageReport, mergeIstanbulFile, parseIstanbulFileCoverage } from './collect.js';
import type { CoverageReport, IstanbulFileCoverage } from './types.js';

/** A renderer bundle's `.map`, narrowed to what both converters read. */
export interface SourceMap {
  readonly version: 3;
  readonly mappings: string;
  readonly sources: string[];
  readonly names: string[];
  readonly sourcesContent?: (string | null)[];
  readonly file?: string;
}

/** The e2e coverage of every renderer bundle entry folded in so far. */
export interface BundleCoverage {
  /**
   * As v8-to-istanbul reports it: what `auditCoverageReport` grades. Its
   * thresholds were measured on this shape, and only this shape shows a lost
   * coverage-attach race as inflation (see `./audit.ts`).
   */
  readonly raw: CoverageReport;
  /** As ast-v8-to-istanbul reports it: what gets published. */
  readonly measured: CoverageReport;
}

export function createBundleCoverage(): BundleCoverage {
  return { raw: createCoverageReport(), measured: createCoverageReport() };
}

/** One renderer bundle entry of a V8 dump, with the bundle's `.map` file read. */
export interface BundleEntry {
  readonly bundlePath: string;
  readonly code: string;
  readonly sourceMapText: string;
  readonly functions: readonly Profiler.FunctionCoverage[];
  /** Whether a source of the bundle belongs in the report. */
  readonly isProjectFile: (filePath: string) => boolean;
}

export type BundleEntryResult = { readonly status: 'ok' } | { readonly status: 'error'; readonly message: string };

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item): item is string => typeof item === 'string');
}

function isSourcesContent(value: unknown): value is (string | null)[] {
  return Array.isArray(value) && value.every(item => item === null || typeof item === 'string');
}

/**
 * Narrows a parsed `.map` file to the fields both converters read. Returns
 * `null` without a string `mappings` and string `sources`, or with a
 * `sourceRoot`: ast-v8-to-istanbul files a source under its raw path but
 * credits it under the root-resolved one, so a rooted map's coverage would
 * land on paths the report never created. `version` is not checked, as
 * neither library checks it.
 */
export function parseSourceMap(value: unknown): SourceMap | null {
  if (!isStringRecord(value)) return null;
  const { mappings, sources, names, sourcesContent, sourceRoot, file } = value;
  if (typeof mappings !== 'string' || !isStringArray(sources)) return null;
  if (sourceRoot !== undefined && sourceRoot !== '') return null;
  return {
    version: 3,
    mappings,
    sources,
    names: isStringArray(names) ? names : [],
    ...(isSourcesContent(sourcesContent) ? { sourcesContent } : {}),
    ...(typeof file === 'string' ? { file } : {}),
  };
}

type ParsedFiles = { readonly status: 'ok'; readonly files: Map<string, IstanbulFileCoverage> } | {
  readonly status: 'error';
  readonly message: string;
};

/**
 * Narrows the project files of one converter's output. A file in a shape
 * `parseIstanbulFileCoverage` rejects is an error, not a skip: skipping it
 * would drop it from the report, and dropping predominantly uncovered files
 * RAISES the number — neither the audit nor anything else could tell.
 */
function parseProjectFiles(converter: string, output: unknown, entry: BundleEntry): ParsedFiles {
  if (!isStringRecord(output)) {
    return { status: 'error', message: `${converter} returned no coverage map for ${entry.bundlePath}.` };
  }
  const files = new Map<string, IstanbulFileCoverage>();
  for (const [filePath, value] of Object.entries(output)) {
    if (!entry.isProjectFile(filePath)) continue;
    const data = parseIstanbulFileCoverage(value);
    if (data === null) {
      return {
        status: 'error',
        message:
          `${filePath} came back from ${converter} in an unrecognised shape — ` +
          'the collector cannot tell covered from uncovered lines and refuses to guess. ' +
          `Check whether ${converter} changed its output.`,
      };
    }
    files.set(filePath, data);
  }
  return { status: 'ok', files };
}

/**
 * The published conversion: ast-v8-to-istanbul, the converter
 * @vitest/coverage-v8 uses for the unit report.
 *
 * It is additive where v8-to-istanbul is subtractive. v8-to-istanbul starts
 * every source line at count 1 and lowers it only when a V8 range spans the
 * whole line, so a line a count-0 range covers only partly (a one-line arrow
 * nobody called, a `.sort(…)` comparator on an array nobody built) reads as
 * covered, and so does a line the bundle has no code for at all (a
 * tree-shaken export, an inlined constant). ast-v8-to-istanbul walks the
 * bundle's AST instead and gives each statement, function and branch the
 * count of the innermost V8 range at its start: code V8 never reported
 * running gets 0, and source with no code in the bundle gets no record.
 *
 * Its statement, function and branch maps come from the AST, not from which
 * ranges V8 happened to report, so every shard built from one commit numbers
 * them identically.
 */
async function convertMeasured(entry: BundleEntry, sourceMap: SourceMap): Promise<unknown> {
  return astV8ToIstanbul({
    code: entry.code,
    sourceMap,
    ast: parseAstAsync(entry.code),
    coverage: { url: pathToFileURL(entry.bundlePath).href, functions: [...entry.functions] },
  });
}

/** The audit's conversion: v8-to-istanbul, whose shape its thresholds were measured on. */
async function convertRaw(entry: BundleEntry, sourceMap: SourceMap): Promise<unknown> {
  // `originalSource` is read only for a one-source map without sourcesContent,
  // and an empty one falls through to reading the source from disk.
  const converter = v8ToIstanbul(entry.bundlePath, 0, {
    source: entry.code,
    originalSource: '',
    sourceMap: { sourcemap: sourceMap },
  });
  await converter.load();
  converter.applyCoverage([...entry.functions]);
  return converter.toIstanbul();
}

function sameKeys(a: ReadonlyMap<string, unknown>, b: ReadonlyMap<string, unknown>): boolean {
  return a.size === b.size && [...a.keys()].every(key => b.has(key));
}

/**
 * Converts `entry` with both converters and folds its project files into
 * `coverage`. Returns an error, having folded in nothing, when the result
 * cannot be trusted — the caller must fail rather than publish without it:
 *
 * - The source map does not parse, or has a `sourceRoot` (see
 *   `parseSourceMap`). A map with no sources folds in nothing, successfully.
 * - A converter throws, or returns a file in a shape
 *   `parseIstanbulFileCoverage` rejects.
 * - The converters disagree on which project files the bundle holds. Both
 *   file every source of the map, resolved against the bundle's directory, so
 *   a mismatch means their path resolution has diverged and the audit would
 *   grade a different set of files than the one published.
 */
export async function addBundleEntry(coverage: BundleCoverage, entry: BundleEntry): Promise<BundleEntryResult> {
  const sourceMapPath = `${entry.bundlePath}.map`;
  const sourceMap = parseSourceMap(parseJsonObject(entry.sourceMapText));
  if (sourceMap === null) {
    return {
      status: 'error',
      message: `${sourceMapPath} is not a JSON source map with string mappings and sources and no sourceRoot.`,
    };
  }
  // A chunk with no sources — a facade re-exporting another chunk — has no
  // source lines to report. v8-to-istanbul would file it under the bundle's
  // own path, every line covered; ast-v8-to-istanbul files nothing.
  if (sourceMap.sources.length === 0) return { status: 'ok' };

  let rawOutput: unknown;
  let measuredOutput: unknown;
  try {
    rawOutput = await convertRaw(entry, sourceMap);
    measuredOutput = await convertMeasured(entry, sourceMap);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { status: 'error', message: `Converting ${entry.bundlePath} failed: ${reason}` };
  }

  const raw = parseProjectFiles('v8-to-istanbul', rawOutput, entry);
  if (raw.status === 'error') return raw;
  const measured = parseProjectFiles('ast-v8-to-istanbul', measuredOutput, entry);
  if (measured.status === 'error') return measured;
  if (!sameKeys(raw.files, measured.files)) {
    const only = (a: ReadonlyMap<string, unknown>, b: ReadonlyMap<string, unknown>): string =>
      [...a.keys()].filter(key => !b.has(key)).slice(0, 3).join(', ') || 'none';
    return {
      status: 'error',
      message:
        `v8-to-istanbul and ast-v8-to-istanbul disagree on the project files of ${sourceMapPath} ` +
        `(only v8-to-istanbul: ${only(raw.files, measured.files)}; ` +
        `only ast-v8-to-istanbul: ${only(measured.files, raw.files)}) — their source path resolution has diverged.`,
    };
  }

  for (const [path, data] of raw.files) mergeIstanbulFile(coverage.raw, path, data);
  for (const [path, data] of measured.files) mergeIstanbulFile(coverage.measured, path, data);
  return { status: 'ok' };
}
