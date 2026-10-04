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
  createGcsHandle,
  isGcloudCliAccountError,
  isGcloudDownloadFailure,
  isGcpBucketListDeniedMessage,
  isGcpCredentialError,
  parseGcsPath,
} from './gcs-client.js';

export { describeGcpImpersonationFailure, isGcpImpersonationError, isGcpNetworkError } from './gcp-credential-errors.js';

export {
  type GcsStorageOptions,
  GCS_READ_ONLY_SCOPE,
  createGcsStorage,
} from './gcs-storage.js';

export {
  type AccountLookupFn,
  type AuthorizedUserSecret,
  type CredentialFileSummary,
  type GcloudConfigValues,
  type GcloudEnvFacts,
  type GcpProviderCredentialOptions,
  type ParsedAdc,
  type ParsedAdcSource,
  activeGcloudConfigPath,
  activeGcloudConfiguration,
  adcCredentialsLocation,
  adcLoginImpersonationToKeep,
  adcLoginPath,
  applyProviderImpersonation,
  assembleDownloadIdentity,
  classifyAccountLookupError,
  credentialEmail,
  displayablePath,
  emailFromIdToken,
  gcloudConfigDir,
  gcloudEnvFacts,
  gcloudImpersonationSetting,
  gcloudTokenWins,
  gcpIdentityNotes,
  gcpIdentityWarnings,
  grantsEmailScope,
  isPathPlaceholder,
  looksLikeFilePath,
  parseAdcJson,
  parseGcloudConfigList,
  resolveListingIdentity,
  summarizeCredentialFile,
} from './gcp-identity.js';

export {
  type ImpersonatedAdc,
  type ImpersonatedAdcSource,
  classifyImpersonatedAdc,
} from './gcp-adc-classify.js';

export {
  GCS_BUCKET_NAME_RULES,
  assertValidGcsBucketName,
  isValidGcsBucketName,
  splitGcsLocation,
} from './gcs-bucket-name.js';

export {
  type BillingPeriod,
  type DataInventory,
  getDataInventory,
  getLocalDataInventory,
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
} from './gcp-selective-sync.js';

// The generic resolver and the raw candidate lists stay module-private: the
// vetted per-CLI finders are the only public entry points, so no consumer can
// bypass the trusted lists with its own.
export {
  findAwsCli,
  findGcloudCli,
  findGhCli,
  findGitCli,
  gcloudChildPath,
  gcloudSpawnShape,
} from './trusted-binaries.js';

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

export { type ExpectedDataType, getRawDirPrefix } from './tiers.js';

export {
  extractDate,
  extractPeriod,
  extractPeriodPrefix,
  groupByPeriod,
  hasSyncedTier,
  ifExists,
  listLocalMonths,
  LocalSyncStateError,
  pruneEtagPeriod,
  readEtags,
  resolveBucketPath,
  saveEtags,
} from './sync-utils.js';
