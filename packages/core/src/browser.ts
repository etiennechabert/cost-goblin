export * from './types/index.js';
export type {
  TelemetryPreferences,
  TelemetryStatus,
  TelemetryEventKind,
  TelemetryOutboxEntry,
} from './telemetry/types.js';
export { TELEMETRY_DEFAULTS, isTelemetryEnabled } from './telemetry/types.js';
export * from './normalize/index.js';
export * from './models/index.js';
export { QUERY_CANCELLED_MESSAGE } from './query/cancellation.js';
export { validateViews } from './config/views-validator.js';
export { widgetToYaml, viewToYaml, viewsConfigToYaml } from './config/views-serialize.js';
export { ConfigValidationError } from './config/validator.js';
export { GCLOUD_ADC_LOGIN_COMMAND, GCLOUD_CLI_LOGIN_COMMAND } from './config/credential-commands.js';
// The wizard renders a GCS listing's classification and enforces the same
// tier-overlap rule the config validator applies at load time. Imported from
// the leaf module rather than the sync barrel, which pulls in node built-ins
// the renderer bundle must not see.
export type { GcsFolderKind, GcsTier } from './sync/gcs-export-layout.js';
export { gcsTiersOverlap } from './sync/gcs-export-layout.js';
// The wizard classifies GCP errors to decide whether to offer an inline
// sign-in. Same leaf-module reasoning: never re-export this from
// `gcs-client.ts`, which imports node:fs and the Cloud Storage SDK.
export { isGcpCredentialError } from './sync/gcp-credential-errors.js';
export { isDiscoverableBeaconLocation, splitS3Location, suggestedConfigBeaconLocation } from './config/sharing-location.js';
export { DEFAULT_COST_SCOPE, DEFAULT_MARKETPLACE_ATTRIBUTION, BUILTIN_EXCLUSION_RULES } from './config/cost-scope-seed.js';
export {
  DEFAULT_WORKSPACE_NAME,
  RESERVED_WORKSPACE_NAMES,
  WORKSPACE_NAME_PATTERN,
  WorkspaceNameError,
  isValidWorkspaceName,
  parseWorkspaceName,
} from './config/workspace-name.js';
export {
  PROVIDER_NAME_PATTERN,
  RESERVED_PROVIDER_NAMES,
  ProviderNameError,
  isValidProviderName,
  parseProviderName,
} from './config/provider-name.js';
export type {
  RollupGrainEstimate,
  RollupDimEstimate,
  RollupCurrentStats,
  RollupRawStats,
  RollupSizeBand,
  RollupRebuildBand,
} from './rollup/estimator.js';
export { computeRollupEstimate, emptyRollupEstimate, classifySizeBand } from './rollup/estimator.js';
export { runRateSeries } from './baseline/window.js';
