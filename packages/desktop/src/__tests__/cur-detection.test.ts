import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearPreFocusData, findPreFocusProviders, isPreFocusColumns } from '../main/cur-detection.js';

const FOCUS_COLUMNS = ['ChargePeriodStart', 'BilledCost', 'ServiceName', 'SubAccountId'];
const CUR_COLUMNS = ['line_item_usage_start_date', 'line_item_unblended_cost', 'bill_payer_account_id'];

describe('isPreFocusColumns', () => {
  it('accepts a FOCUS column set', () => {
    expect(isPreFocusColumns(FOCUS_COLUMNS)).toBe(false);
  });

  it('flags a CUR 2.0 column set (missing the FOCUS sentinels)', () => {
    expect(isPreFocusColumns(CUR_COLUMNS)).toBe(true);
  });

  it('flags a set missing even one sentinel', () => {
    expect(isPreFocusColumns(['ChargePeriodStart', 'ServiceName'])).toBe(true); // no BilledCost
  });

  it('treats an empty column list as NOT pre-FOCUS (a read failure must never trigger a wipe)', () => {
    expect(isPreFocusColumns([])).toBe(false);
  });
});

describe('findPreFocusProviders', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'cg-cur-'));
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  async function seedRaw(provider: string, periodDir: string): Promise<void> {
    const dir = join(dataDir, provider, 'raw', periodDir);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'data.parquet'), '');
  }

  const describeFrom = (byProvider: Record<string, readonly string[]>) =>
    (glob: string): Promise<readonly string[]> => {
      for (const [provider, cols] of Object.entries(byProvider)) {
        if (glob.includes(join(dataDir, provider) + '/') || glob.includes(join(dataDir, provider) + '\\')) {
          return Promise.resolve(cols);
        }
      }
      return Promise.resolve([]);
    };

  it('returns [] on a missing data dir (fresh install)', async () => {
    expect(await findPreFocusProviders(join(dataDir, 'nope'), () => Promise.resolve(FOCUS_COLUMNS))).toEqual([]);
  });

  it('returns [] when every provider is FOCUS-shaped', async () => {
    await seedRaw('aws-main', 'daily-2026-02');
    expect(await findPreFocusProviders(dataDir, describeFrom({ 'aws-main': FOCUS_COLUMNS }))).toEqual([]);
  });

  it('flags a provider whose raw parquet is CUR 2.0', async () => {
    await seedRaw('aws-main', 'daily-2026-02');
    expect(await findPreFocusProviders(dataDir, describeFrom({ 'aws-main': CUR_COLUMNS }))).toEqual(['aws-main']);
  });

  it('flags only the CUR provider in a mixed set', async () => {
    await seedRaw('aws-old', 'daily-2026-01');
    await seedRaw('gcp-new', 'daily-2026-02');
    const found = await findPreFocusProviders(dataDir, describeFrom({ 'aws-old': CUR_COLUMNS, 'gcp-new': FOCUS_COLUMNS }));
    expect(found).toEqual(['aws-old']);
  });

  it('ignores a provider dir with no raw period dirs', async () => {
    await mkdir(join(dataDir, 'aws-main', 'meta'), { recursive: true }); // no raw/
    expect(await findPreFocusProviders(dataDir, () => Promise.resolve(CUR_COLUMNS))).toEqual([]);
  });

  it('does not flag when describeColumns throws (transient read error)', async () => {
    await seedRaw('aws-main', 'daily-2026-02');
    expect(await findPreFocusProviders(dataDir, () => Promise.reject(new Error('locked')))).toEqual([]);
  });

  it('recognizes the cost-opt tier prefix', async () => {
    await seedRaw('aws-main', 'cost-opt-2026-02');
    expect(await findPreFocusProviders(dataDir, describeFrom({ 'aws-main': CUR_COLUMNS }))).toEqual(['aws-main']);
  });
});

describe('clearPreFocusData', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'cg-cur-clear-'));
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('deletes the named providers\' trees and the config file', async () => {
    await mkdir(join(dataDir, 'aws-main', 'raw', 'daily-2026-02'), { recursive: true });
    await mkdir(join(dataDir, 'keep-me', 'raw'), { recursive: true });
    const configPath = join(dataDir, 'costgoblin.yaml');
    await writeFile(configPath, 'providers: []');

    await clearPreFocusData(dataDir, configPath, ['aws-main']);

    expect(existsSync(join(dataDir, 'aws-main'))).toBe(false); // wiped
    expect(existsSync(join(dataDir, 'keep-me'))).toBe(true); // untouched
    expect(existsSync(configPath)).toBe(false); // removed → app boots into wizard
  });

  it('is a no-op-safe when the config is already gone', async () => {
    const configPath = join(dataDir, 'gone.yaml');
    await expect(clearPreFocusData(dataDir, configPath, [])).resolves.toBeUndefined();
  });
});
