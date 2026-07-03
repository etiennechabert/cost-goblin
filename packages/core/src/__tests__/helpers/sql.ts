/** Test-only: inline params in place of $n prepared-statement placeholders so
 *  integration tests can run builder output through a plain conn.run().
 *  Production code uses real prepared statements via the worker.
 *
 *  Implemented as a single regex pass with a function replacement — values are
 *  never re-scanned (a `$1` inside a substituted value stays literal), no
 *  GetSubstitution patterns (`$&`, `$$`, `$'`) are expanded, and single quotes
 *  in string values are doubled so the inlined literal stays balanced. */
export function substituteParams(sql: string, params: readonly unknown[]): string {
  return sql.replace(/\$(\d+)/g, (match, digits: string) => {
    const param = params[Number(digits) - 1];
    if (typeof param === 'string') return `'${param.replaceAll("'", "''")}'`;
    if (typeof param === 'number' || typeof param === 'bigint' || typeof param === 'boolean') return String(param);
    // Out-of-range or non-scalar: keep the placeholder so the query fails loudly.
    return match;
  });
}
