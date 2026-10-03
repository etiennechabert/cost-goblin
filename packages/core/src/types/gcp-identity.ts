/** Which Google identities a GCP provider's two credential paths run as.
 *
 *  A GCP sync authenticates twice: the Cloud Storage SDK lists the bucket with
 *  Application Default Credentials, and `gcloud storage rsync` downloads as
 *  gcloud's ACTIVE account (impersonating the provider's
 *  `impersonateServiceAccount` when set). The wizard's project list runs as
 *  that active account too. The two stores are changed by different commands
 *  and routinely drift apart, so these types exist to show both side by side.
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

/** Who the source of an impersonating ADC credential is — the human (or key)
 *  that must hold Service Account Token Creator on the target. */
export type GcpImpersonationSource =
  | { readonly kind: 'user'; readonly account: GcpAccountLookup }
  | { readonly kind: 'service-account'; readonly email: string }
  | { readonly kind: 'other'; readonly type: string | null };

/** The identity the Cloud Storage SDK lists buckets as. `credentialsPath` is
 *  the file that identity was read from, so a user can tell which ADC file
 *  is in play (the `GOOGLE_APPLICATION_CREDENTIALS` override, or gcloud's
 *  well-known location). */
export type GcpListingIdentity =
  /** No ADC file where the SDK looks. */
  | { readonly kind: 'not-signed-in'; readonly credentialsPath: string | null }
  /** A file exists but could not be read or parsed. */
  | { readonly kind: 'unreadable'; readonly credentialsPath: string }
  /** `gcloud auth application-default login` as a plain user. */
  | { readonly kind: 'user'; readonly credentialsPath: string; readonly account: GcpAccountLookup }
  /** `gcloud auth application-default login --impersonate-service-account=<target>`. */
  | { readonly kind: 'impersonated'; readonly credentialsPath: string; readonly source: GcpImpersonationSource; readonly target: string }
  /** A service-account key: the ADC file itself, or the provider's `keyFile`. */
  | { readonly kind: 'service-account'; readonly credentialsPath: string; readonly email: string; readonly origin: 'adc' | 'key-file' }
  /** Workload or workforce identity federation. `target` is the service
   *  account it impersonates, when the config names one. */
  | { readonly kind: 'external'; readonly credentialsPath: string; readonly target: string | null }
  /** A credential type this build does not describe. */
  | { readonly kind: 'unrecognized'; readonly credentialsPath: string; readonly type: string | null };

/** The identity `gcloud storage rsync` downloads as (and, for the wizard,
 *  `gcloud projects list` lists projects as). */
export type GcpDownloadIdentity =
  /** gcloud's active account, from `gcloud config get-value account`.
   *  `account` is null when no account is active. `impersonate` is the
   *  provider's `impersonateServiceAccount`, which the download adds as a
   *  flag; null when the provider sets none (or in the wizard, before a
   *  provider exists). */
  | { readonly kind: 'gcloud'; readonly account: string | null; readonly configuration: string | null; readonly impersonate: string | null }
  /** The provider's `keyFile` overrides gcloud's credential for the download,
   *  so the active account plays no part. `email` is null when the key file
   *  could not be read. */
  | { readonly kind: 'key-file'; readonly keyFile: string; readonly email: string | null }
  | { readonly kind: 'cli-missing' }
  | { readonly kind: 'cli-error'; readonly message: string };

/** A mismatch between the two paths that will cause a failure (or run a half
 *  of the sync as someone unexpected), in the order the panel shows them. */
export type GcpIdentityWarning =
  /** ADC impersonates a different service account than the provider names:
   *  listing reads as one service account, downloads as another. */
  | { readonly kind: 'adc-target-mismatch'; readonly adcTarget: string; readonly providerTarget: string }
  /** The provider names a service account but ADC does not impersonate one,
   *  so listing runs as the ADC identity itself. */
  | { readonly kind: 'adc-not-impersonated'; readonly providerTarget: string }
  /** gcloud's active account is not the person behind ADC: downloads and the
   *  project list run as one human, bucket listing as another. */
  | { readonly kind: 'split-accounts'; readonly listingAccount: string; readonly downloadAccount: string };

/** Something the panel cannot check but the user should, shown muted rather
 *  than as a warning: nothing is known to be wrong. */
export type GcpIdentityNote =
  /** The human behind ADC is not recorded (see `not-recorded`), so the
   *  split-accounts check cannot run. Downloads run as `downloadAccount`;
   *  `target` is the service account ADC impersonates, which that account
   *  must also be able to impersonate when the provider sets the same one. */
  | { readonly kind: 'listing-account-unrecorded'; readonly downloadAccount: string; readonly target: string | null };

export interface GcpIdentities {
  readonly listing: GcpListingIdentity;
  readonly download: GcpDownloadIdentity;
  readonly warnings: readonly GcpIdentityWarning[];
  readonly notes: readonly GcpIdentityNote[];
}

export type GcpIdentityResult =
  | { readonly status: 'ok'; readonly identities: GcpIdentities }
  | { readonly status: 'unavailable'; readonly reason: string };
