import { isStringRecord } from '../utils/json.js';
import type {
  CoverageReport,
  ExecutableLines,
  FileCoverage,
  IstanbulBranch,
  IstanbulFileCoverage,
  IstanbulFunction,
  IstanbulStatement,
} from './types.js';

/**
 * Each e2e suite writes its own V8 dump into the shared spool directory:
 * `coverage-views-core.json`, `coverage-workspaces.json`, and so on. The bare
 * `coverage.json` is the legacy single-suite name, still accepted.
 */
const SHARD_FILE = /^coverage(-[\w-]+)?\.json$/;

/** True when `fileName` is one of the collector's V8 coverage shards. */
export function isCoverageShardFile(fileName: string): boolean {
  return SHARD_FILE.test(fileName);
}

/**
 * True for the renderer bundle, the only script whose coverage we keep.
 * Vite emits it as `assets/index-<hash>.js`; everything else V8 reports
 * (preload, Electron internals, node modules) is noise.
 */
export function isRendererBundleUrl(url: string): boolean {
  return url.includes('/assets/index-') && url.endsWith('.js');
}

/**
 * True for a repo-relative path that is our own source. The source map points
 * at both workspace files and bundled dependencies; only the former belong in
 * the report Sonar reads.
 */
export function isProjectSourcePath(relativePath: string): boolean {
  return relativePath.startsWith('packages/') && !relativePath.includes('node_modules');
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/** Reads `<node>.start.line` out of an istanbul location node. */
export function startLineOf(node: unknown): number | null {
  if (!isStringRecord(node)) return null;
  const start = node['start'];
  if (!isStringRecord(start)) return null;
  const line = start['line'];
  return typeof line === 'number' ? line : null;
}

/** Reads `<node>.end.line` out of an istanbul location node. */
function endLineOf(node: unknown): number | null {
  if (!isStringRecord(node)) return null;
  const end = node['end'];
  if (!isStringRecord(end)) return null;
  const line = end['line'];
  return typeof line === 'number' ? line : null;
}

/**
 * A count absent from an otherwise-present map means "never executed", which is
 * what istanbul intends and what the pre-extraction collector's `?? 0` did. A
 * missing map entirely is a different thing — see `parseIstanbulFileCoverage`.
 */
function countAt(counts: Readonly<Record<string, unknown>>, id: string): number {
  const raw = counts[id];
  return typeof raw === 'number' ? raw : 0;
}

/**
 * Narrows one file entry of an istanbul coverage map — from
 * `v8ToIstanbul().toIstanbul()` or ast-v8-to-istanbul — to the fields lcov
 * needs.
 *
 * The library is untyped at this boundary (`CoverageMapData` is a union of a
 * class instance and a plain record), so the conversion is done here — under
 * the type checker — instead of with a cast in the collector script.
 *
 * Returns `null` when the entry does not carry all six maps that define a file.
 * Requiring the count maps (`s`/`f`/`b`) — not just the location maps — is
 * deliberate: the pre-extraction collector indexed them unguarded, so an entry
 * missing one crashed the collector and failed the CI step. Defaulting them to
 * empty instead would grade every line "never executed" and hand the audit a
 * full-looking report with `hitShare` 0, which it grades `ok` — coverage
 * silently collapsing to zero with a green job. A caller that gets `null` must
 * treat it as a hard failure, not skip the file (see `addBundleEntry`).
 */
export function parseIstanbulFileCoverage(value: unknown): IstanbulFileCoverage | null {
  if (!isStringRecord(value)) return null;

  const statementMap = value['statementMap'];
  const fnMap = value['fnMap'];
  const branchMap = value['branchMap'];
  const statementCounts = value['s'];
  const functionCounts = value['f'];
  const branchCounts = value['b'];
  if (!isStringRecord(statementMap) || !isStringRecord(fnMap) || !isStringRecord(branchMap)) {
    return null;
  }
  if (!isStringRecord(statementCounts) || !isStringRecord(functionCounts)) return null;
  if (!isStringRecord(branchCounts)) return null;

  return {
    statements: parseStatements(statementMap, statementCounts),
    functions: parseFunctions(fnMap, functionCounts),
    branches: parseBranches(branchMap, branchCounts),
  };
}

function parseStatements(
  statementMap: Readonly<Record<string, unknown>>,
  statementCounts: Readonly<Record<string, unknown>>,
): IstanbulStatement[] {
  const statements: IstanbulStatement[] = [];
  for (const [id, statement] of Object.entries(statementMap)) {
    const line = startLineOf(statement);
    if (line === null) continue;
    const endLine = endLineOf(statement);
    statements.push({ line, ...(endLine === null ? {} : { endLine }), count: countAt(statementCounts, id) });
  }
  return statements;
}

function parseFunctions(
  fnMap: Readonly<Record<string, unknown>>,
  functionCounts: Readonly<Record<string, unknown>>,
): IstanbulFunction[] {
  const functions: IstanbulFunction[] = [];
  for (const [id, fn] of Object.entries(fnMap)) {
    if (!isStringRecord(fn)) continue;
    // `decl` is where istanbul's lcov writer, and so the unit report, puts the
    // FN record: ast-v8-to-istanbul's `loc` is the function's body.
    const line = startLineOf(fn['decl']) ?? startLineOf(fn['loc']);
    if (line === null) continue;
    // Unnamed functions are keyed by line, not by istanbul's id: the id is
    // positional and shifts between shards, which is exactly what the merge
    // key is chosen to avoid. Unreachable through either converter —
    // v8-to-istanbul builds an fnMap entry only when V8 gave the function a
    // name, ast-v8-to-istanbul names the rest `(anonymous_<n>)` — but the input
    // here is untrusted `unknown`, so the fallback has to be shard-stable too.
    const name = fn['name'];
    functions.push({
      name: typeof name === 'string' && name !== '' ? name : `anon_${String(line)}`,
      line,
      count: countAt(functionCounts, id),
    });
  }
  return functions;
}

// blockId/branchId are the raw positions in `branchMap` and `locations`, held
// even across a skipped entry: renumbering off the surviving entries would
// shift every later branch's dedup key out of line with the other shards'.
//
// Every location goes on the branch node's own start line, where istanbul's
// lcov writer (and so the unit report) puts it. That is also the only line an
// implicit `else` has: ast-v8-to-istanbul gives that location no position.
// v8-to-istanbul's branch node is its one location, so for it nothing moves.
function parseBranches(
  branchMap: Readonly<Record<string, unknown>>,
  branchCounts: Readonly<Record<string, unknown>>,
): IstanbulBranch[] {
  const branches: IstanbulBranch[] = [];
  for (const [blockId, [id, branch]] of Object.entries(branchMap).entries()) {
    if (!isStringRecord(branch)) continue;
    const rawLocations = branch['locations'];
    if (!isUnknownArray(rawLocations)) continue;
    const branchLine = startLineOf(branch['loc']);
    const rawCounts = branchCounts[id];
    const counts = isUnknownArray(rawCounts) ? rawCounts : [];
    const locations: { branchId: number; line: number; count: number }[] = [];
    for (const [branchId, location] of rawLocations.entries()) {
      const line = branchLine ?? startLineOf(location);
      if (line === null) continue;
      const count = counts[branchId];
      locations.push({ branchId, line, count: typeof count === 'number' ? count : 0 });
    }
    branches.push({ blockId, locations });
  }
  return branches;
}

/** One file's line records under `restrictToExecutableLines`' line rules. */
function restrictLines(coverage: FileCoverage, lines: ExecutableLines): Map<number, number> {
  const kept = new Map<number, number>();
  const displaced: [number, number][] = [];
  for (const [line, count] of coverage.lines) {
    if (lines.statements.has(line) || (count > 0 && lines.branches.has(line))) kept.set(line, count);
    else if (count > 0) displaced.push([line, count]);
  }
  for (const [line, count] of displaced) {
    const target = lineVitestStarts(line, coverage, lines);
    if (target !== null) kept.set(target, Math.max(kept.get(target) ?? 0, count));
  }
  return kept;
}

/**
 * The first statement line within the span of the statement starting on
 * `line` that no record of the file starts on, or `null`.
 */
function lineVitestStarts(line: number, coverage: FileCoverage, lines: ExecutableLines): number | null {
  const end = coverage.statementEnds.get(line) ?? line;
  for (let target = line + 1; target <= end; target++) {
    if (lines.statements.has(target) && !coverage.lines.has(target)) return target;
  }
  return null;
}

/**
 * Restricts each file's records to what the unit report could list for it
 * (see `executableLines`), so that no line or branch can come out covered that
 * went in uncovered.
 *
 * - A statement line keeps its record whatever the count.
 * - A branch-only line — one the unit report lists only through a `BRDA` —
 *   keeps it only when the count is above 0. SonarJS scores a line with branch
 *   records as its `DA` hits plus its covered branches, but only when no `DA`
 *   was written first (the first value wins). Such a line stays "to cover"
 *   through its branch records either way; a positive `DA` adds e2e's
 *   execution evidence, while a zero one would only block the branch credit.
 * - Any other line with a count above 0 is a statement the bundle starts on
 *   another line than vitest does — an unmapped token takes the previous
 *   token's line, so `.map(x => (` can start its body a line early. Its count
 *   moves to the first statement line within its own span that no record of
 *   the file starts on: the line vitest starts the same statement on.
 * - Every other line is dropped.
 * - A branch keeps its records only on a line the unit report lists a `BRDA`
 *   for. Elsewhere it is code the bundler injected (vite's dynamic-import
 *   preload wrapper) or a branch an unmapped token put on the wrong line —
 *   records no unit-side branch could ever match.
 *
 * A file the unit report lists nothing for — type-only, or excluded with a
 * `v8 ignore file` hint — is dropped. A file absent from `executable` passes
 * through unchanged. Functions are never dropped.
 */
export function restrictToExecutableLines(
  report: CoverageReport,
  executable: ReadonlyMap<string, ExecutableLines>,
): CoverageReport {
  const restricted = createCoverageReport();
  for (const [filePath, coverage] of report) {
    const lines = executable.get(filePath);
    if (lines === undefined) {
      restricted.set(filePath, coverage);
      continue;
    }
    if (lines.statements.size === 0 && lines.branches.size === 0) continue;
    restricted.set(filePath, {
      lines: restrictLines(coverage, lines),
      functions: coverage.functions,
      branches: coverage.branches.filter(branch => lines.branches.has(branch.line)),
      statementEnds: coverage.statementEnds,
    });
  }
  return restricted;
}

/**
 * Gives every statement line of `executable` that a file of `report` has no
 * record for a count of 0 — source the renderer bundle has no code for, such
 * as an export nothing imports. Zero rather than absent: Sonar adds the e2e
 * count to the unit report's, so a line the unit tests run stays covered,
 * while dead code in a file only e2e reaches still counts against it.
 *
 * Only adds zeros, so no line can come out covered that went in uncovered. A
 * file absent from `executable` passes through unchanged, and branch-only
 * lines are left alone: a `DA` of 0 there would only block their branch
 * credit (see `restrictToExecutableLines`).
 */
export function padStatementLines(
  report: CoverageReport,
  executable: ReadonlyMap<string, ExecutableLines>,
): CoverageReport {
  const padded = createCoverageReport();
  for (const [filePath, coverage] of report) {
    const statements = executable.get(filePath)?.statements;
    if (statements === undefined) {
      padded.set(filePath, coverage);
      continue;
    }
    const lines = new Map(coverage.lines);
    for (const line of statements) if (!lines.has(line)) lines.set(line, 0);
    padded.set(filePath, { ...coverage, lines });
  }
  return padded;
}

/** An empty report, ready to merge shards into. */
export function createCoverageReport(): CoverageReport {
  return new Map();
}

/**
 * Folds one file's istanbul data into `report`, merging with whatever earlier
 * shards contributed for the same path. Every dimension merges by max: a line
 * or function is covered if *any* suite exercised it.
 */
export function mergeIstanbulFile(
  report: CoverageReport,
  filePath: string,
  data: IstanbulFileCoverage,
): void {
  let existing = report.get(filePath);
  if (existing === undefined) {
    existing = { lines: new Map(), functions: new Map(), branches: [], statementEnds: new Map() };
    report.set(filePath, existing);
  }

  for (const statement of data.statements) {
    const previous = existing.lines.get(statement.line) ?? 0;
    existing.lines.set(statement.line, Math.max(previous, statement.count));
    const end = Math.max(statement.endLine ?? statement.line, existing.statementEnds.get(statement.line) ?? 0);
    existing.statementEnds.set(statement.line, end);
  }

  // Keyed by name+line rather than by istanbul's id: ids are positional and
  // shift between shards, names and declaration lines do not.
  for (const fn of data.functions) {
    const key = `${fn.name}:${String(fn.line)}`;
    const previous = existing.functions.get(key);
    if (previous === undefined || fn.count > previous.count) {
      existing.functions.set(key, { name: fn.name, line: fn.line, count: fn.count });
    }
  }

  // Branches are keyed by their istanbul position. In the published report
  // that comes from ast-v8-to-istanbul, which numbers branches by walking the
  // bundle's AST, so every shard built from one commit gives a source branch
  // the same key and CI's textual merge of the shard lcovs dedupes it. (The
  // raw v8-to-istanbul report the audit grades numbers only the ranges V8
  // reported, so its keys shift between shards — it is never published.)
  for (const branch of data.branches) {
    for (const location of branch.locations) {
      existing.branches.push({
        line: location.line,
        blockId: branch.blockId,
        branchId: location.branchId,
        count: location.count,
      });
    }
  }
}
