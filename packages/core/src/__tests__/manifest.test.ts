import { describe, it, expect } from 'vitest';
import { createEmptySyncState, diffManifests } from '../sync/manifest.js';
import type { SyncManifest, ManifestFileEntry } from '../sync/manifest.js';

describe('createEmptySyncState', () => {
  it('creates state with empty manifest and lineage', () => {
    const state = createEmptySyncState();
    expect(state.manifest.files).toHaveLength(0);
    expect(state.manifest.lastSync).toBeNull();
    expect(state.lineage).toHaveLength(0);
  });
});

describe('diffManifests', () => {
  const file1: ManifestFileEntry = { key: 'data/2026-01.parquet', contentHash: 'abc123', size: 1000 };
  const file2: ManifestFileEntry = { key: 'data/2026-02.parquet', contentHash: 'def456', size: 2000 };
  const file2Updated: ManifestFileEntry = { key: 'data/2026-02.parquet', contentHash: 'ghi789', size: 2500 };
  const file3: ManifestFileEntry = { key: 'data/2026-03.parquet', contentHash: 'jkl012', size: 3000 };

  it('identifies new files to download', () => {
    const prev: SyncManifest = { files: [file1], lastSync: '2026-01-01', version: 1 };
    const curr: SyncManifest = { files: [file1, file2], lastSync: '2026-02-01', version: 1 };
    const diff = diffManifests(prev, curr);
    expect(diff.toDownload).toHaveLength(1);
    expect(diff.toDownload[0]?.key).toBe('data/2026-02.parquet');
    expect(diff.toDelete).toHaveLength(0);
  });

  it('identifies changed files to re-download', () => {
    const prev: SyncManifest = { files: [file1, file2], lastSync: '2026-01-01', version: 1 };
    const curr: SyncManifest = { files: [file1, file2Updated], lastSync: '2026-02-01', version: 1 };
    const diff = diffManifests(prev, curr);
    expect(diff.toDownload).toHaveLength(1);
    expect(diff.toDownload[0]?.key).toBe('data/2026-02.parquet');
    expect(diff.toDelete).toHaveLength(0);
  });

  it('identifies deleted files', () => {
    const prev: SyncManifest = { files: [file1, file2], lastSync: '2026-01-01', version: 1 };
    const curr: SyncManifest = { files: [file1], lastSync: '2026-02-01', version: 1 };
    const diff = diffManifests(prev, curr);
    expect(diff.toDownload).toHaveLength(0);
    expect(diff.toDelete).toEqual(['data/2026-02.parquet']);
  });

  it('handles full refresh from empty', () => {
    const prev: SyncManifest = { files: [], lastSync: null, version: 1 };
    const curr: SyncManifest = { files: [file1, file2, file3], lastSync: '2026-03-01', version: 1 };
    const diff = diffManifests(prev, curr);
    expect(diff.toDownload).toHaveLength(3);
    expect(diff.toDelete).toHaveLength(0);
  });

  it('handles no changes', () => {
    const manifest: SyncManifest = { files: [file1, file2], lastSync: '2026-01-01', version: 1 };
    const diff = diffManifests(manifest, manifest);
    expect(diff.toDownload).toHaveLength(0);
    expect(diff.toDelete).toHaveLength(0);
  });
});
