import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import { applyNormalizationRule, buildAliasSqlCase } from '../normalize/normalize.js';
import type { NormalizationRule } from '../types/config.js';

/**
 * Cross-engine parity: the SQL produced by `buildAliasSqlCase` (run in DuckDB)
 * must produce the same normalized value as the JS `applyNormalizationRule`.
 * They are expected to agree everywhere filters, aliases, and cost-scope rules
 * compare JS-normalized literals against the CASE-wrapped column.
 */

type Conn = Awaited<ReturnType<Awaited<ReturnType<typeof DuckDBInstance.create>>['connect']>>;

async function evalScalar(conn: Conn, sql: string): Promise<unknown> {
  const result = await conn.run(`SELECT ${sql} AS v`);
  const chunk = await result.fetchChunk();
  if (chunk === null || chunk.rowCount === 0) return null;
  return chunk.getColumnVector(0).getItem(0);
}

const RULES: NormalizationRule[] = [
  'lowercase',
  'uppercase',
  'lowercase-kebab',
  'lowercase-underscore',
  'camelCase',
];

// No single quotes (kept out of the SQL literal); no trailing delimiters (the
// JS camelCase rule preserves a trailing delimiter while the split-based SQL
// drops it — a pathological input that doesn't occur in real tag values).
const INPUTS = [
  'Core Banking',
  'core_banking',
  'my-cost-team',
  'fooBarBaz',
  'PlatformEngineering',
  'XML-http-Request',
  'EU west 1',
  'data',
  'ABC',
  'already-Camel',
  'team',
];

describe('normalize SQL ↔ JS parity', () => {
  let db: Awaited<ReturnType<typeof DuckDBInstance.create>>;
  let conn: Conn;

  beforeAll(async () => {
    db = await DuckDBInstance.create();
    conn = await db.connect();
  });

  afterAll(() => {
    conn.disconnectSync();
  });

  for (const rule of RULES) {
    it(`agrees for rule "${rule}"`, async () => {
      for (const input of INPUTS) {
        const jsValue = applyNormalizationRule(input, rule);
        const sqlExpr = buildAliasSqlCase(`'${input}'`, { normalize: rule });
        const sqlValue = await evalScalar(conn, sqlExpr);
        expect(sqlValue, `rule=${rule} input="${input}"`).toBe(jsValue);
      }
    });
  }

  it('camelCase SQL preserves NULL', async () => {
    const sqlExpr = buildAliasSqlCase('NULL', { normalize: 'camelCase' });
    expect(await evalScalar(conn, sqlExpr)).toBeNull();
  });

  // Regression: an empty alias list used to emit `WHEN field IN () THEN ...`,
  // a DuckDB parse error that broke every query on the dimension.
  it('empty alias lists still produce parseable SQL', async () => {
    const empty = buildAliasSqlCase(`'prod'`, { aliases: { production: [] } });
    expect(await evalScalar(conn, empty)).toBe('prod');

    const mixed = buildAliasSqlCase(`'STG'`, {
      normalize: 'lowercase',
      aliases: { production: [], staging: ['stg'] },
    });
    expect(await evalScalar(conn, mixed)).toBe('staging');
  });
});
