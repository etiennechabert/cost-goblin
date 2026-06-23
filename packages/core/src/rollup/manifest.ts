import { canonicalJson, sha256Hex } from './digest.js';

/** One built rollup partition (one month) and the raw-data watermark it was
 *  built from. */
export interface RollupPartitionMeta {
  /** Hash of that period's entry in sync-etags.json at build time. A mismatch
   *  vs current etags means the raw data changed → the partition is stale. */
  readonly rawEtagHash: string;
  readonly rows: number;
  readonly bytes: number;
}

export interface RollupManifest {
  readonly schemaVersion: number;
  readonly shapeSignature: string;
  /** ISO timestamp — diagnostics only, never part of validation. */
  readonly builtAt: string;
  /** Grain dimension columns baked into these partitions (sorted). */
  readonly grainDimensions: readonly string[];
  /** Column-probe set the partitions were built against. */
  readonly availableColumns: readonly string[];
  readonly partitions: Readonly<Record<string, RollupPartitionMeta>>;
}

export interface ManifestValidation {
  /** Partitions whose signature + watermark match — usable as-is, no rebuild. */
  readonly validPeriods: ReadonlySet<string>;
  /** Partitions present but whose raw data changed — must be re-rolled. */
  readonly stalePeriods: ReadonlySet<string>;
  /** Signature or schema-version mismatch → the whole rollup is unusable and
   *  every partition must be rebuilt. */
  readonly fullyInvalid: boolean;
}

/** Stable watermark for a period: a digest of its `{fileKey: contentHash}` map
 *  from sync-etags.json. Re-roll exactly when this changes. */
export function computePartitionEtagHash(periodEtags: Readonly<Record<string, string>> | undefined): string {
  return sha256Hex(canonicalJson(periodEtags ?? {}));
}

export function validateManifest(
  manifest: RollupManifest | null,
  opts: {
    readonly currentSignature: string;
    readonly currentSchemaVersion: number;
    readonly etagsByPeriod: Readonly<Record<string, Readonly<Record<string, string>>>>;
  },
): ManifestValidation {
  const empty = { validPeriods: new Set<string>(), stalePeriods: new Set<string>() };
  if (manifest === null) return { ...empty, fullyInvalid: true };
  if (manifest.schemaVersion !== opts.currentSchemaVersion || manifest.shapeSignature !== opts.currentSignature) {
    return { ...empty, fullyInvalid: true };
  }
  const validPeriods = new Set<string>();
  const stalePeriods = new Set<string>();
  for (const [period, meta] of Object.entries(manifest.partitions)) {
    const expected = computePartitionEtagHash(opts.etagsByPeriod[period]);
    if (meta.rawEtagHash === expected) validPeriods.add(period);
    else stalePeriods.add(period);
  }
  return { validPeriods, stalePeriods, fullyInvalid: false };
}
