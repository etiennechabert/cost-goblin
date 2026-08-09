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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/** Reads `<node>.start.line` out of an istanbul location node. */
function startLineOf(node: unknown): number | null {
  if (!isRecord(node)) return null;
  const start = node['start'];
  if (!isRecord(start)) return null;
  const line = start['line'];
  return typeof line === 'number' ? line : null;
}

function countsOf(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** A missing or non-numeric count means "never executed", as istanbul intends. */
function countAt(counts: Record<string, unknown>, id: string): number {
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
 * Returns `null` when the entry does not carry the three maps that define a
 * file, so a malformed entry is skipped rather than silently counted as an
 * uncovered — or worse, fully covered — file.
 */
export function parseIstanbulFileCoverage(value: unknown): IstanbulFileCoverage | null {
  if (!isRecord(value)) return null;

  const statementMap = value['statementMap'];
  const fnMap = value['fnMap'];
  const branchMap = value['branchMap'];
  if (!isRecord(statementMap) || !isRecord(fnMap) || !isRecord(branchMap)) return null;

  const statementCounts = countsOf(value['s']);
  const functionCounts = countsOf(value['f']);
  const branchCounts = countsOf(value['b']);

  const statements: IstanbulStatement[] = [];
  for (const [id, statement] of Object.entries(statementMap)) {
    const line = startLineOf(statement);
    if (line === null) continue;
    statements.push({ line, count: countAt(statementCounts, id) });
  }

  const functions: IstanbulFunction[] = [];
  for (const [id, fn] of Object.entries(fnMap)) {
    if (!isRecord(fn)) continue;
    const line = startLineOf(fn['loc']);
    if (line === null) continue;
    const name = fn['name'];
    functions.push({
      name: typeof name === 'string' && name !== '' ? name : `anon_${id}`,
      line,
      count: countAt(functionCounts, id),
    });
  }

  const branches: IstanbulBranch[] = [];
  for (const [id, branch] of Object.entries(branchMap)) {
    if (!isRecord(branch)) continue;
    const rawLocations = branch['locations'];
    if (!isUnknownArray(rawLocations)) continue;
    const rawCounts = branchCounts[id];
    const counts = isUnknownArray(rawCounts) ? rawCounts : [];
    const locations: { line: number; count: number }[] = [];
    for (const [index, location] of rawLocations.entries()) {
      const line = startLineOf(location);
      if (line === null) continue;
      const count = counts[index];
      locations.push({ line, count: typeof count === 'number' ? count : 0 });
    }
    branches.push({ locations });
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
      existing.functions.set(key, { line: fn.line, count: fn.count });
    }
  }

  // blockId restarts at 0 for every file of every shard, so the same branch
  // lands on the same line+block+branch key each time and dedupes by max when
  // the lcov record is written.
  for (const [blockId, branch] of data.branches.entries()) {
    for (const [branchId, location] of branch.locations.entries()) {
      existing.branches.push({ line: location.line, blockId, branchId, count: location.count });
    }
  }
}
