/** Classifying GCP credential failures.
 *
 *  Lives in its own leaf module — with NO imports — so the renderer can share
 *  the exact predicate the sync uses. `gcs-client.ts` pulls in node:fs and the
 *  Cloud Storage SDK, so re-exporting from there through `browser.ts` would
 *  drag node built-ins into the renderer bundle; the setup wizard previously
 *  hand-copied the message list instead and immediately drifted, losing three
 *  signatures (`invalid_rapt`, `Your credentials are invalid`, `does not have
 *  any valid credentials`) and with them the inline sign-in button on the one
 *  screen whose purpose is offering it.
 */

/** Whether an error indicates missing or expired GCP credentials rather than
 *  a genuine storage/network failure. Mirrors `isCredentialError` on the AWS
 *  side and covers both shapes the app sees: google-auth-library failures
 *  from the listing SDK, and `gcloud storage` CLI stderr from the download
 *  path.
 *
 *  Deliberately narrow on 401/403: a bare "403" from a *successful* auth
 *  handshake means the principal lacks `storage.objects.list`, which is a
 *  permissions bug the user fixes in IAM, not by re-authenticating. Only the
 *  documented credential-resolution signatures classify as credential
 *  errors. */
export function isGcpCredentialError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return (
    // google-auth-library: no ADC file, no metadata server, malformed key.
    msg.includes('Could not load the default credentials') ||
    msg.includes('Could not refresh access token') ||
    msg.includes('Unable to detect a Project Id') ||
    msg.includes('invalid_grant') ||
    msg.includes('invalid_rapt') ||
    msg.includes('Token has been expired or revoked') ||
    // `gcloud` CLI stderr, both the reauth and the never-authed cases.
    msg.includes('gcloud auth application-default login') ||
    msg.includes('gcloud auth login') ||
    msg.includes('Your credentials are invalid') ||
    msg.includes('Reauthentication failed') ||
    msg.includes('does not have any valid credentials')
  );
}

/** The principal authenticated fine but cannot ENUMERATE buckets.
 *
 *  Usually the expected outcome of the exporter README's least-privilege
 *  recipe: `roles/storage.objectViewer` is granted on the BUCKET, and listing
 *  the buckets in a project is a project-level permission — so a reader that
 *  can walk every object in the export dead-ends on the one screen before the
 *  part that works. Verified against a live reader: `storage.buckets.list` is
 *  denied while `gcloud storage ls` of the bucket, its prefixes and its
 *  `billing_period=` folders all succeed.
 *
 *  USUALLY, not always — and callers must not present it as a diagnosis. GCP
 *  returns this same sentence when the principal has no access to the project
 *  at all, and when the project does not exist; the trailing "(or it may not
 *  exist)" is Google declining to distinguish them, since saying which would
 *  leak the project's existence. That case is live here, not theoretical: the
 *  wizard lists projects with gcloud's ACTIVE ACCOUNT but lists buckets with
 *  ADC, the same split `isGcloudCliAccountError` below exists for. So a UI
 *  built on this predicate must keep the raw message reachable — it names the
 *  denied principal, which is the only evidence of which identity ran.
 *
 *  Distinct from `isGcpCredentialError`: signing in again cannot grant a
 *  permission, so the two must not share a branch.
 *
 *  Takes the MESSAGE, not an `Error`, unlike its siblings: the only caller is
 *  the setup wizard, which holds `state.error` as a string and would otherwise
 *  fabricate a throwaway `Error` on every render — including every keystroke in
 *  its filter and manual-name inputs — purely to satisfy an `instanceof` guard.
 *  One shape covers both denials the app sees: the Cloud Storage SDK names the
 *  permission in its `does not have … access` sentence and a bare API denial
 *  quotes it as `Permission '…' denied`, so matching the permission alone
 *  catches both without pretending to tell them apart. */
export function isGcpBucketListDeniedMessage(message: string): boolean {
  return message.includes('storage.buckets.list');
}

/** The user's credentials work, but may not read AS the provider's
 *  `impersonateServiceAccount`.
 *
 *  google-auth-library wraps every impersonation failure in
 *  `unable to impersonate: …`. Two of them are IAM configuration the user
 *  fixes in the console, never by signing in again: the missing
 *  `roles/iam.serviceAccountTokenCreator` grant on the reader
 *  (`iam.serviceAccounts.getAccessToken` denied), and the IAM Service Account
 *  Credentials API being disabled in the quota project. An expired source
 *  login arrives under the same prefix but names `invalid_grant` /
 *  `invalid_rapt` instead, and stays with `isGcpCredentialError`.
 *
 *  Takes the message, like `isGcpBucketListDeniedMessage`, so the wizard can
 *  call it on the string it holds. */
export function isGcpImpersonationDeniedMessage(message: string): boolean {
  if (!message.includes('unable to impersonate')) return false;
  return message.includes('iam.serviceAccounts.getAccessToken')
    || message.includes('IAM Service Account Credentials API');
}

/** The remedy for `isGcpImpersonationDeniedMessage`, in words. Deliberately
 *  free of the `GCP credentials` marker and the `Run: ` clause the sync
 *  toolbar keys its sign-in button on: signing in again cannot grant a role.
 *  The raw denial is kept — it says which of the two causes applies. */
export function describeGcpImpersonationDenied(serviceAccount: string | undefined, rawMessage: string): string {
  const reader = serviceAccount ?? 'the configured service account';
  return `CostGoblin could not read as ${reader}. Your Google account needs roles/iam.serviceAccountTokenCreator on that service account, and the IAM Service Account Credentials API (iamcredentials.googleapis.com) must be enabled. Grant the role with: gcloud iam service-accounts add-iam-policy-binding ${reader} --member=user:<your-email> --role=roles/iam.serviceAccountTokenCreator — Details: ${rawMessage}`;
}

/** The gcloud CLI's OWN sign-in is the problem, not Application Default
 *  Credentials.
 *
 *  The two halves of a GCP sync authenticate through different stores by
 *  design: the listing SDK reads ADC, while `gcloud storage rsync` runs as
 *  gcloud's ACTIVE ACCOUNT, which the app never sets. Anyone signed into both
 *  a work and a personal account routinely has the wrong one active — listing
 *  succeeds and the download fails, which is exactly what a live run against a
 *  real bucket produced.
 *
 *  Must be tested BEFORE `isGcpCredentialError`, whose `Reauthentication
 *  failed` / `gcloud auth login` markers this shares. Re-running
 *  `application-default login` cannot refresh a stale CLI account, so that
 *  advice sends the user round a loop that never terminates.
 *
 *  Scoped to the CLI failure wrapper so an SDK error can never land here. */
export function isGcloudCliAccountError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  if (!msg.includes('gcloud storage rsync failed')) return false;
  return (
    msg.includes('Reauthentication failed') ||
    msg.includes('gcloud config set account') ||
    msg.includes('do not currently have an active account') ||
    // Not a substring of `gcloud auth application-default login`, so this
    // matches only gcloud's own advice to re-authenticate the CLI.
    msg.includes('gcloud auth login')
  );
}

/** A `gcloud storage rsync` download that failed without an explicit
 *  credential signature — retries exhausted, connection reset. Sister of
 *  `isS3SyncDownloadFailure`: for an ADC-backed bucket this is usually an
 *  expired session, but it can equally be a network drop, so callers surface
 *  a "session may have expired, or check your connection" hint rather than a
 *  definite credential error. Scoped to the CLI failure message so it never
 *  misclassifies an SDK error. */
export function isGcloudDownloadFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  if (!msg.includes('gcloud storage rsync failed')) return false;
  return (
    msg.includes('Max retries exceeded') ||
    msg.includes('Connection reset') ||
    msg.includes('Could not reach') ||
    msg.includes('ServiceUnavailable') ||
    // A bare `includes('503')` matched any three digits anywhere in the
    // captured stderr. BigQuery names its shards with twelve zero-padded
    // digits, so a genuine 403 naming `shard-000000000503.parquet` — or a
    // gcloud traceback's `line 503,` — was reported as an expired session,
    // sending the user to re-authenticate for a permissions problem that
    // re-authenticating cannot fix. Require the status code as its own token
    // AND unavailability wording beside it.
    (/\b503\b/.test(msg) && /unavailable|backend error|try again/i.test(msg))
  );
}
