/**
 * Shapes exchanged by the e2e coverage pipeline. See `./index.ts` for why this
 * lives in `core` rather than next to the collector in `e2e/`.
 */

/** Merged coverage for one source file, accumulated across suite shards. */
export interface FileCoverage {
  /** Line number → highest execution count any shard reported for that line. */
  readonly lines: Map<number, number>;
  /**
   * `name:line` → the function's name, declaration line and highest count seen.
   * The name is carried in the value rather than recovered from the key: a V8
   * function name can itself contain a colon (an object literal with a quoted
   * key like `'view:reset'` names its function exactly that), which no amount
   * of splitting the key can undo.
   */
  readonly functions: Map<string, { name: string; line: number; count: number }>;
  /** One entry per branch location; deduplicated when lcov is generated. */
  readonly branches: { line: number; blockId: number; branchId: number; count: number }[];
}

/** Absolute source-file path → its merged coverage. */
export type CoverageReport = Map<string, FileCoverage>;

/**
 * One statement of a file, as v8-to-istanbul reports it: `statementMap[id]`
 * gives the line, `s[id]` the execution count.
 */
export interface IstanbulStatement {
  readonly line: number;
  readonly count: number;
}

/**
 * One function of a file. `name` is already resolved — an unnamed function
 * carries the `anon_<fnMap key>` fallback the lcov record needs.
 */
export interface IstanbulFunction {
  readonly name: string;
  readonly line: number;
  readonly count: number;
}

/**
 * One branch of a file, with its per-location counts zipped in.
 *
 * `blockId` and `branchId` are the raw positions the entry held in istanbul's
 * `branchMap` and `locations` — carried explicitly, not re-derived from array
 * position, so that skipping a malformed entry cannot renumber the ones after
 * it. They are what the lcov `BRDA` record and its dedup key are built from.
 */
export interface IstanbulBranch {
  readonly blockId: number;
  readonly locations: readonly {
    readonly branchId: number;
    readonly line: number;
    readonly count: number;
  }[];
}

/**
 * A v8-to-istanbul file entry narrowed to the fields lcov actually needs.
 * Produced by `parseIstanbulFileCoverage` from the library's untyped output.
 */
export interface IstanbulFileCoverage {
  readonly statements: readonly IstanbulStatement[];
  readonly functions: readonly IstanbulFunction[];
  readonly branches: readonly IstanbulBranch[];
}

/**
 * How much of a report is credited to files V8 reported no functions for —
 * the signature of a lost coverage-attach race. See `./audit.ts`.
 */
export interface ZeroFunctionStats {
  /** Files with no function records and more than a handful of lines. */
  readonly files: number;
  /** Share (0–1) of the report's covered lines credited to those files. */
  readonly hitShare: number;
}

/** A report that must not be published as a coverage measurement. */
export type CoverageFailure =
  | { readonly status: 'empty' }
  | {
      readonly status: 'fabricated';
      readonly sourceFiles: number;
      readonly zeroFunction: ZeroFunctionStats;
    };

/** The verdict on a merged report: publishable, or one of the failure modes. */
export type CoverageVerdict =
  | {
      readonly status: 'ok';
      readonly sourceFiles: number;
      readonly zeroFunction: ZeroFunctionStats;
    }
  | CoverageFailure;
