/** Escape a string for safe interpolation inside a single-quoted SQL literal.
 *  Use for config/user-derived literals that cannot go through a QueryBuilder
 *  parameter (e.g. handlers that build raw SQL strings).
 *
 *  Lives in its own dependency-free module so the DuckDB worker bundle (which
 *  imports `@costgoblin/core/browser`) can use it without pulling in the query
 *  builder's module graph. */
export function sqlEscapeString(value: string): string {
  return value.replaceAll("'", "''");
}

/** A complete single-quoted SQL string literal for `value`, quote-escaped.
 *  Use for literals that cannot be bound as parameters — file paths in
 *  `read_parquet`/`read_json` and `COPY ... TO` targets. A data dir under a
 *  profile path with an apostrophe (`C:\Users\o'brien`) must still parse. */
export function sqlStringLiteral(value: string): string {
  return `'${sqlEscapeString(value)}'`;
}
