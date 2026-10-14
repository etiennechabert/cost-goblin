import { describe, expect, it } from 'vitest';
import { tagSqlColumn, tagSqlColumnsById } from '@costgoblin/core';
import type { DimensionsConfig } from '@costgoblin/core';
import { explorerSqlColumn } from '../main/handlers/explorer-columns.js';

const dims: DimensionsConfig = {
  builtIn: [],
  tags: [
    { tagName: 'STAGE', label: 'STAGE' },
    { tagName: 'stage', label: 'stage' },
  ],
};

describe('explorerSqlColumn', () => {
  const columns = tagSqlColumnsById(dims.tags);

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
