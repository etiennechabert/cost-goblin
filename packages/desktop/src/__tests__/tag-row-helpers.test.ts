import { describe, expect, it } from 'vitest';
import { tagSqlColumn, tagSqlColumnsById } from '@costgoblin/core';
import { tagSelectItems, tagValuesById } from '../main/handlers/query-utils.js';

const columns = tagSqlColumnsById([{ tagName: 'STAGE' }, { tagName: 'stage' }]);
const UPPER = tagSqlColumn({ tagName: 'STAGE' });
const LOWER = tagSqlColumn({ tagName: 'stage' });

describe('tagSelectItems', () => {
  it('selects every tag column, blank when NULL', () => {
    expect(tagSelectItems(columns)).toEqual([
      `COALESCE(${UPPER}, '') AS ${UPPER}`,
      `COALESCE(${LOWER}, '') AS ${LOWER}`,
    ]);
    expect(tagSelectItems(new Map())).toEqual([]);
  });
});

describe('tagValuesById', () => {
  it('reads each tag from its own column back under its id', () => {
    expect(tagValuesById({ [UPPER]: 'PROD', [LOWER]: 'dev' }, columns)).toEqual({ tag_STAGE: 'PROD', tag_stage: 'dev' });
  });

  it('reads a missing or non-string value as blank', () => {
    expect(tagValuesById({ [UPPER]: null, [LOWER]: 42 }, columns)).toEqual({ tag_STAGE: '', tag_stage: '' });
  });
});
