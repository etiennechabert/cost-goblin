import { describe, expect, it } from 'vitest';
import { isSafeColumnIdentifier } from '../query/identifier-validator.js';
import { describeTagSource, findTagIdCollisions, tagDimColumn, tagSqlColumn, tagSqlColumnsById } from '../types/branded.js';
import { OU_PATH_SOURCE_KEY } from '../types/config.js';

/** DuckDB matches identifiers case-insensitively, even when quoted, so two
 *  SQL columns are only distinct if they still differ once lowercased. */
function duckdbIdentity(tagName: string): string {
  return tagSqlColumn({ tagName }).toLowerCase();
}

describe('tagSqlColumn', () => {
  it('keeps tag keys that differ only by case apart', () => {
    expect(duckdbIdentity('STAGE')).not.toBe(duckdbIdentity('stage'));
    expect(duckdbIdentity('Stage')).not.toBe(duckdbIdentity('stage'));
    expect(duckdbIdentity('Stage')).not.toBe(duckdbIdentity('STAGE'));
  });

  it('keeps tag keys that differ only by punctuation apart', () => {
    const columns = ['cost-center', 'cost_center', 'cost center', 'cost.center', 'cost:center'].map(duckdbIdentity);
    expect(new Set(columns).size).toBe(columns.length);
  });

  it('is a lowercase, identifier-safe name that starts with the readable key', () => {
    for (const key of ['STAGE', 'aws:createdBy', "o'brien team", 'Équipe', '日本', 'x']) {
      const column = tagSqlColumn({ tagName: key });
      expect(isSafeColumnIdentifier(column)).toBe(true);
      expect(column).toBe(column.toLowerCase());
    }
    expect(tagSqlColumn({ tagName: 'STAGE' })).toMatch(/^tag_stage_[0-9a-f]{8}$/);
    expect(tagSqlColumn({ tagName: 'aws:createdBy' })).toMatch(/^tag_aws_createdby_[0-9a-f]{8}$/);
  });

  it('is deterministic', () => {
    expect(tagSqlColumn({ tagName: 'STAGE' })).toBe(tagSqlColumn({ tagName: 'STAGE' }));
  });

  it('derives account-only dimensions from the same source key as their id', () => {
    expect(tagSqlColumn({ accountTagFallback: OU_PATH_SOURCE_KEY })).toMatch(/^tag_ou_path_[0-9a-f]{8}$/);
    expect(tagSqlColumn({ accountTagFallback: 'CostCenter' })).toMatch(/^tag_costcenter_[0-9a-f]{8}$/);
    // A resource tag with a fallback is keyed by the resource tag, like its id.
    expect(tagSqlColumn({ tagName: 'team', accountTagFallback: 'Owner' })).toBe(tagSqlColumn({ tagName: 'team' }));
  });

  it('leaves the dimension id alone: views, baselines and preferences persist it', () => {
    expect(tagDimColumn({ tagName: 'STAGE' })).toBe('tag_STAGE');
    expect(tagDimColumn({ tagName: 'stage' })).toBe('tag_stage');
    expect(tagDimColumn({ tagName: 'cost-center' })).toBe('tag_cost_center');
  });
});

describe('tagSqlColumnsById', () => {
  const tags = [
    { tagName: 'STAGE' },
    { tagName: 'stage' },
    { tagName: 'cost-center' },
    { tagName: 'cost_center' },
  ];

  it('maps each tag id to its own SQL column, even when ids differ only by case', () => {
    const columns = tagSqlColumnsById(tags);
    expect(columns.get('tag_STAGE')).toBe(tagSqlColumn({ tagName: 'STAGE' }));
    expect(columns.get('tag_stage')).toBe(tagSqlColumn({ tagName: 'stage' }));
  });

  it('keeps the first tag when two share an id, as resolveField does', () => {
    expect(tagSqlColumnsById(tags).get('tag_cost_center')).toBe(tagSqlColumn({ tagName: 'cost-center' }));
  });
});

describe('findTagIdCollisions', () => {
  it('reports every later tag whose key differs from an earlier one only by punctuation', () => {
    const tags = [{ tagName: 'cost-center' }, { tagName: 'cost_center' }, { tagName: 'cost center' }, { tagName: 'cost.center' }];
    expect(findTagIdCollisions(tags)).toEqual([
      { id: 'tag_cost_center', ownerIndex: 0, index: 1 },
      { id: 'tag_cost_center', ownerIndex: 0, index: 2 },
      { id: 'tag_cost_center', ownerIndex: 0, index: 3 },
    ]);
  });

  it('reports a resource tag named ou_path against the OU Path dimension', () => {
    const tags = [{ accountTagFallback: OU_PATH_SOURCE_KEY }, { tagName: 'ou_path' }];
    expect(findTagIdCollisions(tags)).toEqual([{ id: 'tag_ou_path', ownerIndex: 0, index: 1 }]);
  });

  it('reports a resource tag against an account-only dimension with the same key', () => {
    const tags = [{ tagName: 'CostCenter' }, { accountTagFallback: 'CostCenter' }];
    expect(findTagIdCollisions(tags)).toEqual([{ id: 'tag_CostCenter', ownerIndex: 0, index: 1 }]);
  });

  it('reports the same key declared twice', () => {
    expect(findTagIdCollisions([{ tagName: 'team' }, { tagName: 'team' }])).toEqual([{ id: 'tag_team', ownerIndex: 0, index: 1 }]);
  });

  it('ignores ids that differ by case, and a fallback behind a resource tag', () => {
    expect(findTagIdCollisions([{ tagName: 'STAGE' }, { tagName: 'stage' }])).toEqual([]);
    // The first is keyed by its resource tag (tag_team), not its fallback.
    expect(findTagIdCollisions([{ tagName: 'team', accountTagFallback: 'Owner' }, { accountTagFallback: 'Owner' }])).toEqual([]);
  });
});

describe('describeTagSource', () => {
  it('names the key a dimension id derives from', () => {
    expect(describeTagSource({ tagName: 'cost-center' })).toBe('tag "cost-center"');
    expect(describeTagSource({ tagName: 'team', accountTagFallback: 'Owner' })).toBe('tag "team"');
    expect(describeTagSource({ accountTagFallback: 'CostCenter' })).toBe('account tag "CostCenter"');
    expect(describeTagSource({ accountTagFallback: OU_PATH_SOURCE_KEY })).toBe('OU Path');
  });
});
