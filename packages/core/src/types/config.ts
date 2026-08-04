import type { BucketPath, DimensionId, ProviderName } from './branded.js';

export type NormalizationRule = 'lowercase' | 'uppercase' | 'lowercase-kebab' | 'lowercase-underscore' | 'camelCase';

export type ConceptType = 'owner' | 'product' | 'environment' | 'unit';

/** One AWS billing source (a payer account's FOCUS 1.2 Data Export). A profile can
 *  configure several — e.g. two payer accounts — each identified by its
 *  instance `name`, which keys the on-disk layout
 *  (`{dataDir}/{name}/raw|rollup|meta`). `credentialsProfile` is the
 *  `~/.aws/config` entry used for S3/Organizations/SSM access (named to
 *  avoid colliding with the workspace/profile concept from #518). */
export interface AwsProviderConfig {
  readonly name: ProviderName;
  readonly type: 'aws';
  readonly credentialsProfile: string;
  readonly sync: SyncConfig;
}

/** One GCP billing source: a GCS bucket fed by the user-deployed exporter
 *  that pushes the native FOCUS 1.2 BigQuery export into
 *  `gs://…/billing_period=YYYY-MM/` folders (see `scripts/gcp-focus-exporter`).
 *  `keyFile` is an optional path to a service-account JSON key; when absent
 *  the adapter authenticates with Application Default Credentials
 *  (`gcloud auth application-default login`), which is the documented
 *  default. */
export interface GcpProviderConfig {
  readonly name: ProviderName;
  readonly type: 'gcp';
  readonly keyFile?: string | undefined;
  /** Service account to impersonate, e.g.
   *  `costgoblin-reader@my-project.iam.gserviceaccount.com`.
   *
   *  The least-privilege option, and the one to prefer: it needs no
   *  long-lived key on disk. Establish it once with
   *  `gcloud auth application-default login --impersonate-service-account=<sa>`
   *  — that covers the listing SDK, which reads ADC — and this field passes
   *  the same identity to the `gcloud storage rsync` download, which uses
   *  gcloud's own credentials rather than ADC and would otherwise run as the
   *  signed-in user. */
  readonly impersonateServiceAccount?: string | undefined;
  readonly sync: GcpSyncConfig;
}

/** Discriminated union on `type`. Consumers must switch on `type` rather
 *  than assume AWS — `credentialsProfile` exists only on the `aws` arm and
 *  `keyFile` only on the `gcp` one. */
export type ProviderConfig = AwsProviderConfig | GcpProviderConfig;

export interface SyncConfig {
  readonly daily: SyncTierConfig;
  readonly hourly?: SyncTierConfig | undefined;
  readonly costOptimization?: SyncTierConfig | undefined;
  readonly intervalMinutes: number;
}

/** GCP syncs the daily tier only: the FOCUS export has no hourly delivery
 *  and no Cost-Optimization-Hub analogue. `hourly`/`costOptimization` are
 *  declared as always-`undefined` rather than omitted so tier-generic code
 *  (`resolveBucketPath`, the retention sweep) can read them off a
 *  `ProviderConfig` without first narrowing the arm — the type says
 *  "structurally present, never configured". */
export interface GcpSyncConfig {
  readonly daily: SyncTierConfig;
  readonly hourly?: undefined;
  readonly costOptimization?: undefined;
  readonly intervalMinutes: number;
}

export interface SyncTierConfig {
  readonly bucket: BucketPath;
  readonly retentionDays: number;
}

export interface DefaultsConfig {
  readonly periodDays: number;
  readonly costMetric: string;
  readonly lagDays: number;
}

export interface CostGoblinConfig {
  readonly providers: readonly ProviderConfig[];
  readonly defaults: DefaultsConfig;
}

export interface BuiltInDimension {
  readonly name: DimensionId;
  readonly label: string;
  readonly field: string;
  readonly displayField?: string | undefined;
  /** Hidden from selectors/filter bar when false. Default true. */
  readonly enabled?: boolean | undefined;
  /** Short user-facing explanation shown on the Dimensions view. */
  readonly description?: string | undefined;
  /** Applied to field values at query time (same as tags). */
  readonly normalize?: NormalizationRule | undefined;
  /** Canonical → raw values mapping, applied at query time. */
  readonly aliases?: Readonly<Record<string, readonly string[]>> | undefined;
  /** Account-specific: when true, resolve id→name via org-accounts.json
   *  (AWS Organizations sync) instead of the legacy CSV mapping. */
  readonly useOrgAccounts?: boolean | undefined;
  /** Account-specific: when set, resolve id→name by reading this account-level
   *  tag from the AWS Organizations sync instead of the account's Name field.
   *  Implies the org-sync source; falls back to the Name field when the tag
   *  is missing on a given account. */
  readonly accountNameFromTag?: string | undefined;
  /** Account-specific: regexes (one per array entry) applied to each resolved
   *  name with empty-string replacement. Lets the user strip noise like
   *  trailing " production" or a common org prefix. Invalid patterns are
   *  silently skipped; result is whitespace-collapsed and trimmed. */
  readonly nameStripPatterns?: readonly string[] | undefined;
  /** Region-specific: when true, resolve raw region codes (eu-central-1) to
   *  friendly names (Europe (Frankfurt)) via the SSM global-infrastructure
   *  snapshot. No-op if the snapshot hasn't been synced. */
  readonly useRegionNames?: boolean | undefined;
  /** Values pre-applied to the global filter bar when a view opens. The
   *  user can override or clear during a session; next view-open the
   *  default is re-applied. Stored as the post-normalize/alias-resolved
   *  values that flow through `FilterMap`. */
  readonly defaultFilterValues?: readonly string[] | undefined;
}

/** Sentinel value usable wherever an account-level tag key is expected
 *  (`TagDimension.accountTagFallback`, `BuiltInDimension.accountNameFromTag`)
 *  to mean "use the account's OU Path from the AWS Organizations sync"
 *  instead of an account-level tag value. */
export const OU_PATH_SOURCE_KEY = '__ouPath__';

export interface TagDimension {
  /** Resource tag key (without the `user_` prefix). When omitted, the
   *  dimension is sourced purely from `accountTagFallback` (which may be
   *  the OU Path sentinel) — useful for account-level concepts like
   *  Department/BU that don't appear on individual resources. */
  readonly tagName?: string | undefined;
  readonly label: string;
  readonly concept?: ConceptType | undefined;
  readonly normalize?: NormalizationRule | undefined;
  readonly separator?: string | undefined;
  readonly aliases?: Readonly<Record<string, readonly string[]>> | undefined;
  readonly accountTagFallback?: string | undefined;
  readonly missingValueTemplate?: string | undefined;
  /** When set, the resolved value is split by `separator` and only the
   *  `index`-th part (1-based; negative counts from the end, -1 = last)
   *  is emitted. Applied after the resource-tag/account-fallback COALESCE
   *  so every downstream consumer (group-by, filters, preview) sees only
   *  the segmented value. */
  readonly pathSegment?: { readonly separator: string; readonly index: number } | undefined;
  /** Hidden from selectors/filter bar when false. Default true. */
  readonly enabled?: boolean | undefined;
  /** Short user-facing explanation shown on the Dimensions view. */
  readonly description?: string | undefined;
  /** Values pre-applied to the global filter bar when a view opens. The
   *  user can override or clear during a session; next view-open the
   *  default is re-applied. */
  readonly defaultFilterValues?: readonly string[] | undefined;
}

export interface DimensionsConfig {
  readonly builtIn: readonly BuiltInDimension[];
  readonly tags: readonly TagDimension[];
  /** Unified display order for the Dimensions view and any UI that lists
   *  enabled dims. Each entry is a stable ID: `builtin:<name>` for a
   *  built-in dim or `tag:<tagName>` for a tag dim. Only enabled dims
   *  should appear here — disabling removes, re-enabling appends at the
   *  end. When undefined (legacy configs), the UI falls back to
   *  built-ins-first-then-tags. Downstream consumers (query builder,
   *  filter resolution) look dims up by name and don't consult this. */
  readonly order?: readonly string[] | undefined;
}

export interface OrgNode {
  readonly name: string;
  readonly virtual?: true | undefined;
  readonly children?: readonly OrgNode[] | undefined;
}

export interface OrgTreeConfig {
  readonly tree: readonly OrgNode[];
}
