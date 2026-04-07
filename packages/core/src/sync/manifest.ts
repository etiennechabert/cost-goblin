export interface ManifestFileEntry {
  readonly key: string;
  readonly contentHash: string;
  readonly size: number;
}

export interface SyncManifest {
  readonly files: readonly ManifestFileEntry[];
  readonly lastSync: string | null;
  readonly version: number;
}

export interface PartitionLineage {
  readonly sourceFile: string;
  readonly partitions: readonly string[];
}

export interface SyncState {
  readonly manifest: SyncManifest;
  readonly lineage: readonly PartitionLineage[];
}

export function createEmptySyncState(): SyncState {
  return {
    manifest: { files: [], lastSync: null, version: 1 },
    lineage: [],
  };
}

export function diffManifests(
  previous: SyncManifest,
  current: SyncManifest,
): { toDownload: readonly ManifestFileEntry[]; toDelete: readonly string[] } {
  const prevMap = new Map(previous.files.map(f => [f.key, f.contentHash]));
  const currMap = new Map(current.files.map(f => [f.key, f.contentHash]));

  const toDownload = current.files.filter(f => {
    const prevHash = prevMap.get(f.key);
    return prevHash === undefined || prevHash !== f.contentHash;
  });

  const toDelete = previous.files
    .filter(f => !currMap.has(f.key))
    .map(f => f.key);

  return { toDownload, toDelete };
}
