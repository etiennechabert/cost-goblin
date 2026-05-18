import { describe, it, expect } from 'vitest';
import { applyOrgTreeRollup } from '../models/org-tree-rollup.js';
import type { CostResult, CostRow } from '../types/query.js';
import type { OrgNode } from '../types/config.js';
import { asDollars, asEntityRef, asDateString } from '../types/branded.js';

function row(entity: string, totalCost: number, services: Record<string, number>): CostRow {
  return {
    entity: asEntityRef(entity),
    totalCost: asDollars(totalCost),
    serviceCosts: Object.fromEntries(Object.entries(services).map(([k, v]) => [k, asDollars(v)])),
  };
}

function result(rows: CostRow[]): CostResult {
  return {
    rows,
    totalCost: asDollars(rows.reduce((s, r) => s + r.totalCost, 0)),
    topServices: [],
    dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') },
  };
}

function singleRoot(children: readonly OrgNode[]): readonly OrgNode[] {
  return [{ name: 'Organization', virtual: true, children }];
}

describe('applyOrgTreeRollup', () => {
  it('rolls a department into a single row summing its leaves', () => {
    const tree = singleRoot([
      { name: 'engineering', virtual: true, children: [{ name: 'backend' }, { name: 'frontend' }] },
    ]);
    const input = result([
      row('backend', 100, { ec2: 60, s3: 40 }),
      row('frontend', 50, { ec2: 30, s3: 20 }),
    ]);

    const out = applyOrgTreeRollup(input, tree);

    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]?.entity).toBe('engineering');
    expect(out.rows[0]?.totalCost).toBe(150);
    expect(out.rows[0]?.serviceCosts).toEqual({ ec2: asDollars(90), s3: asDollars(60) });
    expect(out.rows[0]?.isVirtual).toBe(true);
  });

  it('emits leaves placed directly under the root as raw rows', () => {
    const tree = singleRoot([{ name: 'backend' }, { name: 'frontend' }]);
    const input = result([
      row('backend', 100, { ec2: 100 }),
      row('frontend', 50, { ec2: 50 }),
    ]);

    const out = applyOrgTreeRollup(input, tree);

    expect(out.rows).toHaveLength(2);
    expect(out.rows.find(r => r.entity === 'backend')?.totalCost).toBe(100);
    expect(out.rows.find(r => r.entity === 'frontend')?.totalCost).toBe(50);
    expect(out.rows.every(r => r.isVirtual === undefined)).toBe(true);
  });

  it('mixes departments and leaves at the top level', () => {
    const tree = singleRoot([
      { name: 'engineering', virtual: true, children: [{ name: 'backend' }, { name: 'frontend' }] },
      { name: 'lone-team' },
    ]);
    const input = result([
      row('backend', 100, {}),
      row('frontend', 50, {}),
      row('lone-team', 25, {}),
    ]);

    const out = applyOrgTreeRollup(input, tree);

    expect(out.rows).toHaveLength(2);
    expect(out.rows.find(r => r.entity === 'engineering')?.totalCost).toBe(150);
    expect(out.rows.find(r => r.entity === 'lone-team')?.totalCost).toBe(25);
  });

  it('passes through unassigned leaves not under any department', () => {
    const tree = singleRoot([
      { name: 'engineering', virtual: true, children: [{ name: 'backend' }] },
    ]);
    const input = result([
      row('backend', 100, {}),
      row('orphan-team', 25, {}),
    ]);

    const out = applyOrgTreeRollup(input, tree);

    expect(out.rows).toHaveLength(2);
    expect(out.rows.find(r => r.entity === 'engineering')?.totalCost).toBe(100);
    expect(out.rows.find(r => r.entity === 'orphan-team')?.totalCost).toBe(25);
  });

  it('drops a department whose descendants have no data', () => {
    const tree = singleRoot([
      { name: 'empty-dept', virtual: true, children: [{ name: 'missing-team' }] },
    ]);
    const input = result([row('other-team', 10, {})]);

    const out = applyOrgTreeRollup(input, tree);

    expect(out.rows.find(r => r.entity === 'empty-dept')).toBeUndefined();
    expect(out.rows.find(r => r.entity === 'other-team')?.totalCost).toBe(10);
  });

  it('flattens nested departments into their top-level ancestor', () => {
    const tree = singleRoot([
      {
        name: 'engineering',
        virtual: true,
        children: [
          { name: 'platform', virtual: true, children: [{ name: 'backend' }, { name: 'frontend' }] },
          { name: 'data', virtual: true, children: [{ name: 'analytics' }] },
        ],
      },
    ]);
    const input = result([
      row('backend', 100, {}),
      row('frontend', 50, {}),
      row('analytics', 75, {}),
    ]);

    const out = applyOrgTreeRollup(input, tree);

    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]?.entity).toBe('engineering');
    expect(out.rows[0]?.totalCost).toBe(225);
  });

  it('does not double-count when the same leaf appears under multiple subtrees', () => {
    const tree = singleRoot([
      { name: 'engineering', virtual: true, children: [{ name: 'backend' }] },
      { name: 'platform', virtual: true, children: [{ name: 'backend' }] },
    ]);
    const input = result([row('backend', 100, {})]);

    const out = applyOrgTreeRollup(input, tree);

    const eng = out.rows.find(r => r.entity === 'engineering');
    const plat = out.rows.find(r => r.entity === 'platform');
    expect(eng?.totalCost).toBe(100);
    expect(plat?.totalCost).toBe(100);
    expect(out.rows.find(r => r.entity === 'backend')).toBeUndefined();
  });
});
