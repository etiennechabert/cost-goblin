import { pathToFileURL } from 'node:url';
import astV8ToIstanbul from 'ast-v8-to-istanbul';
import { moduleRunnerTransform, parseAstAsync, transformWithEsbuild } from 'vite';
import { isStringRecord } from '../utils/json.js';
import { padStatementLines, restrictToExecutableLines, startLineOf } from './collect.js';
import type { CoverageReport, ExecutableLines } from './types.js';

type IgnoreNode = NonNullable<Parameters<typeof astV8ToIstanbul>[0]['ignoreNode']>;

/** `node[key]`, for walking AST nodes the converter's bundled typings leave unresolved. */
function field(node: unknown, key: string): unknown {
  return isStringRecord(node) ? node[key] : undefined;
}

function isIdentifierNamed(node: unknown, test: (name: string) => boolean): boolean {
  const name = field(node, 'name');
  return field(node, 'type') === 'Identifier' && typeof name === 'string' && test(name);
}

/**
 * The statement filters of vitest's `V8CoverageProvider.remapCoverage`: the
 * declarations and assignments vite's module-runner transform injects for
 * imports, exports and `import.meta`, none of which is a statement of the
 * source. Its branch and in-source-test filters are left out — they match
 * nothing in this repository's renderer sources.
 */
const ignoreModuleRunnerNodes: IgnoreNode = (node, type) => {
  if (type !== 'statement') return false;
  const kind = field(node, 'type');
  if (kind === 'VariableDeclarator') {
    return isIdentifierNamed(
      field(node, 'id'),
      name => name.startsWith('__vite_ssr_import_') || name === '__vite_ssr_export_default__',
    );
  }
  if (kind !== 'ExpressionStatement') return false;
  const expression = field(node, 'expression');
  if (field(expression, 'type') !== 'AssignmentExpression') return false;
  const target = field(expression, 'left');
  return (
    field(target, 'type') === 'MemberExpression' &&
    isIdentifierNamed(
      field(target, 'object'),
      name => name === '__vite_ssr_exports__' || name === '__vite_ssr_import_meta__',
    )
  );
};

/** Start lines of the location nodes in an istanbul `statementMap`/`branchMap`. */
function startLines(locations: Iterable<unknown>, into: Set<number>): void {
  for (const location of locations) {
    const line = startLineOf(location);
    if (line !== null) into.add(line);
  }
}

/**
 * The lines of `source` the UNIT coverage report can list: statement start
 * lines (its `DA` records) and branch start lines (its `BRDA` records).
 *
 * Sonar merges the unit and e2e lcov files and counts a line listed by either.
 * The unit report comes from @vitest/coverage-v8, which remaps through the AST
 * and lists only these lines. The e2e report goes through the same converter,
 * but over the renderer bundle's AST, which rollup has rewritten: imports
 * inlined, exports dropped, unused code removed. So a few of its statements
 * start on other lines, and some lines have none.
 *
 * Computed the way vitest does it: vite's esbuild transform (loader and JSX
 * mode inferred from the path and its nearest tsconfig), vite's module-runner
 * transform, vite's parser, and the same converter with vitest's node filters,
 * fed no V8 functions — so only its locations mean anything. `sourcesContent`
 * is passed because the converter reads `v8 ignore` hints from it.
 *
 * Throws when the source does not transform or parse.
 */
export async function executableLines(source: string, filePath: string): Promise<ExecutableLines> {
  const transformed = await transformWithEsbuild(source, filePath);
  // Vitest runs every module through vite's module-runner transform, and the
  // start line of an expression that calls an imported binding moves with it:
  // `(0,__vite_ssr_import_0__.fn)(…)` maps its unmapped `(0,` to the previous
  // token's line.
  const runner = await moduleRunnerTransform(transformed.code, transformed.map, filePath, source);
  if (runner === null) throw new Error(`vite's module-runner transform returned nothing for ${filePath}`);
  const url = pathToFileURL(filePath).href;
  const coverageMap: unknown = await astV8ToIstanbul({
    code: runner.code,
    sourceMap: {
      version: 3,
      // One original source, so the combined map's path spelling is irrelevant.
      sources: [url],
      sourcesContent: [source],
      names: runner.map !== null && 'names' in runner.map ? runner.map.names : [],
      mappings: runner.map?.mappings ?? '',
    },
    ast: parseAstAsync(runner.code),
    coverage: { functions: [], url },
    ignoreNode: ignoreModuleRunnerNodes,
  });

  const statements = new Set<number>();
  const branches = new Set<number>();
  if (!isStringRecord(coverageMap)) return { statements, branches };
  for (const file of Object.values(coverageMap)) {
    if (!isStringRecord(file)) continue;
    const { statementMap, branchMap } = file;
    if (isStringRecord(statementMap)) startLines(Object.values(statementMap), statements);
    if (isStringRecord(branchMap)) {
      // istanbul's lcov writes every location of a branch on the branch
      // node's own start line, not on each location's.
      startLines(
        Object.values(branchMap).map(branch => (isStringRecord(branch) ? branch['loc'] : null)),
        branches,
      );
    }
  }
  return { statements, branches };
}

/** The e2e report as Sonar should read it, and the files it could not align. */
export interface StatementLineReport {
  readonly report: CoverageReport;
  /** `<path> (<reason>)` for each file whose statement lines could not be computed. */
  readonly unrestricted: readonly string[];
}

/**
 * Aligns every file of `report` with the lines the unit report lists for it
 * (`executableLines`, reading each source through `readSource`): restricted to
 * them (`restrictToExecutableLines`), then padded with a 0 for each statement
 * line it has no record for (`padStatementLines`). The bundle's AST starts a
 * few statements on other lines than vitest's transform does, and has none for
 * code it tree-shook.
 *
 * A file whose source cannot be read, transformed or parsed is kept as the
 * converter reported it and named in `unrestricted` for the caller to warn
 * about. Its records are the bundle's statements and branches, so it can be
 * off in either direction against the unit report — a statement the bundle
 * starts a line early adds a line, code it tree-shook is absent rather than 0
 * — but by a few lines, in a file the caller has already warned about: a
 * warning, not a failure; and the unit tests of this module break first if
 * vite or the converter change under it.
 */
export async function restrictToStatementLines(
  report: CoverageReport,
  readSource: (filePath: string) => string,
): Promise<StatementLineReport> {
  const executable = new Map<string, ExecutableLines>();
  const unrestricted: string[] = [];
  for (const filePath of report.keys()) {
    try {
      executable.set(filePath, await executableLines(readSource(filePath), filePath));
    } catch (error) {
      // First line only: esbuild's messages span several, and the caller puts
      // the list into a single-line `::warning::` workflow command.
      const [reason] = (error instanceof Error ? error.message : String(error)).split('\n');
      unrestricted.push(`${filePath} (${reason ?? ''})`);
    }
  }
  return { report: padStatementLines(restrictToExecutableLines(report, executable), executable), unrestricted };
}
