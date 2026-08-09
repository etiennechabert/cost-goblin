import { isStringRecord } from '../utils/json.js';
import type {
  CoverageReport,
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
function startLineOf(node: unknown): number | null {
  if (!isStringRecord(node)) return null;
  const start = node['start'];
  if (!isStringRecord(start)) return null;
  const line = start['line'];
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
 * Narrows one entry of `v8ToIstanbul().toIstanbul()` to the fields lcov needs.
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
 * treat it as a hard failure, not skip the file (see `e2e/collect-coverage.ts`).
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

  const statements: IstanbulStatement[] = [];
  for (const [id, statement] of Object.entries(statementMap)) {
    const line = startLineOf(statement);
    if (line === null) continue;
    statements.push({ line, count: countAt(statementCounts, id) });
  }

  const functions: IstanbulFunction[] = [];
  for (const [id, fn] of Object.entries(fnMap)) {
    if (!isStringRecord(fn)) continue;
    const line = startLineOf(fn['loc']);
    if (line === null) continue;
    const name = fn['name'];
    functions.push({
      name: typeof name === 'string' && name !== '' ? name : `anon_${id}`,
      line,
      count: countAt(functionCounts, id),
    });
  }

  // blockId/branchId are the raw positions in `branchMap` and `locations`, held
  // even across a skipped entry: renumbering off the surviving entries would
  // shift every later branch's dedup key out of line with the other shards'.
  const branches: IstanbulBranch[] = [];
  for (const [blockId, [id, branch]] of Object.entries(branchMap).entries()) {
    if (!isStringRecord(branch)) continue;
    const rawLocations = branch['locations'];
    if (!isUnknownArray(rawLocations)) continue;
    const rawCounts = branchCounts[id];
    const counts = isUnknownArray(rawCounts) ? rawCounts : [];
    const locations: { branchId: number; line: number; count: number }[] = [];
    for (const [branchId, location] of rawLocations.entries()) {
      const line = startLineOf(location);
      if (line === null) continue;
      const count = counts[branchId];
      locations.push({ branchId, line, count: typeof count === 'number' ? count : 0 });
    }
    branches.push({ blockId, locations });
  }

  return { statements, functions, branches };
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
    existing = { lines: new Map(), functions: new Map(), branches: [] };
    report.set(filePath, existing);
  }

  for (const statement of data.statements) {
    const previous = existing.lines.get(statement.line) ?? 0;
    existing.lines.set(statement.line, Math.max(previous, statement.count));
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

  // Branches are keyed by their istanbul position, which dedupes the repeats
  // within one collector run but is NOT a stable branch identity across shards:
  // v8-to-istanbul builds `branchMap` only from ranges V8 reported, and V8
  // reports block coverage only for functions that actually ran, so a shard
  // that entered fewer functions numbers the survivors differently. CI merges
  // the shard lcovs textually, so the same source branch can appear under two
  // BRDA keys and inflate that file's branch denominator. Line and function
  // coverage — what Sonar's headline number is built from — are unaffected;
  // fixing it properly means keying on the source location, which changes the
  // emitted lcov and belongs in its own change.
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
