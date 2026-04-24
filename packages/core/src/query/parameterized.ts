/**
 * Parameterized SQL query infrastructure for safe DuckDB queries.
 *
 * Separates SQL structure (with $1, $2, ... placeholders) from user-controlled
 * values to prevent SQL injection and enable DuckDB query plan caching.
 */

/** A SQL query with parameterized placeholders and their corresponding values. */
export interface ParameterizedQuery {
  /** SQL string with $1, $2, ... placeholders for parameters */
  readonly sql: string;
  /** Parameter values in order, corresponding to $1, $2, ... in the SQL */
  readonly params: readonly unknown[];
}

/** Collects parameterized values and generates numbered placeholders ($1, $2, ...). */
export class QueryBuilder {
  private readonly parameters: unknown[] = [];

  /** Register a value and return its placeholder string (e.g. "$1"). */
  addParam(value: unknown): string {
    this.parameters.push(value);
    return `$${String(this.parameters.length)}`;
  }

  /** Return a frozen copy of the collected parameters. */
  build(): ParameterizedQuery {
    return {
      sql: '',
      params: Object.freeze([...this.parameters]),
    };
  }
}
