/** Which Google identities a GCP provider's two credential paths run as.
 *
 *  A GCP sync authenticates twice. The Cloud Storage SDK lists the bucket
 *  with the provider's `keyFile`, or else with Application Default
 *  Credentials — and when the provider names a read-only service account
 *  (`impersonateServiceAccount`), it impersonates that account, minted from
 *  ADC's own sign-in. `gcloud storage rsync` downloads with gcloud's own
 *  credentials — its active account, unless gcloud's `auth/*` properties
 *  override it — impersonating the provider's `impersonateServiceAccount`
 *  (or, without one, gcloud's own `auth/impersonate_service_account`). The
 *  wizard's project list runs as that same gcloud identity. The stores are
 *  changed by different commands and routinely drift apart, so these types
 *  exist to show both side by side.
 *
 *  Secret-free by construction: every field is an account email, a service
 *  account, a configuration name or a file path. Refresh tokens, client
 *  secrets, private keys and access tokens never enter these shapes — they
 *  cross IPC to the renderer. */

/** The outcome of looking up a signed-in user's email. ADC for a user holds a
 *  refresh token but not the email, so naming the account takes a round trip
 *  to Google that can fail (offline, revoked or expired sign-in). */
export type GcpAccountLookup =
  | { readonly status: 'known'; readonly email: string }
  | { readonly status: 'unknown'; readonly reason: GcpAccountLookupFailure };

/** Why an account could not be named. Classified rather than the raw error,
 *  which can quote request details.
 *
 *  `not-recorded`: the credential works but carries no email scope, so Google
 *  will not say whose it is. This is the normal state of an impersonated ADC
 *  file — `application-default login --impersonate-service-account` mints its
 *  source token with `cloud-platform` alone and writes `"account": ""`. */
export type GcpAccountLookupFailure = 'expired' | 'unreachable' | 'not-recorded';

/** A credential file and why it is the one in play — which decides the
 *  remedy when it is wrong: signing in again rewrites only the well-known
 *  file, never the one `GOOGLE_APPLICATION_CREDENTIALS` names. */
export interface GcpCredentialFile {
  readonly path: string;
  /** `env`: named by `GOOGLE_APPLICATION_CREDENTIALS`. `well-known`: gcloud's
   *  `application_default_credentials.json`. `key-file`: the provider's
   *  `keyFile`. */
  readonly origin: 'env' | 'well-known' | 'key-file';
}

/** Who the source of an impersonating credential is — the human (or key)
 *  that must hold Service Account Token Creator on the target. */
export type GcpImpersonationSource =
  | { readonly kind: 'user'; readonly account: GcpAccountLookup }
  | { readonly kind: 'service-account'; readonly email: string }
  /** Workload or workforce identity federation as ADC; `target` is the
   *  service account the federation config itself impersonates, if any. */
  | { readonly kind: 'federated'; readonly target: string | null }
  | { readonly kind: 'other'; readonly type: string | null };

/** Where a listing impersonation's target comes from. */
export type GcpListingImpersonationVia =
  /** The ADC file itself impersonates — the legacy
   *  `application-default login --impersonate-service-account` recipe — and
   *  the provider names no reader, so listing uses that file as it is. */
  | { readonly kind: 'credential' }
  /** The provider's `impersonateServiceAccount`: listing mints the target
   *  from ADC's own principal. When ADC is itself a legacy impersonated file,
   *  CostGoblin unwraps it to the login underneath (that login is `source`),
   *  and `adcTarget` is the service account the file names — which this
   *  provider does not use. */
  | { readonly kind: 'provider'; readonly adcTarget: string | null };

/** The identity the Cloud Storage SDK lists buckets as. */
export type GcpListingIdentity =
  /** No credential file where the SDK looks. `file` is null when neither
   *  `HOME` nor `APPDATA` gives the SDK anywhere to look. */
  | { readonly kind: 'not-signed-in'; readonly file: GcpCredentialFile | null }
  /** A file exists but could not be read or parsed. */
  | { readonly kind: 'unreadable'; readonly file: GcpCredentialFile }
  /** `gcloud auth application-default login` as a plain user. */
  | { readonly kind: 'user'; readonly file: GcpCredentialFile; readonly account: GcpAccountLookup }
  /** Listing reads as the service account `target`, minted from `source`:
   *  the provider's read-only service account, or (for a provider without
   *  one) the service account a legacy impersonated ADC file names. */
  | {
    readonly kind: 'impersonated';
    readonly file: GcpCredentialFile;
    readonly source: GcpImpersonationSource;
    readonly target: string;
    readonly via: GcpListingImpersonationVia;
  }
  /** A service-account key. */
  | { readonly kind: 'service-account'; readonly file: GcpCredentialFile; readonly email: string }
  /** Workload or workforce identity federation. `target` is the service
   *  account it impersonates, when the config names one. */
  | { readonly kind: 'external'; readonly file: GcpCredentialFile; readonly target: string | null }
  /** A credential type the SDK would reject, or this build cannot describe. */
  | { readonly kind: 'unrecognized'; readonly file: GcpCredentialFile; readonly type: string | null };

/** The base credential gcloud authenticates with, before any impersonation.
 *  gcloud's precedence: `auth/access_token_file`, then a credential file
 *  override (the provider's `keyFile`, else gcloud's own
 *  `auth/credential_file_override`), then the active account. */
export type GcpDownloadPrincipal =
  /** gcloud's active account (`core/account`); null when none is set.
   *  `fromEnv`: set by `CLOUDSDK_CORE_ACCOUNT` in CostGoblin's environment,
   *  which `gcloud config set account` cannot override. */
  | { readonly kind: 'account'; readonly account: string | null; readonly fromEnv: boolean }
  /** A credential file passed to gcloud. `email` is null when the file is
   *  not a readable service-account key. */
  | { readonly kind: 'key-file'; readonly path: string; readonly origin: 'provider' | 'gcloud-config'; readonly email: string | null }
  /** A pre-minted token (`auth/access_token_file`): whoever it was minted
   *  for, which gcloud does not say. */
  | { readonly kind: 'access-token-file'; readonly path: string };

/** The service account the download impersonates, and who asked for it:
 *  the provider's `impersonateServiceAccount` (passed as a flag, so it wins),
 *  or gcloud's own `auth/impersonate_service_account`. */
export interface GcpDownloadImpersonation {
  readonly target: string;
  readonly origin: 'provider' | 'gcloud-config';
}

/** The identity `gcloud storage rsync` downloads as (and, for the wizard,
 *  `gcloud projects list` lists projects as). */
export type GcpDownloadIdentity =
  | {
    readonly kind: 'gcloud';
    readonly principal: GcpDownloadPrincipal;
    readonly impersonate: GcpDownloadImpersonation | null;
    /** The active gcloud configuration's name. */
    readonly configuration: string;
  }
  | { readonly kind: 'cli-missing' }
  | { readonly kind: 'cli-error'; readonly message: string };

/** A disagreement between the two paths that will fail a sync, or run one
 *  half of it as someone unexpected. In the order the panel shows them.
 *
 *  A provider with `impersonateServiceAccount` raises none of the first
 *  three: both halves impersonate it (the download flag beats gcloud's
 *  `auth/impersonate_service_account`). They describe a provider WITHOUT a
 *  reader, and their remedy is to give it one. */
export type GcpIdentityWarning =
  /** Listing impersonates `listingTarget` through ADC itself (a legacy
   *  impersonated login, or federation), while gcloud's own
   *  `auth/impersonate_service_account` makes downloads impersonate
   *  `gcloudTarget`, a different account. */
  | { readonly kind: 'target-mismatch'; readonly listingTarget: string; readonly gcloudTarget: string }
  /** gcloud's own `auth/impersonate_service_account` makes downloads
   *  impersonate `gcloudTarget`; listing impersonates nothing.
   *  `listingFromKeyFile`: the provider's `keyFile` is behind listing, which
   *  rules out naming a reader (the two are exclusive). */
  | { readonly kind: 'listing-not-impersonated'; readonly gcloudTarget: string; readonly listingFromKeyFile: boolean }
  /** Listing impersonates `listingTarget` through ADC itself; downloads
   *  impersonate nothing, so they run as gcloud's own identity — a provider
   *  without a reader on a machine whose ADC was signed in with
   *  `--impersonate-service-account`. */
  | { readonly kind: 'download-not-impersonated'; readonly listingTarget: string }
  /** Listing and downloads start from two different principals.
   *  `listingKeyFile` is the key behind listing when that principal is a
   *  service account read from a key (gcloud can only become it through
   *  one). `sharedTarget` is the service account both halves impersonate,
   *  when they impersonate the same one — then each principal needs Token
   *  Creator on it. */
  | {
    readonly kind: 'split-accounts';
    readonly listingAccount: string;
    readonly downloadAccount: string;
    readonly listingKeyFile: GcpCredentialFile | null;
    readonly downloadAccountFromEnv: boolean;
    readonly sharedTarget: string | null;
  };

/** Something the panel cannot check but the user should, shown muted rather
 *  than as a warning: nothing is known to be wrong. */
export type GcpIdentityNote =
  /** The human behind listing is not recorded (see `not-recorded` — the
   *  login inside a legacy impersonated ADC file, whether listing uses that
   *  file's target or unwraps it to mint the provider's reader), so the
   *  split-accounts check cannot run. Downloads run as `downloadAccount`;
   *  `downloadTarget` is the service account they impersonate, which that
   *  account must be allowed to impersonate. */
  | { readonly kind: 'listing-account-unrecorded'; readonly downloadAccount: string; readonly downloadTarget: string | null };

export interface GcpIdentities {
  readonly listing: GcpListingIdentity;
  readonly download: GcpDownloadIdentity;
  /** Where `gcloud auth application-default login` would write, when that is
   *  NOT the file the SDK reads (`CLOUDSDK_CONFIG` moves the former but not
   *  the latter). Null when they agree, or when `GOOGLE_APPLICATION_CREDENTIALS`
   *  names the file. */
  readonly adcLoginPath: string | null;
  readonly warnings: readonly GcpIdentityWarning[];
  readonly notes: readonly GcpIdentityNote[];
}

export type GcpIdentityResult =
  | { readonly status: 'ok'; readonly identities: GcpIdentities }
  | { readonly status: 'unavailable'; readonly reason: string };
