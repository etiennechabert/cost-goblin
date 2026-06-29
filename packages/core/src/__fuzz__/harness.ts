/**
 * Fuzz harness: builds a generated case into SQL via the real query builders,
 * then executes it against the synthetic fixture with a REAL prepared statement
 * — binding params exactly the way the DuckDB worker does in production. This is
 * the whole point: it exercises the interpolation-vs-parameterization boundary
 * (identifiers and dates are guarded by the allow-list / format asserts; every
 * other value is a bound param) and proves no hostile input escapes it.
 *
 * Each case is classified into one acceptable bucket (executed cleanly, or
 * rejected by the security layer / by DuckDB) or one failure bucket (a hang, or
 * a successful injection — an executed query whose columns left the known
 * schema for that query kind).
 */
import { DuckDBInstance } from '@duckdb/node-api';

import {
  buildCostQuery,
  buildDailyCostsQuery,
  buildEntityDetailQuery,
} from '../query/builder.js';
import type { QueryContextOptions } from '../query/builder.js';
import { SecurityError } from '../query/identifier-validator.js';
import type { ParameterizedQuery } from '../query/parameterized.js';

import { DIMENSIONS, SYNTHETIC_DIR, periodsOnDisk } from './fixture-config.js';
import type { FuzzCase } from './generate.js';

export type FuzzResult =
  | { readonly kind: 'executed'; readonly columns: readonly string[]; readonly rowCount: number }
  | { readonly kind: 'rejected-security'; readonly message: string }
  | { readonly kind: 'rejected-builder'; readonly message: string }
  | { readonly kind: 'rejected-duckdb'; readonly message: string }
  | { readonly kind: 'timeout' };

export interface FuzzOutcome {
  readonly case: FuzzCase;
  readonly result: FuzzResult;
  /** True when an executed query's columns escaped the known schema — a bug. */
  readonly injection: boolean;
}

const EXPECTED_COLUMNS: Readonly<Record<FuzzCase['kind'], ReadonlySet<string>>> = {
  cost: new Set(['entity', 'total_cost', 'service', 'service_cost']),
  daily: new Set(['date', 'group_name', 'cost']),
  entity: new Set(['usage_date', 'service', 'account_id', 'account_name', 'cost']),
};

const CASE_TIMEOUT_MS = 8_000;

function tierFor(c: FuzzCase): 'daily' | 'hourly' {
  return c.params.granularity === 'hourly' ? 'hourly' : 'daily';
}

function optsFor(c: FuzzCase): QueryContextOptions {
  return { dataDir: SYNTHETIC_DIR, dimensions: DIMENSIONS, availablePeriods: periodsOnDisk(tierFor(c)) };
}

function buildSqlFor(c: FuzzCase): ParameterizedQuery {
  switch (c.kind) {
    case 'cost': return buildCostQuery(c.params, optsFor(c));
    case 'daily': return buildDailyCostsQuery(c.params, optsFor(c));
    case 'entity': return buildEntityDetailQuery(c.params, optsFor(c));
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface Timed<T> {
  readonly value: T | undefined;
  readonly timedOut: boolean;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<Timed<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Timed<T>>(resolve => {
    timer = setTimeout(() => { resolve({ value: undefined, timedOut: true }); }, ms);
  });
  try {
    return await Promise.race([promise.then(value => ({ value, timedOut: false })), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class FuzzHarness {
  private constructor(
    private readonly instance: DuckDBInstance,
    private readonly conn: Awaited<ReturnType<DuckDBInstance['connect']>>,
  ) {}

  static async open(): Promise<FuzzHarness> {
    const instance = await DuckDBInstance.create();
    const conn = await instance.connect();
    return new FuzzHarness(instance, conn);
  }

  /** Build, execute, classify, and apply the injection oracle to one case. */
  async run(c: FuzzCase): Promise<FuzzOutcome> {
    let query: ParameterizedQuery;
    try {
      query = buildSqlFor(c);
    } catch (error) {
      const kind = error instanceof SecurityError ? 'rejected-security' : 'rejected-builder';
      return { case: c, result: { kind, message: messageOf(error) }, injection: false };
    }

    const timed = await withTimeout(this.execute(query), CASE_TIMEOUT_MS);
    if (timed.timedOut || timed.value === undefined) {
      return { case: c, result: { kind: 'timeout' }, injection: false };
    }
    return this.classifyExecution(c, timed.value);
  }

  private classifyExecution(c: FuzzCase, exec: ExecResult): FuzzOutcome {
    if (exec.kind === 'error') {
      return { case: c, result: { kind: 'rejected-duckdb', message: exec.message }, injection: false };
    }
    const expected = EXPECTED_COLUMNS[c.kind];
    const injection = !exec.columns.every(col => expected.has(col));
    return {
      case: c,
      result: { kind: 'executed', columns: exec.columns, rowCount: exec.rowCount },
      injection,
    };
  }

  private async execute(query: ParameterizedQuery): Promise<ExecResult> {
    let stmt: Awaited<ReturnType<typeof this.conn.prepare>>;
    try {
      stmt = await this.conn.prepare(query.sql);
    } catch (error) {
      return { kind: 'error', message: messageOf(error) };
    }
    try {
      bindParams(stmt, query.params);
      const result = await stmt.run();
      const columns: string[] = [];
      for (let i = 0; i < result.columnCount; i++) columns.push(result.columnName(i));
      let rowCount = 0;
      let chunk = await result.fetchChunk();
      while (chunk !== null && chunk.rowCount > 0) {
        rowCount += chunk.rowCount;
        chunk = await result.fetchChunk();
      }
      return { kind: 'rows', columns, rowCount };
    } catch (error) {
      return { kind: 'error', message: messageOf(error) };
    } finally {
      stmt.destroySync();
    }
  }

  close(): void {
    this.conn.disconnectSync();
    this.instance.closeSync();
  }
}

type ExecResult =
  | { readonly kind: 'rows'; readonly columns: readonly string[]; readonly rowCount: number }
  | { readonly kind: 'error'; readonly message: string };

/** Bind values exactly as the DuckDB worker's bindParams does in production. */
function bindParams(stmt: PreparedLike, params: readonly unknown[]): void {
  for (let i = 0; i < params.length; i++) {
    const val = params[i];
    const idx = i + 1;
    if (val === null || val === undefined) {
      stmt.bindNull(idx);
    } else if (typeof val === 'string') {
      stmt.bindVarchar(idx, val);
    } else if (typeof val === 'number') {
      if (Number.isInteger(val)) stmt.bindInteger(idx, val);
      else stmt.bindDouble(idx, val);
    } else if (typeof val === 'boolean') {
      stmt.bindBoolean(idx, val);
    } else if (typeof val === 'bigint') {
      stmt.bindInteger(idx, Number(val));
    } else {
      stmt.bindVarchar(idx, JSON.stringify(val));
    }
  }
}

interface PreparedLike {
  bindNull(i: number): void;
  bindVarchar(i: number, v: string): void;
  bindInteger(i: number, v: number): void;
  bindDouble(i: number, v: number): void;
  bindBoolean(i: number, v: boolean): void;
}
