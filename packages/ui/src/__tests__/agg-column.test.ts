import { describe, it, expect } from 'vitest';
import { dimToColumnKey, filtersEmptyGroup } from '../lib/agg-column.js';

describe('filtersEmptyGroup', () => {
  it('holds for a column that shows the field its dimension filters', () => {
    expect(filtersEmptyGroup('service')).toBe(true);
    expect(filtersEmptyGroup('region')).toBe(true);
    expect(filtersEmptyGroup('tag_team')).toBe(true);
  });

  it('fails for the account, whose column shows names while its filter matches ids', () => {
    expect(dimToColumnKey('account')).toBe('account_name');
    expect(filtersEmptyGroup('account')).toBe(false);
  });
});
