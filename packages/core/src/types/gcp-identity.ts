/** Which Google accounts a GCP provider's two credential paths run as.
 *
 *  A GCP sync authenticates twice: the Cloud Storage SDK lists the bucket with
 *  Application Default Credentials (or the provider's `keyFile`), and
 *  `gcloud storage rsync` downloads as gcloud's active account (or the same
 *  `keyFile`). The wizard's project list runs as that gcloud account too. The
 *  two stores are changed by different commands and drift apart, so these
 *  types exist to show both side by side.
 *
 *  Impersonation is shown as a fact (which service account listing ends up
 *  as) but not reasoned about here — that belongs with the provider's own
 *  `impersonateServiceAccount`.
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
 *  which can quote request details. `not-recorded`: the credential works but
 *  carries no email scope, so Google will not say whose it is. */
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

/** The identity the Cloud Storage SDK lists buckets as. */
export type GcpListingIdentity =
  /** No credential file where the SDK looks. `file` is null when neither
   *  `HOME` nor `APPDATA` gives the SDK anywhere to look. */
  | { readonly kind: 'not-signed-in'; readonly file: GcpCredentialFile | null }
  /** A file exists but could not be read or parsed. */
  | { readonly kind: 'unreadable'; readonly file: GcpCredentialFile }
  /** `gcloud auth application-default login` as a plain user. */
  | { readonly kind: 'user'; readonly file: GcpCredentialFile; readonly account: GcpAccountLookup }
  /** An ADC file that impersonates `target`: listing runs as that service
   *  account. */
  | { readonly kind: 'impersonated'; readonly file: GcpCredentialFile; readonly target: string }
  /** A service-account key. */
  | { readonly kind: 'service-account'; readonly file: GcpCredentialFile; readonly email: string }
  /** Anything else the SDK accepts (identity federation) or rejects. */
  | { readonly kind: 'other'; readonly file: GcpCredentialFile; readonly type: string | null };

/** The identity `gcloud storage rsync` downloads as (and, for the wizard,
 *  `gcloud projects list` lists projects as). */
export type GcpDownloadIdentity =
  /** gcloud's active account; null when none is set. */
  | { readonly kind: 'gcloud'; readonly account: string | null; readonly configuration: string }
  /** The provider's `keyFile`, passed to gcloud as its credential. `email` is
   *  null when the file is not a readable service-account key. */
  | { readonly kind: 'key-file'; readonly path: string; readonly email: string | null }
  | { readonly kind: 'cli-missing' }
  | { readonly kind: 'cli-error'; readonly message: string };

/** Listing and downloads authenticate as two different people. */
export interface GcpSplitAccounts {
  readonly listingAccount: string;
  readonly downloadAccount: string;
}

export interface GcpIdentities {
  readonly listing: GcpListingIdentity;
  readonly download: GcpDownloadIdentity;
  /** The provider's `impersonateServiceAccount`: both halves read as it,
   *  minted from the identities above (listing from ADC, downloads from
   *  gcloud's account). Null for none, and in the wizard. */
  readonly reader: string | null;
  /** Set when listing and downloads run as two different users. */
  readonly splitAccounts: GcpSplitAccounts | null;
}

export type GcpIdentityResult =
  | { readonly status: 'ok'; readonly identities: GcpIdentities }
  | { readonly status: 'unavailable'; readonly reason: string };
