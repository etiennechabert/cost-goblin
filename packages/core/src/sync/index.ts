export {
  type ManifestFileEntry,
  type SyncManifest,
  type SyncState,
  createEmptySyncState,
  diffManifests,
} from './manifest.js';

export {
  type S3SyncOptions,
  type S3EndpointOptions,
  type SyncProgress,
  type ProgressCallback,
  type S3Handle,
  createS3Handle,
  parseS3Path,
  isCredentialError,
  isS3SyncDownloadFailure,
} from './s3-client.js';

export {
  type DownloadOptions,
  type ObjectStoreHandle,
  type ProviderAuth,
  createObjectStoreHandle,
  isProviderAuth,
  parseObjectPath,
  providerAuth,
} from './object-store.js';

export {
  GCS_READ_ONLY_SCOPE,
  createGcsHandle,
  isGcloudCliAccountError,
  isGcloudDownloadFailure,
  isGcpBucketListDeniedMessage,
  isGcpCredentialError,
  parseGcsPath,
} from './gcs-client.js';

export {
  type BillingPeriod,
  type DataInventory,
  getDataInventory,
  getLocalDataInventory,
  hasSyncedTier,
} from './data-inventory.js';

export {
  readSyncTimestamps,
  readTierLastSync,
  writeTierLastSync,
} from './sync-timestamps.js';

export {
  type SelectiveSyncOptions,
  syncSelectedFiles,
} from './selective-sync.js';

export {
  type GcpSelectiveSyncOptions,
  parseGcloudCompletedBytes,
  syncGcpSelectedFiles,
  findGcloudCli,
  gcloudCliFound,
  gcloudSearchPaths,
} from './gcp-selective-sync.js';

export {
  type CanonicalizeConnection,
  type CanonicalizeOptions,
  type CanonicalizeResult,
  GcpCanonicalizeError,
  canonicalizeGcpPeriod,
} from './gcp-canonicalize.js';

export { REQUIRED_FOCUS_COLUMNS } from './focus-contract.js';

export {
  type GcsFolderKind,
  type GcsTier,
  classifyGcsFolder,
  gcsTiersOverlap,
  isBillingPeriodFolder,
  parseBillingPeriod,
} from './gcs-export-layout.js';

export {
  type TierRetention,
  DEFAULT_RETENTION_DAYS,
  retentionCutoffPeriod,
  periodsOutsideRetention,
  configuredTierRetentions,
} from './retention.js';

export {
  providerEtagPath,
  providerMetaDir,
  providerRawDir,
  providerRollupDir,
  providerRoot,
} from './provider-paths.js';

export {
  type ExpectedDataType,
  extractDate,
  extractPeriod,
  extractPeriodPrefix,
  getEtagFileName,
  getRawDirPrefix,
  groupByPeriod,
  listLocalMonths,
  parseEtagsJson,
  resolveBucketPath,
  saveEtags,
} from './sync-utils.js';
