import type { BucketPath, DimensionId } from './branded.js';

export type NormalizationRule = 'lowercase' | 'uppercase' | 'lowercase-kebab' | 'lowercase-underscore' | 'camelCase';

export type ConceptType = 'owner' | 'product' | 'environment';

export interface ProviderConfig {
  readonly name: string;
  readonly type: 'aws';
  readonly credentials: AwsCredentials;
  readonly sync: SyncConfig;
}

export interface AwsCredentials {
  readonly profile: string;
}

export interface SyncConfig {
  readonly daily: SyncTierConfig;
  readonly hourly?: SyncTierConfig | undefined;
  readonly costOptimization?: SyncTierConfig | undefined;
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
}

export interface TagDimension {
  readonly tagName: string;
  readonly label: string;
  readonly concept?: ConceptType | undefined;
  readonly normalize?: NormalizationRule | undefined;
  readonly separator?: string | undefined;
  readonly aliases?: Readonly<Record<string, readonly string[]>> | undefined;
  readonly accountTagFallback?: string | undefined;
  readonly missingValueTemplate?: string | undefined;
  /** Hidden from selectors/filter bar when false. Default true. */
  readonly enabled?: boolean | undefined;
  /** Short user-facing explanation shown on the Dimensions view. */
  readonly description?: string | undefined;
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
