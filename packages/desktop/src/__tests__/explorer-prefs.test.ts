import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_EXPLORER_HIDDEN_COLUMNS } from '@costgoblin/core';
import { readExplorerPreferences } from '../main/handlers/explorer-prefs.js';

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
});
