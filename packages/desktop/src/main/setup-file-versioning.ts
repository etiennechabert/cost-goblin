import { isPartitionFolderName } from '@costgoblin/core';
import type { ExportFileVersioning } from '@costgoblin/core';

// How the setup wizard tells an export's File versioning setting from its S3
// layout. Overwrite delivers Parquet into the partition folder itself; Create
// new (CREATE_NEW_REPORT) adds one folder per refresh below it, which sync
// never reads (see isCreateNewDeliveryKey). Kept pure, beside setup-s3.ts,
// which does the listing.

/** One listed S3 object. */
export interface ListedObject {
  readonly key: string;
  readonly lastModified: Date | undefined;
}

/** The newest partition folder (`billing_period=YYYY-MM/` or
 *  `date=YYYY-MM-DD/`) among the common prefixes of a delimited `data/`
 *  listing. Within one family the names sort chronologically. */
export function newestPartitionFolder(folderPrefixes: readonly string[]): string | undefined {
  let newest: { prefix: string; name: string } | undefined;
  for (const prefix of folderPrefixes) {
    const name = prefix.split('/').filter(s => s.length > 0).at(-1);
    if (name === undefined || !isPartitionFolderName(name)) continue;
    if (newest === undefined || name > newest.name) newest = { prefix, name };
  }
  return newest?.prefix;
}

/** What one partition folder's delimited listing holds: Parquet of its own
 *  (in place), per-refresh subfolders, or both — an export whose setting was
 *  switched this month. */
export function partitionDeliveries(listing: {
  readonly objects: readonly ListedObject[];
  readonly folderPrefixes: readonly string[];
}): 'in-place' | 'per-refresh' | 'both' | 'none' {
  const inPlace = listing.objects.some(o => o.key.endsWith('.parquet'));
  const perRefresh = listing.folderPrefixes.length > 0;
  if (inPlace) return perRefresh ? 'both' : 'in-place';
  return perRefresh ? 'per-refresh' : 'none';
}

/** For a partition holding both kinds, the setting in force is the one that
 *  wrote last: Overwrite rewrites its in-place files on every refresh, Create
 *  new adds a folder. Takes the partition's recursive listing. A tie or a
 *  missing date favours Overwrite, the wizard's verdict before this check. */
export function newestDeliveryVersioning(partitionPrefix: string, objects: readonly ListedObject[]): ExportFileVersioning {
  let inPlace: number | undefined;
  let perRefresh: number | undefined;
  for (const object of objects) {
    if (!object.key.startsWith(partitionPrefix) || !object.key.endsWith('.parquet')) continue;
    const written = object.lastModified?.getTime() ?? 0;
    if (object.key.slice(partitionPrefix.length).includes('/')) {
      perRefresh = Math.max(perRefresh ?? written, written);
    } else {
      inPlace = Math.max(inPlace ?? written, written);
    }
  }
  if (inPlace === undefined) return perRefresh === undefined ? 'unknown' : 'create-new';
  return perRefresh !== undefined && perRefresh > inPlace ? 'create-new' : 'overwrite';
}
