import { describe, it, expect } from 'vitest';
import { QueryBuilder } from '../query/parameterized.js';

describe('QueryBuilder', () => {
  it('numbers placeholders from $1 in the order values are added', () => {
    const qb = new QueryBuilder();
    expect(qb.addParam('a')).toBe('$1');
    expect(qb.addParam(2)).toBe('$2');
    expect(qb.build().params).toEqual(['a', 2]);
  });

  it('continues after seed params, so a query can extend a shared WHERE', () => {
    // Several Explorer queries reuse one WHERE (and its params) and add their
    // own trailing values (row filters, a LIMIT): numbering must carry on.
    const shared = new QueryBuilder();
    const where = `x = ${shared.addParam('a')}`;
    const seeded = new QueryBuilder(shared.build().params);
    const limit = seeded.addParam(10);
    expect(`${where} LIMIT ${limit}`).toBe('x = $1 LIMIT $2');
    expect(seeded.build().params).toEqual(['a', 10]);
    // The seed is copied: extending one query never leaks into the shared list.
    expect(shared.build().params).toEqual(['a']);
  });
});
