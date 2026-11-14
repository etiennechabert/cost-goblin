import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type DimensionsConfig,
  type ProviderSourceSpec,
  type RollupManifest,
  ROLLUP_SCHEMA_VERSION,
  asDimensionId,
  asProviderName,
  computePartitionEtagHash,
  tagSqlColumn,
} from '@costgoblin/core';
import { columnForDimension, providersEmptyForRange, resolveRollupSource } from '../main/handlers/query-utils.js';
import { RollupStore } from '../main/rollup-store.js';

const dims: DimensionsConfig = {
  builtIn: [
    { name: asDimensionId('account'), label: 'Account', field: 'account_id', displayField: 'account_name' },
    { name: asDimensionId('service'), label: 'Service', field: 'service' },
  ],
  tags: [{ tagName: 'team', label: 'Team', concept: 'owner' }],
};

describe('columnForDimension', () => {
  it('maps a built-in id to its field and a tag id to its column', () => {
    expect(columnForDimension(dims, 'account')).toBe('account_id');
    expect(columnForDimension(dims, 'service')).toBe('service');
    expect(columnForDimension(dims, 'tag_team')).toBe(tagSqlColumn({ tagName: 'team' }));
  });
  it('maps tag ids that differ only by case to distinct columns', () => {
    const cased: DimensionsConfig = { builtIn: [], tags: [{ tagName: 'STAGE', label: 'STAGE' }, { tagName: 'stage', label: 'stage' }] };
    const upper = columnForDimension(cased, 'tag_STAGE');
    const lower = columnForDimension(cased, 'tag_stage');
    expect(upper.toLowerCase()).not.toBe(lower.toLowerCase());
  });
  it('returns an unknown/disabled id unchanged (so it gates out of the rollup grain)', () => {
    expect(columnForDimension(dims, 'resource_id')).toBe('resource_id');
  });
});

describe('resolveRollupSource', () => {
  const oneProvider: ProviderSourceSpec[] = [{ name: asProviderName('aws'), type: 'aws' }];
  it('returns undefined when the store has no valid partitions (falls back to raw)', () => {
    const store = new RollupStore({ dataDir: '/tmp/none', providerName: () => asProviderName('aws'), runQuery: () => Promise.resolve([]) });
    expect(resolveRollupSource(store, oneProvider, { start: '2026-01-01', end: '2026-01-31' }, 'daily', ['service', 'cost'])).toBeUndefined();
  });
  it('never routes a multi-provider query through the single-provider store', () => {
    const store = new RollupStore({ dataDir: '/tmp/none', providerName: () => asProviderName('aws'), runQuery: () => Promise.resolve([]) });
    const two: ProviderSourceSpec[] = [{ name: asProviderName('aws'), type: 'aws' }, { name: asProviderName('aws-b'), type: 'aws' }];
    expect(resolveRollupSource(store, two, { start: '2026-01-01', end: '2026-01-31' }, 'daily', ['service', 'cost'])).toBeUndefined();
  });

  // A history with a hole in it: January and March are synced and rolled up,
  // February was never exported. April is on disk, but its partition is stale.
  describe('over months that are not all on disk', () => {
    const provider = asProviderName('aws');
    const etags = { '2026-01': { jan: 'h1' }, '2026-03': { mar: 'h3' }, '2026-04': { apr: 'h4' } };
    const onDisk: ProviderSourceSpec[] = [{ name: provider, type: 'aws', availablePeriods: ['2026-01', '2026-03', '2026-04'] }];
    const columns = ['service', 'cost'];
    let dataDir: string;
    let store: RollupStore;

    beforeAll(async () => {
      dataDir = await mkdtemp(join(tmpdir(), 'cg-rollup-routing-'));
      const manifest: RollupManifest = {
        schemaVersion: ROLLUP_SCHEMA_VERSION,
        shapeSignature: 'SIG',
        builtAt: '',
        grainDimensions: ['service'],
        partitions: {
          '2026-01': { rawEtagHash: computePartitionEtagHash(etags['2026-01']), rows: 1, bytes: 1 },
          '2026-03': { rawEtagHash: computePartitionEtagHash(etags['2026-03']), rows: 1, bytes: 1 },
          '2026-04': { rawEtagHash: computePartitionEtagHash({ apr: 'replaced-since' }), rows: 1, bytes: 1 },
        },
      };
      await mkdir(join(dataDir, provider, 'rollup'), { recursive: true });
      await writeFile(join(dataDir, provider, 'rollup', 'manifest.json'), JSON.stringify(manifest));
      store = new RollupStore({ dataDir, providerName: () => provider, runQuery: () => Promise.resolve([]) });
      const validation = await store.loadAndValidate({ signature: 'SIG', grainDimensions: ['service'] }, etags);
      expect([...validation.validPeriods].sort((a, b) => a.localeCompare(b))).toEqual(['2026-01', '2026-03']);
    });
    afterAll(async () => { await rm(dataDir, { recursive: true, force: true }); });

    it('reads the rollup across a month with no data, listing only the partitions that exist', () => {
      const source = resolveRollupSource(store, onDisk, { start: '2026-01-01', end: '2026-03-31' }, 'daily', columns);
      expect(source).toContain('daily-2026-01/rollup.parquet');
      expect(source).toContain('daily-2026-03/rollup.parquet');
      expect(source).not.toContain('2026-02');
    });
    it('reads the rollup for a range that starts before the first month and ends after the last', () => {
      const source = resolveRollupSource(store, onDisk, { start: '2025-06-01', end: '2026-03-31' }, 'daily', columns);
      expect(source).toContain('daily-2026-01/rollup.parquet');
      expect(source).toContain('daily-2026-03/rollup.parquet');
      expect(source).not.toContain('2025-');
    });
    it('still falls back to raw when a month that IS on disk has no valid partition', () => {
      expect(resolveRollupSource(store, onDisk, { start: '2026-03-01', end: '2026-04-30' }, 'daily', columns)).toBeUndefined();
    });
    it('falls back to raw when no month of the range is on disk', () => {
      expect(resolveRollupSource(store, onDisk, { start: '2026-02-01', end: '2026-02-28' }, 'daily', columns)).toBeUndefined();
    });
    it('requires every month of the range when the months on disk are not known', () => {
      const unknown: ProviderSourceSpec[] = [{ name: provider, type: 'aws' }];
      expect(resolveRollupSource(store, unknown, { start: '2026-01-01', end: '2026-01-31' }, 'daily', columns)).toContain('daily-2026-01/rollup.parquet');
      expect(resolveRollupSource(store, unknown, { start: '2026-01-01', end: '2026-03-31' }, 'daily', columns)).toBeUndefined();
    });
  });
});

describe('providersEmptyForRange', () => {
  const range = { start: '2026-06-01', end: '2026-06-30' };
  it('is NOT empty when any provider has a month in range — even if the first does not', () => {
    const providers: ProviderSourceSpec[] = [
      { name: asProviderName('stale-payer'), type: 'aws', availablePeriods: ['2025-01', '2025-02'] },
      { name: asProviderName('active-payer'), type: 'aws', availablePeriods: ['2026-06'] },
    ];
    expect(providersEmptyForRange(providers, range)).toBe(false);
  });
  it('is empty when no provider intersects the range, and for an empty provider list', () => {
    expect(providersEmptyForRange([{ name: asProviderName('a'), type: 'aws', availablePeriods: ['2025-01'] }], range)).toBe(true);
    expect(providersEmptyForRange([], range)).toBe(true);
  });
});

