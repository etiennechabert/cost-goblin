import { describe, it, expect } from 'vitest';
import {
  buildRunSqlStatement,
  MAX_CELL_CHARS,
  resolveRunSqlCap,
  truncateCell,
  validateRunSqlQuery,
} from '../tools/run-sql.js';

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

describe('buildRunSqlStatement', () => {
  const CTE = 'costs AS (SELECT 1 AS cost)';

  it('wraps the query in a subquery capped at cap + 1 rows', () => {
    const sql = buildRunSqlStatement(CTE, 'SELECT * FROM costs', 5);
    expect(sql.startsWith(`WITH ${CTE}\nSELECT * FROM (\n`)).toBe(true);
    expect(sql.endsWith('\n) AS _costgoblin_q\nLIMIT 6')).toBe(true);
  });

  it('keeps the cap even when the query ends in its own LIMIT', () => {
    expect(buildRunSqlStatement(CTE, 'SELECT * FROM costs LIMIT 100000', 5))
      .toMatch(/\n\) AS _costgoblin_q\nLIMIT 6$/);
  });

  it('ends a trailing line comment before the closing parenthesis', () => {
    const sql = buildRunSqlStatement(CTE, 'SELECT * FROM costs -- LIMIT 1', 100);
    expect(sql).toContain('SELECT * FROM costs -- LIMIT 1\n) AS _costgoblin_q\nLIMIT 101');
    expect(sql.endsWith('\n) AS _costgoblin_q\nLIMIT 101')).toBe(true);
  });

  it('strips one trailing semicolon and the whitespace around it', () => {
    const sql = buildRunSqlStatement(CTE, 'SELECT 1 FROM costs ;  \n', 3);
    expect(sql).toContain('\nSELECT 1 FROM costs\n) AS _costgoblin_q\nLIMIT 4');
    expect(sql).not.toContain(';');
  });

  it.each([0, -1, Number.NaN, 2.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects a cap of %s',
    (cap) => {
      expect(() => buildRunSqlStatement(CTE, 'SELECT 1', cap)).toThrow();
    },
  );
});

describe('resolveRunSqlCap', () => {
  it.each([
    [undefined, 100],
    [-1, 1],
    [0, 1],
    [2.5, 2],
    [250, 250],
    [500, 500],
    [10_000, 500],
  ])('%s -> %s', (limit, expected) => {
    expect(resolveRunSqlCap(limit)).toBe(expected);
  });
});

describe('truncateCell', () => {
  it('leaves strings within the budget untouched', () => {
    const s = 'x'.repeat(MAX_CELL_CHARS);
    expect(truncateCell(s)).toBe(s);
    expect(truncateCell('')).toBe('');
  });

  it('keeps the first 4096 chars and reports how many were dropped', () => {
    expect(MAX_CELL_CHARS).toBe(4096);
    const out = truncateCell('x'.repeat(5000));
    expect(out).toBe(`${'x'.repeat(4096)}…[+904 chars]`);
  });

  it('never splits a surrogate pair at the boundary', () => {
    // An astral char (2 UTF-16 units) straddling index 4096.
    const s = `${'a'.repeat(4095)}😀${'b'.repeat(100)}`;
    const out = truncateCell(s);
    const kept = out.slice(0, out.indexOf('…[+'));
    expect(kept).toBe('a'.repeat(4095));
    expect(out).toBe(`${'a'.repeat(4095)}…[+102 chars]`);
    // No lone high surrogate anywhere in the output.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
  });

  it('keeps a surrogate pair that ends exactly at the boundary', () => {
    const s = `${'a'.repeat(4094)}😀${'b'.repeat(10)}`;
    expect(truncateCell(s)).toBe(`${'a'.repeat(4094)}😀…[+10 chars]`);
  });
});
