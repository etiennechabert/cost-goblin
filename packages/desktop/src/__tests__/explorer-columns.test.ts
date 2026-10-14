import { describe, expect, it } from 'vitest';
import { tagSqlColumn } from '@costgoblin/core';
import type { DimensionsConfig } from '@costgoblin/core';
import { explorerSqlColumn } from '../main/handlers/explorer-columns.js';
import { tagSqlColumnsById } from '../main/handlers/query-utils.js';

const dims: DimensionsConfig = {
  builtIn: [],
  tags: [
    { tagName: 'STAGE', label: 'STAGE' },
    { tagName: 'stage', label: 'stage' },
    { tagName: 'cost-center', label: 'Cost center' },
    { tagName: 'cost_center', label: 'Cost center (dup id)' },
  ],
};

describe('tagSqlColumnsById', () => {
  it('maps each tag id to its own SQL column, even when ids differ only by case', () => {
    const columns = tagSqlColumnsById(dims);
    expect(columns.get('tag_STAGE')).toBe(tagSqlColumn({ tagName: 'STAGE' }));
    expect(columns.get('tag_stage')).toBe(tagSqlColumn({ tagName: 'stage' }));
  });

  it('keeps the first tag when two share an id', () => {
    expect(tagSqlColumnsById(dims).get('tag_cost_center')).toBe(tagSqlColumn({ tagName: 'cost-center' }));
  });
});

describe('explorerSqlColumn', () => {
  const columns = tagSqlColumnsById(dims);

  it('passes scalar columns through and maps tag ids to their SQL column', () => {
    expect(explorerSqlColumn('service', columns)).toBe('service');
    expect(explorerSqlColumn('usage_date', columns)).toBe('usage_date');
    expect(explorerSqlColumn('tag_stage', columns)).toBe(tagSqlColumn({ tagName: 'stage' }));
  });

  it('rejects ids outside the allow-list', () => {
    expect(explorerSqlColumn('tag_unknown', columns)).toBeNull();
    expect(explorerSqlColumn('service; DROP TABLE x', columns)).toBeNull();
    // An SQL column name is not an id: the renderer must not address it directly.
    expect(explorerSqlColumn(tagSqlColumn({ tagName: 'stage' }), columns)).toBeNull();
  });
});
