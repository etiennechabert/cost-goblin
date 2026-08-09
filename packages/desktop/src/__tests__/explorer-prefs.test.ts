import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_EXPLORER_HIDDEN_COLUMNS, asDateString } from '@costgoblin/core';
import type { DateRange } from '@costgoblin/core';
import { readExplorerPreferences, writeExplorerPreferences } from '../main/handlers/explorer-prefs.js';

/** Branded DateRange literal for the typed `writeExplorerPreferences` calls
 *  (the raw `writeFile` fixtures below deliberately stay untyped strings). */
const dr = (start: string, end: string): DateRange => ({ start: asDateString(start), end: asDateString(end) });

let dir: string;
let prefsFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cg-explorer-prefs-'));
  prefsFile = join(dir, 'explorer-preferences.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const noLiveIds = () => Promise.resolve<ReadonlySet<string> | undefined>(undefined);

describe('readExplorerPreferences', () => {
  it('returns the default hidden set on first run (no prefs file)', async () => {
    const prefs = await readExplorerPreferences(prefsFile, noLiveIds);
    expect(prefs.hiddenColumns).toEqual([...DEFAULT_EXPLORER_HIDDEN_COLUMNS]);
    expect(prefs.columnOrder).toEqual([]);
    expect(prefs.lastUsedDateRange).toBeUndefined();
    expect(prefs.lastUsedGranularity).toBeUndefined();
  });

  it('honors a saved empty hiddenColumns as the user\'s explicit "Show all"', async () => {
    await writeFile(prefsFile, JSON.stringify({ hiddenColumns: [], columnOrder: [] }));
    const prefs = await readExplorerPreferences(prefsFile, noLiveIds);
    expect(prefs.hiddenColumns).toEqual([]);
  });

  it('round-trips a saved column choice, renaming CUR-era ids', async () => {
    await writeFile(prefsFile, JSON.stringify({
      hiddenColumns: ['service_family', 'tag_user_team', 'cost'],
      columnOrder: ['usage_type', 'region'],
    }));
    const prefs = await readExplorerPreferences(prefsFile, noLiveIds);
    expect(prefs.hiddenColumns).toEqual(['service_category', 'tag_team', 'cost']);
    expect(prefs.columnOrder).toEqual(['sku_meter', 'region']);
  });

  it('never renames an id that is live in the current dimensions config', async () => {
    await writeFile(prefsFile, JSON.stringify({
      hiddenColumns: ['tag_user_costcenter'],
      columnOrder: [],
    }));
    const live = new Set(['tag_user_costcenter']);
    const prefs = await readExplorerPreferences(prefsFile, () => Promise.resolve(live));
    expect(prefs.hiddenColumns).toEqual(['tag_user_costcenter']);
  });

  it('falls back to first-run defaults when the file is corrupt JSON', async () => {
    await writeFile(prefsFile, '{not json');
    const prefs = await readExplorerPreferences(prefsFile, noLiveIds);
    expect(prefs.hiddenColumns).toEqual([...DEFAULT_EXPLORER_HIDDEN_COLUMNS]);
    expect(prefs.columnOrder).toEqual([]);
  });

  it('treats a malformed hiddenColumns field as absent (default set), keeping valid siblings', async () => {
    await writeFile(prefsFile, JSON.stringify({
      hiddenColumns: 'nope',
      columnOrder: ['region', 'cost'],
    }));
    const prefs = await readExplorerPreferences(prefsFile, noLiveIds);
    expect(prefs.hiddenColumns).toEqual([...DEFAULT_EXPLORER_HIDDEN_COLUMNS]);
    expect(prefs.columnOrder).toEqual(['region', 'cost']);
  });

  it('passes through valid lastUsed* and compareEnabled, dropping invalid ones', async () => {
    await writeFile(prefsFile, JSON.stringify({
      hiddenColumns: [],
      columnOrder: [],
      lastUsedDateRange: { start: '2026-07-01', end: '2026-07-31' },
      lastUsedGranularity: 'hourly',
      compareEnabled: true,
    }));
    const prefs = await readExplorerPreferences(prefsFile, noLiveIds);
    expect(prefs.lastUsedDateRange).toEqual({ start: '2026-07-01', end: '2026-07-31' });
    expect(prefs.lastUsedGranularity).toBe('hourly');
    expect(prefs.compareEnabled).toBe(true);

    await writeFile(prefsFile, JSON.stringify({
      hiddenColumns: [],
      columnOrder: [],
      lastUsedDateRange: { start: 'garbage', end: '2026-07-31' },
      lastUsedGranularity: 'weekly',
      compareEnabled: 'yes',
    }));
    const rejected = await readExplorerPreferences(prefsFile, noLiveIds);
    expect(rejected.lastUsedDateRange).toBeUndefined();
    expect(rejected.lastUsedGranularity).toBeUndefined();
    expect(rejected.compareEnabled).toBeUndefined();
  });

  it('preserves a persisted hourly sub-window (startHour/endHour) across reload', async () => {
    await writeFile(prefsFile, JSON.stringify({
      hiddenColumns: [],
      columnOrder: [],
      lastUsedDateRange: {
        start: '2026-07-15', end: '2026-07-15',
        startHour: '2026-07-15 03:00:00', endHour: '2026-07-15 09:00:00',
      },
      lastUsedGranularity: 'hourly',
    }));
    const prefs = await readExplorerPreferences(prefsFile, noLiveIds);
    expect(prefs.lastUsedDateRange).toEqual({
      start: '2026-07-15', end: '2026-07-15',
      startHour: '2026-07-15 03:00:00', endHour: '2026-07-15 09:00:00',
    });
    expect(prefs.lastUsedGranularity).toBe('hourly');
  });

  it('drops the hourly window when either hour bound is malformed, keeping the day range', async () => {
    await writeFile(prefsFile, JSON.stringify({
      hiddenColumns: [],
      columnOrder: [],
      lastUsedDateRange: { start: '2026-07-15', end: '2026-07-15', startHour: '3am', endHour: '2026-07-15 09:00:00' },
    }));
    const prefs = await readExplorerPreferences(prefsFile, noLiveIds);
    expect(prefs.lastUsedDateRange).toEqual({ start: '2026-07-15', end: '2026-07-15' });
  });

  it('rejects a calendar-impossible lastUsedDateRange (strict date validation)', async () => {
    await writeFile(prefsFile, JSON.stringify({
      hiddenColumns: [],
      columnOrder: [],
      lastUsedDateRange: { start: '2026-02-30', end: '2026-13-01' },
    }));
    const prefs = await readExplorerPreferences(prefsFile, noLiveIds);
    expect(prefs.lastUsedDateRange).toBeUndefined();
  });
});

describe('writeExplorerPreferences', () => {
  it('preserves the on-disk column set when the update omits the column fields', async () => {
    // A user with a curated hidden/order set (as the Explorer would persist).
    await writeFile(prefsFile, JSON.stringify({
      hiddenColumns: ['region', 'description'],
      columnOrder: ['cost', 'service'],
      lastUsedDateRange: { start: '2026-05-01', end: '2026-05-31' },
      lastUsedGranularity: 'daily',
    }));

    // EntityDetail / CustomView persist only a date range — no column fields.
    await writeExplorerPreferences(prefsFile, {
      lastUsedDateRange: dr('2026-06-01', '2026-06-30'),
      lastUsedGranularity: 'hourly',
    });

    const prefs = await readExplorerPreferences(prefsFile, noLiveIds);
    // The column set survived; the date range / granularity were updated.
    expect(prefs.hiddenColumns).toEqual(['region', 'description']);
    expect(prefs.columnOrder).toEqual(['cost', 'service']);
    expect(prefs.lastUsedDateRange).toEqual({ start: '2026-06-01', end: '2026-06-30' });
    expect(prefs.lastUsedGranularity).toBe('hourly');
  });

  it('preserves the explicit "Show all" ([]) when the update omits columns', async () => {
    await writeFile(prefsFile, JSON.stringify({ hiddenColumns: [], columnOrder: [] }));
    await writeExplorerPreferences(prefsFile, {
      lastUsedDateRange: dr('2026-06-01', '2026-06-30'),
    });
    const prefs = await readExplorerPreferences(prefsFile, noLiveIds);
    // Still "Show all" — a date-range save can't silently re-hide columns.
    expect(prefs.hiddenColumns).toEqual([]);
  });

  it('lets a column-managing update overwrite the on-disk column set', async () => {
    await writeFile(prefsFile, JSON.stringify({
      hiddenColumns: ['region'],
      columnOrder: [],
    }));
    // The Explorer legitimately owns column visibility and sends the fields.
    await writeExplorerPreferences(prefsFile, {
      hiddenColumns: ['cost', 'service'],
      columnOrder: ['region', 'cost'],
      lastUsedDateRange: dr('2026-06-01', '2026-06-30'),
      lastUsedGranularity: 'daily',
    });
    const prefs = await readExplorerPreferences(prefsFile, noLiveIds);
    expect(prefs.hiddenColumns).toEqual(['cost', 'service']);
    expect(prefs.columnOrder).toEqual(['region', 'cost']);
  });

  it('on first run, an update without columns reads back as the default hidden set (not "Show all")', async () => {
    // No file on disk. A column-less write must not materialize `[]`.
    await writeExplorerPreferences(prefsFile, {
      lastUsedDateRange: dr('2026-06-01', '2026-06-30'),
      lastUsedGranularity: 'daily',
    });
    const raw: unknown = JSON.parse(await readFile(prefsFile, 'utf-8'));
    expect(raw).toEqual({
      lastUsedDateRange: { start: '2026-06-01', end: '2026-06-30' },
      lastUsedGranularity: 'daily',
    });
    const prefs = await readExplorerPreferences(prefsFile, noLiveIds);
    expect(prefs.hiddenColumns).toEqual([...DEFAULT_EXPLORER_HIDDEN_COLUMNS]);
    expect(prefs.columnOrder).toEqual([]);
  });

  it('serializes concurrent read-modify-write cycles instead of losing a slice', async () => {
    await writeFile(prefsFile, JSON.stringify({ hiddenColumns: ['region'], columnOrder: [] }));
    // Fired together, as the renderer does (saves are fire-and-forget). An
    // unserialized merge would let both read the same base and the later
    // write would drop the earlier one's field.
    await Promise.all([
      writeExplorerPreferences(prefsFile, { hiddenColumns: ['cost', 'service'] }),
      writeExplorerPreferences(prefsFile, { lastUsedDateRange: dr('2026-06-01', '2026-06-30') }),
    ]);
    const prefs = await readExplorerPreferences(prefsFile, noLiveIds);
    expect(prefs.hiddenColumns).toEqual(['cost', 'service']);
    expect(prefs.lastUsedDateRange).toEqual({ start: '2026-06-01', end: '2026-06-30' });
  });

  // NOTE: writeExplorerPreferences also skips keys whose update value is
  // `undefined` (a bare spread would set the key, JSON.stringify would drop
  // it, and the on-disk value would be DELETED rather than preserved). That
  // guard defends the untyped IPC boundary only — `exactOptionalPropertyTypes`
  // makes the payload unrepresentable for any typed caller, so it cannot be
  // exercised from here without an `as` cast, which the repo bans.

  it('preserves unknown sibling fields already in the file', async () => {
    await writeFile(prefsFile, JSON.stringify({
      hiddenColumns: ['region'],
      columnOrder: [],
      futureField: { keep: true },
    }));
    await writeExplorerPreferences(prefsFile, { lastUsedGranularity: 'daily' });
    const raw = await readFile(prefsFile, 'utf-8');
    expect(JSON.parse(raw)).toMatchObject({
      hiddenColumns: ['region'],
      futureField: { keep: true },
      lastUsedGranularity: 'daily',
    });
  });
});
