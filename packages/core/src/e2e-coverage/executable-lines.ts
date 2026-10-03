import { extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import astV8ToIstanbul from 'ast-v8-to-istanbul';
import { parseAstAsync, transformWithEsbuild } from 'vite';
import { isStringRecord } from '../utils/json.js';
import { parseIstanbulFileCoverage } from './collect.js';

const LOADERS: Readonly<Record<string, 'ts' | 'tsx' | 'js' | 'jsx'>> = {
  '.ts': 'ts',
  '.mts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.mjs': 'js',
  '.jsx': 'jsx',
};

/**
 * The lines of `source` that the UNIT coverage report treats as executable:
 * the start line of every statement, which is exactly the set of lines its lcov
 * gives a `DA` record.
 *
 * Why the e2e report needs this: Sonar merges the unit and e2e lcov files and
 * counts a line as "to cover" if EITHER report lists it. The unit report comes
 * from @vitest/coverage-v8, which remaps through the AST (ast-v8-to-istanbul)
 * and lists statement lines only. The e2e report comes from v8-to-istanbul,
 * which lists every source line — type annotations, JSX continuation lines,
 * closing braces. A line only the e2e report lists is judged by e2e alone, so a
 * component the unit tests run but no e2e suite renders had all of its
 * non-statement lines counted as uncovered (PR #650: setup-wizard.tsx at 51.6%
 * new coverage although its unit tests executed every statement concerned).
 *
 * The set is computed the way vitest computes it for a file no test loaded
 * (`V8CoverageProvider.getCoverageMapForUncoveredFiles`): the esbuild transform
 * vite applies (tsconfig-aware, via `transformWithEsbuild`), the same parser
 * (`parseAstAsync`) and the same converter, fed no V8 functions. Only the
 * statement LOCATIONS are kept, never the counts — with no functions those are
 * meaningless. Vitest's `ignoreNode` filter is not replicated: every node it
 * drops is an artefact of vitest's own SSR/browser module wrapper, which a plain
 * transform never produces.
 *
 * Returns `null` for a file type the transform does not handle. Throws when the
 * source does not transform or parse; the caller decides what an unusable file
 * means.
 */
export async function executableLines(
  source: string,
  filePath: string,
): Promise<ReadonlySet<number> | null> {
  const loader = LOADERS[extname(filePath)];
  if (loader === undefined) return null;

  const transformed = await transformWithEsbuild(source, filePath, {
    loader,
    jsx: 'automatic',
    sourcemap: true,
  });
  const url = pathToFileURL(filePath).href;
  const result: unknown = await astV8ToIstanbul({
    code: transformed.code,
    sourceMap: {
      version: 3,
      sources: [url],
      names: transformed.map.names,
      mappings: transformed.map.mappings,
    },
    ast: parseAstAsync(transformed.code),
    coverage: { functions: [], url },
    wrapperLength: 0,
  });

  const lines = new Set<number>();
  if (!isStringRecord(result)) {
    throw new Error(`ast-v8-to-istanbul returned no coverage map for ${filePath}`);
  }
  for (const entry of Object.values(result)) {
    const coverage = parseIstanbulFileCoverage(entry);
    if (coverage === null) {
      throw new Error(`ast-v8-to-istanbul returned an unrecognised entry for ${filePath}`);
    }
    for (const statement of coverage.statements) lines.add(statement.line);
  }
  return lines;
}
