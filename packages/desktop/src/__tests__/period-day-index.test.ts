import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asProviderName, logger, QUERY_CANCELLED_MESSAGE } from '@costgoblin/core';
import type { RawRow } from '../main/duckdb-client.js';
import { PeriodDayIndex } from '../main/period-day-index.js';
import { isQueryEngineUnavailable } from '../main/query-engine-errors.js';

/** The index over a real directory tree (its fingerprints are the files'
 *  names, sizes and modification times) and a scripted query runner: what a
 *  day-list query returns is DuckDB's business, tested in core. */

const PROVIDER = { name: asProviderName('aws-main'), type: 'aws' as const };
const JANUARY = ['2026-01-01', '2026-01-31', '2026-02-01'];
const MARCH = ['2026-02-27', '2026-03-02'];

let dataDir: string;
/** The periods the queries run so far asked for, in order. */
let asked: string[];
let answers: Map<string, () => Promise<RawRow[]>>;

function periodOf(sql: string): string {
  return /daily-(\d{4}-\d{2})\//.exec(sql)?.[1] ?? /hourly-(\d{4}-\d{2})\//.exec(sql)?.[1] ?? '';
}

const dayRows = (days: readonly string[]): RawRow[] => days.map(day => ({ day }));

function runQuery(sql: string): Promise<RawRow[]> {
  const period = periodOf(sql);
  asked.push(period);
  return (answers.get(period) ?? ((): Promise<RawRow[]> => Promise.resolve([])))();
}

function newIndex(): PeriodDayIndex {
  return new PeriodDayIndex({ dataDir, runQuery, isEngineFailure: isQueryEngineUnavailable });
}

async function writeMonth(period: string, files: Readonly<Record<string, string>>, tier = 'daily'): Promise<string> {
  const dir = join(dataDir, 'aws-main', 'raw', `${tier}-${period}`);
  await mkdir(dir, { recursive: true });
  for (const [name, contents] of Object.entries(files)) await writeFile(join(dir, name), contents);
  return dir;
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'cg-period-days-'));
  asked = [];
  answers = new Map([
    ['2026-01', () => Promise.resolve(dayRows(JANUARY))],
    ['2026-03', () => Promise.resolve(dayRows(MARCH))],
  ]);
  await writeMonth('2026-01', { 'a.parquet': 'january' });
  await writeMonth('2026-03', { 'a.parquet': 'march' });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dataDir, { recursive: true, force: true });
});

describe('PeriodDayIndex', () => {
  it('reads each period\'s days once, and gives them back for as long as its files stay the same', async () => {
    const index = newIndex();
    const expected = { '2026-01': JANUARY, '2026-03': MARCH };
    expect(await index.daysFor(PROVIDER, 'daily', ['2026-01', '2026-03'])).toEqual(expected);
    expect(await index.daysFor(PROVIDER, 'daily', ['2026-01', '2026-03'])).toEqual(expected);
    expect([...asked].sort((a, b) => a.localeCompare(b))).toEqual(['2026-01', '2026-03']);
  });

  it('reads a period again when a file of it is replaced, added or removed, and no other', async () => {
    const index = newIndex();
    await index.daysFor(PROVIDER, 'daily', ['2026-01', '2026-03']);
    asked = [];

    // Replaced by one of another size.
    answers.set('2026-01', () => Promise.resolve(dayRows(['2026-01-05'])));
    const dir = await writeMonth('2026-01', { 'a.parquet': 'january, synced again' });
    expect(await index.daysFor(PROVIDER, 'daily', ['2026-01', '2026-03'])).toEqual({ '2026-01': ['2026-01-05'], '2026-03': MARCH });
    expect(asked).toEqual(['2026-01']);

    // The same size, written at another time.
    await utimes(join(dir, 'a.parquet'), new Date('2026-04-01T00:00:00Z'), new Date('2026-04-01T00:00:00Z'));
    await index.daysFor(PROVIDER, 'daily', ['2026-01', '2026-03']);
    expect(asked).toEqual(['2026-01', '2026-01']);

    await writeMonth('2026-01', { 'b.parquet': 'more' });
    await index.daysFor(PROVIDER, 'daily', ['2026-01']);
    await rm(join(dir, 'b.parquet'));
    await index.daysFor(PROVIDER, 'daily', ['2026-01']);
    expect(asked).toEqual(['2026-01', '2026-01', '2026-01', '2026-01']);

    // A file that is not Parquet (a download's leftover) changes nothing.
    await writeFile(join(dir, 'notes.txt'), 'x');
    await index.daysFor(PROVIDER, 'daily', ['2026-01']);
    expect(asked).toHaveLength(4);
  });

  it('keeps the tiers and the providers apart', async () => {
    const index = newIndex();
    await writeMonth('2026-01', { 'a.parquet': 'hourly january' }, 'hourly');
    await index.daysFor(PROVIDER, 'daily', ['2026-01']);
    await index.daysFor(PROVIDER, 'hourly', ['2026-01']);
    expect(asked).toEqual(['2026-01', '2026-01']);
    // Another provider's tree has no such month: nothing to read, no entry.
    expect(await index.daysFor({ name: asProviderName('gcp-main'), type: 'gcp' }, 'daily', ['2026-01'])).toEqual({});
    expect(asked).toHaveLength(2);
  });

  it('shares one read between the queries that ask for a period at once', async () => {
    let release: (rows: RawRow[]) => void = () => undefined;
    answers.set('2026-01', () => new Promise<RawRow[]>((resolve) => { release = resolve; }));
    const index = newIndex();
    const calls = [index.daysFor(PROVIDER, 'daily', ['2026-01']), index.daysFor(PROVIDER, 'daily', ['2026-01']), index.daysFor(PROVIDER, 'daily', ['2026-01'])];
    await vi.waitFor(() => { expect(asked).toEqual(['2026-01']); });
    release(dayRows(JANUARY));
    expect(await Promise.all(calls)).toEqual([{ '2026-01': JANUARY }, { '2026-01': JANUARY }, { '2026-01': JANUARY }]);
    expect(asked).toEqual(['2026-01']);
  });

  it('runs no more than four reads at a time', async () => {
    const periods = ['2025-06', '2025-07', '2025-08', '2025-09', '2025-10', '2025-11'];
    const releases: (() => void)[] = [];
    let running = 0;
    let most = 0;
    for (const period of periods) {
      await writeMonth(period, { 'a.parquet': period });
      answers.set(period, () => new Promise<RawRow[]>((resolve) => {
        running += 1;
        most = Math.max(most, running);
        releases.push(() => { running -= 1; resolve(dayRows([`${period}-01`])); });
      }));
    }
    const done = newIndex().daysFor(PROVIDER, 'daily', periods);
    await vi.waitFor(() => { expect(releases).toHaveLength(4); });
    while (releases.length > 0) {
      releases.shift()?.();
      await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    }
    expect(Object.keys(await done)).toEqual(periods);
    expect(most).toBe(4);
  });

  it('leaves out a period whose days can\'t be read, says so once, and reads it on the next call', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    answers.set('2026-01', () => Promise.reject(new Error('Invalid Input Error: No magic bytes found at end of file')));
    const index = newIndex();
    expect(await index.daysFor(PROVIDER, 'daily', ['2026-01', '2026-03'])).toEqual({ '2026-03': MARCH });
    expect(await index.daysFor(PROVIDER, 'daily', ['2026-01', '2026-03'])).toEqual({ '2026-03': MARCH });
    expect(asked.filter(p => p === '2026-01')).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not read the days of daily 2026-01 (aws-main)'));

    answers.set('2026-01', () => Promise.resolve(dayRows(JANUARY)));
    expect(await index.daysFor(PROVIDER, 'daily', ['2026-01', '2026-03'])).toEqual({ '2026-01': JANUARY, '2026-03': MARCH });
  });

  it('rejects with a cancellation or an engine failure, and keeps neither', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const index = newIndex();
    for (const message of [QUERY_CANCELLED_MESSAGE, 'The query engine stopped unexpectedly and is restarting. Run the query again.']) {
      answers.set('2026-01', () => Promise.reject(new Error(message)));
      await expect(index.daysFor(PROVIDER, 'daily', ['2026-01'])).rejects.toThrow(message);
    }
    expect(warn).not.toHaveBeenCalled();
    answers.set('2026-01', () => Promise.resolve(dayRows(JANUARY)));
    expect(await index.daysFor(PROVIDER, 'daily', ['2026-01'])).toEqual({ '2026-01': JANUARY });
  });

  it('skips a period whose directory is gone, and a row that names no day', async () => {
    answers.set('2026-03', () => Promise.resolve([{ day: '2026-03-02' }, { day: null }, { other: 'x' }]));
    const index = newIndex();
    expect(await index.daysFor(PROVIDER, 'daily', ['2026-02', '2026-03'])).toEqual({ '2026-03': ['2026-03-02'] });
    expect(asked).toEqual(['2026-03']);
  });
});

describe('isQueryEngineUnavailable', () => {
  it('is true for the supervisor\'s own rejections only', () => {
    expect(isQueryEngineUnavailable(new Error('The query engine was shut down.'))).toBe(true);
    expect(isQueryEngineUnavailable(new Error('IO Error: the query engine of this car'))).toBe(false);
    expect(isQueryEngineUnavailable('The query engine was shut down.')).toBe(false);
  });
});
