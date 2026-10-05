/** Result-cache / in-flight dedup key of a prepared query. A plain
 *  JSON.stringify(params) throws on a bigint, which bindParams binds
 *  (BIGINT/HUGEINT), so a bigint is written as its `123n` literal: never valid
 *  JSON, so it can't collide with a string or number param. Every other param
 *  list keys exactly as JSON.stringify(params) did. */
export function preparedQueryKey(sql: string, params: readonly unknown[]): string {
  const parts = params.map(p => (typeof p === 'bigint' ? `${p.toString()}n` : JSON.stringify(p ?? null)));
  return `${sql}\0[${parts.join(',')}]`;
}
