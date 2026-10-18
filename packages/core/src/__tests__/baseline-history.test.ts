import { describe, expect, it } from 'vitest';
import { parseBaselineHistory } from '../baseline/history.js';

describe('parseBaselineHistory', () => {
  it('keeps calendar-day points with their costs, per baseline id', () => {
    const history = parseBaselineHistory({
      a: [{ date: '2026-02-01', cost: 10 }, { date: '2026-02-02', cost: 20.5 }],
      b: [],
    });
    expect([...history]).toEqual([
      ['a', [{ date: '2026-02-01', cost: 10 }, { date: '2026-02-02', cost: 20.5 }]],
      ['b', []],
    ]);
  });

  // computeCurrent reads each date through Date.parse: the first six give NaN
  // and throw there; the rest are shape-valid days that Date.parse rolls over.
  it.each([
    ['a number', 7],
    ['null', null],
    ['not a date', 'garbage'],
    ['month 13, day 45', '2026-13-45'],
    ['an unpadded month', '2026-2-01'],
    ['a timestamp', '2026-02-01T00:00:00Z'],
    ['February 31st', '2026-02-31'],
    ['April 31st', '2026-04-31'],
    ['February 29th of a common year', '2026-02-29'],
    ['February 29th of a common century year', '1900-02-29'],
  ])('skips a point whose date is %s', (_label, date) => {
    expect(parseBaselineHistory({ a: [{ date, cost: 1 }] }).get('a')).toEqual([]);
  });

  it.each(['2024-02-29', '2000-02-29', '2026-12-31', '0000-01-01'])('keeps the calendar day %s', (date) => {
    expect(parseBaselineHistory({ a: [{ date, cost: 1 }] }).get('a')).toEqual([{ date, cost: 1 }]);
  });

  it('skips non-object points and missing dates; a cost that is not a finite number reads as $0', () => {
    const history = parseBaselineHistory({
      a: ['2026-02-01', null, [], { cost: 1 }, { date: '2026-02-01', cost: 'abc' }, { date: '2026-02-02' }, { date: '2026-02-03', cost: Number.NaN }],
    });
    expect(history.get('a')).toEqual([
      { date: '2026-02-01', cost: 0 },
      { date: '2026-02-02', cost: 0 },
      { date: '2026-02-03', cost: 0 },
    ]);
  });

  it('gives a date the same verdict in every baseline that shares it', () => {
    const shared = [{ date: '2026-02-31', cost: 1 }, { date: '2026-02-01', cost: 2 }];
    const history = parseBaselineHistory({ a: shared, b: shared });
    expect(history.get('a')).toEqual([{ date: '2026-02-01', cost: 2 }]);
    expect(history.get('b')).toEqual([{ date: '2026-02-01', cost: 2 }]);
  });

  it('leaves out a baseline whose history is not an array, and reads a section that is not an object as empty', () => {
    expect([...parseBaselineHistory({ a: 'nope', b: { date: '2026-02-01', cost: 1 } }).keys()]).toEqual([]);
    expect(parseBaselineHistory(null).size).toBe(0);
    expect(parseBaselineHistory([[{ date: '2026-02-01', cost: 1 }]]).size).toBe(0);
  });
});
