import type { CostScopeConfig } from './cost-scope.js';
import type { DefaultsConfig, DimensionsConfig, OrgTreeConfig, SyncConfig } from './config.js';
import type { ViewsConfig } from './views.js';

/** Discriminator value in the bundle YAML so arbitrary YAML files are
 *  rejected with a clear message instead of a cryptic validation error. */
export const CONFIG_BUNDLE_KIND = 'costgoblin-config-bundle';

/** Bumped when the bundle layout changes incompatibly. Parsers refuse
 *  newer versions (ask the user to update the app) and migrate older
 *  ones when possible. */
export const CONFIG_BUNDLE_SCHEMA_VERSION = 1;

/** Well-known S3 key (relative to the bucket root) where a team's shared
 *  configuration bundle is published. Anyone with read access to the CUR
 *  bucket — i.e. anyone who can already see the billing data — can fetch
 *  it, so access control rides on the IAM permissions the user must have
 *  anyway. */
export const CONFIG_BEACON_KEY = 'costgoblin/org-config.yaml';

/** A provider as it appears inside a bundle: identical to
 *  `ProviderConfig` minus `credentials`. Bundles structurally cannot
 *  carry an AWS profile name — it's machine-specific and the receiver
 *  picks their own on import. */
export interface SharedProviderConfig {
  readonly name: string;
  readonly type: 'aws';
  readonly sync: SyncConfig;
}

/** `CostGoblinConfig` with the machine-specific parts stripped. */
export interface SharedCostGoblinConfig {
  readonly providers: readonly SharedProviderConfig[];
  readonly defaults: DefaultsConfig;
}

export type BundleSectionId = 'config' | 'dimensions' | 'orgTree' | 'costScope' | 'views';

/** The shareable configuration surface. `config` and `dimensions` are
 *  mandatory — a bundle without them couldn't bootstrap a working app.
 *  The rest are included only when present on the exporting machine. */
export interface ConfigBundleSections {
  readonly config: SharedCostGoblinConfig;
  readonly dimensions: DimensionsConfig;
  readonly orgTree?: OrgTreeConfig | undefined;
  readonly costScope?: CostScopeConfig | undefined;
  readonly views?: ViewsConfig | undefined;
}

export interface ConfigBundle {
  readonly schemaVersion: number;
  readonly appVersion: string;
  readonly exportedAt: string;
  /** SHA-256 (hex) over the canonical JSON form of `sections`. Lets two
   *  colleagues compare bundles out-of-band and flags files edited after
   *  export. A mismatch is surfaced as a warning, not a hard failure. */
  readonly fingerprint: string;
  readonly sections: ConfigBundleSections;
}

/** Human-readable digest of a parsed bundle, shown on the import preview
 *  so the user can see exactly what will be applied before confirming. */
export interface ConfigBundleSummary {
  readonly schemaVersion: number;
  readonly appVersion: string;
  readonly exportedAt: string;
  readonly fingerprint: string;
  /** False when the file content no longer matches its fingerprint
   *  (edited after export). */
  readonly fingerprintValid: boolean;
  readonly sections: readonly BundleSectionId[];
  readonly providers: readonly { readonly name: string; readonly dailyBucket: string }[];
  readonly builtInDimensionCount: number;
  readonly tagDimensionCount: number;
  readonly orgTreeNodeCount: number;
  readonly exclusionRuleCount: number;
  readonly viewCount: number;
}

export type ExportConfigBundleResult =
  | { readonly status: 'saved'; readonly path: string }
  | { readonly status: 'canceled' }
  | { readonly status: 'error'; readonly message: string };

export type PreviewConfigBundleResult =
  | { readonly status: 'ok'; readonly content: string; readonly summary: ConfigBundleSummary }
  | { readonly status: 'canceled' }
  | { readonly status: 'error'; readonly message: string };

export interface ApplyConfigBundleParams {
  /** Raw bundle file content. Re-parsed and re-validated in the main
   *  process — the renderer is never trusted to have done so. */
  readonly content: string;
  /** AWS profile to inject into every imported provider. */
  readonly profile: string;
}

export type ApplyConfigBundleResult =
  | { readonly status: 'applied'; readonly sections: readonly BundleSectionId[]; readonly backupDir: string | null }
  | { readonly status: 'error'; readonly message: string };

export type PublishConfigBundleResult =
  | { readonly status: 'published'; readonly location: string }
  | { readonly status: 'error'; readonly message: string };

export interface CheckConfigBeaconParams {
  readonly profile: string;
  readonly bucket: string;
}

export type CheckConfigBeaconResult =
  | { readonly status: 'found'; readonly location: string; readonly content: string; readonly summary: ConfigBundleSummary }
  | { readonly status: 'none' }
  | { readonly status: 'error'; readonly message: string };

// ---------------------------------------------------------------------------
// Peer data sharing — LAN, TLS-PSK (see packages/core/src/peer/). Lets a
// teammate with zero AWS access pull a teammate's billing data + config from
// one pasted "sharing key", with no S3 and no server.
// ---------------------------------------------------------------------------

/** Publisher-side state. When `enabled`, `sharingKey` is the CGSHARE1 token a
 *  teammate pastes to connect — it packs the host(s), port, this machine's
 *  public key, and the access secret. */
export interface DataSharingStatus {
  readonly enabled: boolean;
  readonly sharingKey: string | null;
  readonly label: string;
  readonly port: number | null;
  readonly hosts: readonly string[];
  /** Short fingerprint of this machine's identity, for out-of-band comparison. */
  readonly fingerprint: string | null;
}

export type DataSharingResult =
  | { readonly status: 'ok'; readonly sharing: DataSharingStatus }
  | { readonly status: 'error'; readonly message: string };

/** Consumer-side: the single shared source this machine pulls from. */
export interface SharedSourceInfo {
  readonly label: string;
  readonly fingerprint: string;
  readonly host: string;
  readonly port: number;
  readonly lastPulledAt: string | null;
  readonly periods: readonly string[];
}

export type PullSharedSourceResult =
  | { readonly status: 'ok'; readonly source: SharedSourceInfo; readonly filesDownloaded: number }
  | { readonly status: 'error'; readonly message: string };
