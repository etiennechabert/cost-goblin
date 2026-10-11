import { isPartitionFolderName } from '@costgoblin/core';
import type { ExportFileVersioning } from '@costgoblin/core';

// How the setup wizard tells an export's File versioning setting from its S3
// layout. Overwrite delivers Parquet into the partition folder itself; Create
// new (CREATE_NEW_REPORT) adds one folder per refresh below it, which sync
// never reads (see isCreateNewDeliveryKey). Kept pure, beside setup-s3.ts,
// which does the listing.

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

/** The File versioning one partition folder's delimited listing shows. Any
 *  Parquet of its own means Overwrite, even beside per-refresh folders: an
 *  export switched to Overwrite mid-month delivers in place from then on. */
export function classifyFileVersioning(listing: {
  readonly fileKeys: readonly string[];
  readonly folderPrefixes: readonly string[];
}): ExportFileVersioning {
  if (listing.fileKeys.some(k => k.endsWith('.parquet'))) return 'overwrite';
  if (listing.folderPrefixes.length > 0) return 'create-new';
  return 'unknown';
}
