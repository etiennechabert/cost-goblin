/**
 * Pure logic behind `e2e/collect-coverage.ts`, which turns the e2e suites' V8
 * dumps into the lcov file SonarCloud reads.
 *
 * It lives here because `e2e/` is outside every gate: `vitest.config.ts` globs
 * only `packages/{core,desktop,mcp,ui}/src` and `scripts/`, all four tsconfigs
 * are `include: ["src"]`, and `eslint.config.js` is scoped to
 * `packages/*​/src`. So `npm run check` never type-checks, lints or tests the
 * collector, while the numbers it produces are the project's headline coverage
 * figure — a typo like `isBlockcoverage` would read as `undefined` with no
 * gate to catch it. Everything computable without touching the filesystem
 * therefore lives on this side of the boundary; the collector keeps only its
 * I/O and process handling.
 *
 * Deliberately not re-exported from `src/index.ts`: this is build tooling, not
 * part of the domain API. Import it by subpath, as `e2e/global-setup.ts`
 * already does with `__fixtures__/setup.js`.
 */

export {
  createCoverageReport,
  isCoverageShardFile,
  isProjectSourcePath,
  isRendererBundleUrl,
  mergeIstanbulFile,
  parseIstanbulFileCoverage,
} from './collect.js';

export { generateLcov } from './lcov.js';

export {
  auditCoverageReport,
  describeCoverageFailure,
  measureZeroFunctionFiles,
} from './audit.js';

export type {
  CoverageFailure,
  CoverageReport,
  CoverageVerdict,
  FileCoverage,
  IstanbulBranch,
  IstanbulFileCoverage,
  IstanbulFunction,
  IstanbulStatement,
  ZeroFunctionStats,
} from './types.js';
