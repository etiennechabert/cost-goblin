import { describe, it, expect } from 'vitest';
import { validateRunSqlQuery } from '../tools/run-sql.js';

describe('validateRunSqlQuery', () => {
  it('allows a plain SELECT against costs', () => {
    expect(validateRunSqlQuery('SELECT service, SUM(cost) FROM costs GROUP BY service')).toBeNull();
  });

  it('allows a WITH query', () => {
    expect(validateRunSqlQuery('WITH t AS (SELECT * FROM costs) SELECT * FROM t')).toBeNull();
  });

  it('rejects non-SELECT statements', () => {
    expect(validateRunSqlQuery('DROP TABLE costs')).toMatch(/SELECT\/WITH/i);
    expect(validateRunSqlQuery('COPY costs TO \'/tmp/x.csv\'')).toMatch(/SELECT\/WITH/i);
  });

  it('blocks file-reading table functions', () => {
    expect(validateRunSqlQuery("SELECT * FROM read_text('/etc/passwd')")).toMatch(/read_text/);
    expect(validateRunSqlQuery("SELECT * FROM read_csv('http://evil/x')")).toMatch(/read_csv/);
    expect(validateRunSqlQuery("SELECT * FROM read_parquet('/x/*.parquet')")).toMatch(/read_parquet/);
    expect(validateRunSqlQuery("SELECT * FROM glob('/etc/*')")).toMatch(/glob/);
    expect(validateRunSqlQuery("SELECT read_blob('/etc/passwd')")).toMatch(/read_blob/);
  });

  it('blocks the query()/query_table() SQL evaluators', () => {
    expect(validateRunSqlQuery("SELECT * FROM query('SELECT 1')")).toMatch(/query/);
    expect(validateRunSqlQuery("SELECT * FROM query_table('costs')")).toMatch(/query_table/);
  });

  it('blocks FROM/JOIN on a string-literal path (replacement scan)', () => {
    expect(validateRunSqlQuery("SELECT * FROM '/etc/passwd'")).toMatch(/file path/i);
    expect(validateRunSqlQuery("SELECT * FROM costs JOIN '/x.csv' USING (k)")).toMatch(/file path/i);
  });

  it('blocks statement stacking', () => {
    expect(validateRunSqlQuery("SELECT 1; COPY costs TO '/tmp/x'")).toMatch(/single SQL statement/i);
    // A trailing semicolon is fine.
    expect(validateRunSqlQuery('SELECT 1 FROM costs;')).toBeNull();
  });

  it('is not fooled by blocked names inside string literals', () => {
    // read_text appears only inside a string literal here — it is data, not a call.
    expect(validateRunSqlQuery("SELECT 'read_text(x)' AS note FROM costs")).toBeNull();
  });

  it('is not fooled by a comment-introducing sequence inside a string', () => {
    // The '--' is inside a string; the real ';' must still be detected as stacking.
    expect(
      validateRunSqlQuery("SELECT '--' AS c FROM costs; SELECT * FROM read_text('y')"),
    ).toMatch(/single SQL statement/i);
  });

  it('allows identifiers that merely contain a blocked name as a substring', () => {
    expect(validateRunSqlQuery('SELECT query_count, readonly_flag FROM costs')).toBeNull();
  });

  it('blocks the json_execute_serialized_sql evaluator by name', () => {
    expect(
      validateRunSqlQuery("SELECT * FROM json_execute_serialized_sql(json_serialize_sql('SELECT content FROM read_text(''/x'')'))"),
    ).toMatch(/json_execute_serialized_sql/);
  });

  // Known guard misses (#594, VULN-003). The guard is defence in depth only;
  // the sandboxed MCP DuckDB instance is what refuses these (see
  // duckdb-sandbox.integration.test.ts and the run_sql cases in
  // mcp-server.test.ts). Recorded so a future guard change is a visible,
  // deliberate diff rather than a silent assumption that they are blocked.
  describe('known misses — refused by the DuckDB sandbox, not by this guard', () => {
    it.each([
      ['a double-quoted alias containing a quote hides the call', `SELECT 1 AS "a'b", * FROM read_text('/home/u/.aws/credentials')`],
      ['a comma join onto a string path skips the FROM/JOIN check', "SELECT * FROM (SELECT 1 AS x) AS costs, '/home/u/.config/gcloud/application_default_credentials.json'"],
      ['a quoted function name dodges the name pattern', `SELECT * FROM "read_text"('/home/u/.aws/credentials')`],
      ['a quoted evaluator name dodges the name pattern', `SELECT * FROM "json_execute_serialized_sql"(json_serialize_sql('SELECT content FROM read_text(''/home/u/.aws/credentials'')'))`],
      ['a quote-desynced stacked COPY ending in its own LIMIT', `SELECT 1 AS "a'b"; COPY (SELECT 42) TO '/home/u/x.csv'; SELECT 1 LIMIT 1`],
      ['a quote-desynced stacked ATTACH', `SELECT 1 AS "a'b"; ATTACH '/home/u/x.db' AS x; SELECT 1 LIMIT 1`],
    ])('%s: passes the guard', (_label, sql) => {
      expect(validateRunSqlQuery(sql)).toBeNull();
    });
  });
});
