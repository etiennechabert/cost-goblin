import type { Profiler } from 'node:inspector';
import { pathToFileURL } from 'node:url';
import astV8ToIstanbul from 'ast-v8-to-istanbul';
import v8ToIstanbul from 'v8-to-istanbul';
import { parseAstAsync } from 'vite';
import { isStringArray, isStringRecord, parseJsonObject } from '../utils/json.js';
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

function isSourcesContent(value: unknown): value is (string | null)[] {
  return Array.isArray(value) && value.every(item => item === null || typeof item === 'string');
}

/**
 * Narrows a parsed `.map` file to the fields both converters read. Returns
 * `null` without a string `mappings` and string `sources`, or with a non-empty
 * `sourceRoot`: ast-v8-to-istanbul files a source under its raw path but
 * credits it under the root-resolved one, so a rooted map's coverage would
 * land on paths the report never created. `version` is not checked, as
 * neither library checks it.
 */
export function parseSourceMap(value: unknown): SourceMap | null {
  if (!isStringRecord(value)) return null;
  const { mappings, sources, names, sourcesContent, sourceRoot, file } = value;
  if (typeof mappings !== 'string' || !isStringArray(sources)) return null;
  if (sourceRoot !== undefined && sourceRoot !== null && sourceRoot !== '') return null;
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
 *
 * Two inputs are adjusted first; see `withoutIgnoreFileHints` and
 * `branchesOfPreAttachFunctions`.
 */
async function convertMeasured(entry: BundleEntry, sourceMap: SourceMap): Promise<unknown> {
  const code = withoutIgnoreFileHints(entry.code);
  const ignoreNode = branchesOfPreAttachFunctions(entry.functions);
  return astV8ToIstanbul({
    code,
    sourceMap,
    ast: await parseAstAsync(code),
    coverage: { url: pathToFileURL(entry.bundlePath).href, functions: [...entry.functions] },
    ...(ignoreNode === undefined ? {} : { ignoreNode }),
  });
}

// The block and line comment forms ast-v8-to-istanbul recognises.
const IGNORE_FILE_BLOCK_HINT = /\/\*\s*(?:istanbul|[cv]8|node:coverage)\s+ignore\s+file\b[\s\S]*?\*\//g;
const IGNORE_FILE_LINE_HINT = /\/\/[ \t]*(?:istanbul|[cv]8|node:coverage)\s+ignore\s+file\b[^\n]*/g;

function blank(text: string): string {
  return text.replace(/[^\r\n]/g, ' ');
}

/**
 * `code` with every `ignore file` coverage hint blanked out, same length and
 * same line breaks, so V8's offsets still land where they did.
 *
 * ast-v8-to-istanbul reads hints from the whole code it is given, and one
 * `ignore file` anywhere returns an empty report. Given a bundle, that is
 * every source in it, emptied by a hint one dependency (or one project file)
 * kept. The hint means "this module", and vitest honours it per module: the
 * unit side lists no lines for such a project file, so
 * `restrictToExecutableLines` drops it from the e2e report too.
 */
export function withoutIgnoreFileHints(code: string): string {
  return code.replace(IGNORE_FILE_BLOCK_HINT, blank).replace(IGNORE_FILE_LINE_HINT, blank);
}

type IgnoreNode = NonNullable<Parameters<typeof astV8ToIstanbul>[0]['ignoreNode']>;

/**
 * Skips the branches whose innermost V8 function is one compiled before
 * coverage started (`isBlockCoverage: false`) and run since.
 *
 * V8 reports such a function as one range over its whole body, with no block
 * ranges inside, so every arm of every branch in it would get the function's
 * count — an `else` nobody took included. A renderer bundle compiled before
 * the attach reports its whole top level this way: module-level ternaries
 * read fully covered. Statements keep that count, as v8-to-istanbul gave them:
 * module-level code almost always runs straight through, and zeroing it would
 * hide what did run. A branch is exactly what the range cannot vouch for, so
 * it is left to the unit report and to shards that measured it.
 */
export function branchesOfPreAttachFunctions(functions: readonly Profiler.FunctionCoverage[]): IgnoreNode | undefined {
  const bodies = functions.flatMap(fn => {
    const [body] = fn.ranges;
    return body === undefined ? [] : [{ ...body, preAttach: !fn.isBlockCoverage && body.count > 0 }];
  });
  if (!bodies.some(body => body.preAttach)) return undefined;
  return (node, type) => {
    if (type !== 'branch' || !isStringRecord(node)) return false;
    const start = node['start'];
    if (typeof start !== 'number') return false;
    let innermost: (typeof bodies)[number] | undefined;
    for (const body of bodies) {
      if (body.startOffset > start || start >= body.endOffset) continue;
      if (innermost === undefined || body.endOffset - body.startOffset < innermost.endOffset - innermost.startOffset) {
        innermost = body;
      }
    }
    return innermost?.preAttach === true;
  };
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

function keysMissingFrom(a: ReadonlyMap<string, unknown>, b: ReadonlyMap<string, unknown>): string[] {
  return [...a.keys()].filter(key => !b.has(key));
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
 * - V8 reports code running but ast-v8-to-istanbul credits no statement: a
 *   collapse of the published conversion the audit cannot see.
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
  const onlyRaw = keysMissingFrom(raw.files, measured.files);
  const onlyMeasured = keysMissingFrom(measured.files, raw.files);
  if (onlyRaw.length > 0 || onlyMeasured.length > 0) {
    const list = (paths: readonly string[]): string => paths.slice(0, 3).join(', ') || 'none';
    return {
      status: 'error',
      message:
        `v8-to-istanbul and ast-v8-to-istanbul disagree on the project files of ${sourceMapPath} ` +
        `(only v8-to-istanbul: ${list(onlyRaw)}; only ast-v8-to-istanbul: ${list(onlyMeasured)}) — ` +
        'their source path resolution has diverged.',
    };
  }

  // The audit grades `raw`, so a published report that collapsed on its own —
  // V8 offsets no longer landing on the AST's nodes, every count 0 — would
  // pass it and publish all-zero lines with a green job. An entry V8 reports
  // nothing running in is left to the audit, whose diagnostic names the cause.
  const v8RanSomething = entry.functions.some(fn => fn.ranges.some(range => range.count > 0));
  const measuredRanSomething = [...measured.files.values()].some(data =>
    data.statements.some(statement => statement.count > 0),
  );
  if (v8RanSomething && measured.files.size > 0 && !measuredRanSomething) {
    return {
      status: 'error',
      message:
        `ast-v8-to-istanbul credited no statement of ${entry.bundlePath} that V8 reported running — ` +
        'its conversion has stopped lining up with the coverage and the collector refuses to publish it.',
    };
  }

  for (const [path, data] of raw.files) mergeIstanbulFile(coverage.raw, path, data);
  for (const [path, data] of measured.files) mergeIstanbulFile(coverage.measured, path, data);
  return { status: 'ok' };
}
