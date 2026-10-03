import { posix, win32 } from 'node:path';
import { isStringRecord, parseJsonArray } from '../utils/json.js';
import type {
  GcpAccountLookup,
  GcpAccountLookupFailure,
  GcpDownloadIdentity,
  GcpIdentityNote,
  GcpIdentityWarning,
  GcpImpersonationSource,
  GcpListingIdentity,
} from '../types/gcp-identity.js';

/** Pure half of "which identities does a GCP provider run as": reading the
 *  Application Default Credentials file the Cloud Storage SDK uses, the
 *  gcloud CLI's `config` output, and deciding when the two disagree. The I/O
 *  — reading files, spawning gcloud, the one network round trip that names a
 *  user — lives in the desktop main process and is injected here, so every
 *  rule below is testable against fixture JSON.
 *
 *  The one secret this module touches is a user ADC's refresh credential,
 *  carried in `AuthorizedUserSecret` only far enough to hand to the injected
 *  lookup. Nothing it returns as a `GcpListingIdentity` holds a secret. */

/** What minting a token for a user ADC needs. Internal to the main process:
 *  never part of a `GcpListingIdentity`, never sent over IPC. */
export interface AuthorizedUserSecret {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
}

/** The source credential of an impersonating ADC file. */
export type ParsedAdcSource =
  | { readonly kind: 'user'; readonly account: string | null; readonly secret: AuthorizedUserSecret | null }
  | { readonly kind: 'service-account'; readonly email: string }
  | { readonly kind: 'other'; readonly type: string | null };

/** An ADC file, described. Mirrors the `type` dispatch google-auth-library's
 *  `GoogleAuth.fromJSON` performs, so what the panel says is what the SDK
 *  will do. */
export type ParsedAdc =
  | { readonly kind: 'user'; readonly account: string | null; readonly secret: AuthorizedUserSecret | null }
  | { readonly kind: 'impersonated'; readonly source: ParsedAdcSource; readonly target: string }
  | { readonly kind: 'service-account'; readonly email: string }
  | { readonly kind: 'external'; readonly target: string | null }
  | { readonly kind: 'unrecognized'; readonly type: string | null };

/** google-auth-library refuses longer impersonation URLs (a ReDoS guard); a
 *  URL it would reject must not be described as working here. */
const MAX_IMPERSONATION_URL_LENGTH = 256;

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The target service account of an IAM Credentials impersonation URL — the
 *  same extraction `GoogleAuth.fromImpersonatedJSON` performs. */
export function impersonationTargetFromUrl(url: unknown): string | null {
  if (typeof url !== 'string' || url.length > MAX_IMPERSONATION_URL_LENGTH) return null;
  const match = /\/serviceAccounts\/([^/]+):(?:generateAccessToken|generateIdToken)$/.exec(url);
  return match?.[1] ?? null;
}

function parseUserSecret(record: Readonly<Record<string, unknown>>): AuthorizedUserSecret | null {
  const clientId = nonEmptyString(record['client_id']);
  const clientSecret = nonEmptyString(record['client_secret']);
  const refreshToken = nonEmptyString(record['refresh_token']);
  if (clientId === null || clientSecret === null || refreshToken === null) return null;
  return { clientId, clientSecret, refreshToken };
}

function parseSource(raw: unknown): ParsedAdcSource {
  if (!isStringRecord(raw)) return { kind: 'other', type: null };
  const type = nonEmptyString(raw['type']);
  if (type === 'authorized_user') {
    return { kind: 'user', account: nonEmptyString(raw['account']), secret: parseUserSecret(raw) };
  }
  const email = type === 'service_account' ? nonEmptyString(raw['client_email']) : null;
  if (email !== null) return { kind: 'service-account', email };
  return { kind: 'other', type };
}

/** Describe a parsed ADC file. Null when the payload is not a JSON object at
 *  all — the caller reports that as an unreadable file. */
export function parseAdcJson(raw: unknown): ParsedAdc | null {
  if (!isStringRecord(raw)) return null;
  const type = nonEmptyString(raw['type']);
  switch (type) {
    case 'authorized_user':
      // gcloud writes `account` on some versions (often as ''); when present
      // it names the user without a network round trip.
      return { kind: 'user', account: nonEmptyString(raw['account']), secret: parseUserSecret(raw) };
    case 'impersonated_service_account': {
      const target = impersonationTargetFromUrl(raw['service_account_impersonation_url']);
      if (target === null) return { kind: 'unrecognized', type };
      return { kind: 'impersonated', target, source: parseSource(raw['source_credentials']) };
    }
    case 'service_account': {
      const email = nonEmptyString(raw['client_email']);
      return email === null ? { kind: 'unrecognized', type } : { kind: 'service-account', email };
    }
    case 'external_account':
      return { kind: 'external', target: impersonationTargetFromUrl(raw['service_account_impersonation_url']) };
    default:
      return { kind: 'unrecognized', type };
  }
}

/** `client_email` of a service-account key file, for a provider's `keyFile`.
 *  Reads nothing else — the private key is never looked at. */
export function parseServiceAccountKeyEmail(raw: unknown): string | null {
  if (!isStringRecord(raw) || raw['type'] !== 'service_account') return null;
  return nonEmptyString(raw['client_email']);
}

/** Where the Cloud Storage SDK will look for ADC, mirroring
 *  google-auth-library 9: `GOOGLE_APPLICATION_CREDENTIALS` (or its lowercase
 *  form) when non-empty — and then ONLY that file, it does not fall through —
 *  else the well-known file under `%APPDATA%` on Windows or `$HOME/.config`
 *  elsewhere. `CLOUDSDK_CONFIG` is deliberately not consulted: the SDK
 *  ignores it, even though `gcloud auth application-default login` writes
 *  there, and the point of the panel is to say what the SDK will read. Null
 *  when neither root is set. Pure — existence is the caller's check. */
export function adcCredentialsLocation(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): { readonly path: string; readonly origin: 'env' | 'well-known' } | null {
  const fromEnv = nonEmptyString(env['GOOGLE_APPLICATION_CREDENTIALS']) ?? nonEmptyString(env['google_application_credentials']);
  if (fromEnv !== null) return { path: fromEnv, origin: 'env' };
  if (platform === 'win32') {
    const appData = nonEmptyString(env['APPDATA']);
    return appData === null ? null : { path: win32.join(appData, 'gcloud', 'application_default_credentials.json'), origin: 'well-known' };
  }
  const home = nonEmptyString(env['HOME']);
  return home === null ? null : { path: posix.join(home, '.config', 'gcloud', 'application_default_credentials.json'), origin: 'well-known' };
}

/** Markers of a refresh that failed because the sign-in itself is dead, as
 *  opposed to the network. */
const EXPIRED_MARKERS = ['invalid_grant', 'invalid_rapt', 'reauth', 'expired or revoked', 'invalid_client', 'unauthorized_client'];

/** Classify a failed account lookup. The raw error is dropped on purpose: a
 *  gaxios error can quote the request it failed on. */
export function classifyAccountLookupError(err: unknown): GcpAccountLookupFailure {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return EXPIRED_MARKERS.some(marker => message.includes(marker)) ? 'expired' : 'unreachable';
}

/** Names a user from a refresh credential — one round trip to Google, done by
 *  the caller (google-auth-library in the main process). */
export type AccountLookupFn = (secret: AuthorizedUserSecret) => Promise<GcpAccountLookup>;

async function lookupUser(account: string | null, secret: AuthorizedUserSecret | null, lookup: AccountLookupFn): Promise<GcpAccountLookup> {
  if (account !== null) return { status: 'known', email: account };
  // A user ADC with no refresh token cannot mint anything; the remedy is the
  // same as for a revoked one — sign in again.
  if (secret === null) return { status: 'unknown', reason: 'expired' };
  try {
    return await lookup(secret);
  } catch (err: unknown) {
    return { status: 'unknown', reason: classifyAccountLookupError(err) };
  }
}

/** The listing identity for a parsed ADC file (`null`: the file did not
 *  parse). Never rejects: a failed lookup becomes an unknown account. */
export async function resolveListingIdentity(
  parsed: ParsedAdc | null,
  credentialsPath: string,
  lookup: AccountLookupFn,
): Promise<GcpListingIdentity> {
  if (parsed === null) return { kind: 'unreadable', credentialsPath };
  switch (parsed.kind) {
    case 'user':
      return { kind: 'user', credentialsPath, account: await lookupUser(parsed.account, parsed.secret, lookup) };
    case 'impersonated': {
      const { source } = parsed;
      const resolvedSource: GcpImpersonationSource = source.kind === 'user'
        ? { kind: 'user', account: await lookupUser(source.account, source.secret, lookup) }
        : source;
      return { kind: 'impersonated', credentialsPath, target: parsed.target, source: resolvedSource };
    }
    case 'service-account':
      return { kind: 'service-account', credentialsPath, email: parsed.email, origin: 'adc' };
    case 'external':
      return { kind: 'external', credentialsPath, target: parsed.target };
    case 'unrecognized':
      return { kind: 'unrecognized', credentialsPath, type: parsed.type };
  }
}

/** The `email` claim of an OpenID Connect id_token, decoded locally. Only
 *  used to display who signed in — the token came straight from Google's
 *  token endpoint over TLS, so the signature is not what is being trusted. */
export function emailFromIdToken(idToken: string): string | null {
  const payload = idToken.split('.')[1];
  if (payload === undefined || payload.length === 0) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return isStringRecord(claims) ? nonEmptyString(claims['email']) : null;
  } catch {
    return null;
  }
}

/** `gcloud config get-value <prop>` stdout: the value, or null when unset
 *  (gcloud prints nothing, or `(unset)` on some versions). */
export function parseGcloudConfigValue(stdout: string): string | null {
  const value = stdout.trim();
  return value.length === 0 || value === '(unset)' ? null : value;
}

/** The active configuration's name from
 *  `gcloud config configurations list --format=json`. */
export function parseActiveGcloudConfiguration(stdout: string): string | null {
  const entries = parseJsonArray(stdout);
  if (entries === null) return null;
  for (const entry of entries) {
    if (isStringRecord(entry) && entry['is_active'] === true) return nonEmptyString(entry['name']);
  }
  return null;
}

function samePrincipal(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** The service account the listing path ends up as, or null when it uses its
 *  own identity directly. Undefined when ADC is absent or opaque, so no
 *  impersonation claim can be made. */
function listingImpersonation(listing: GcpListingIdentity): string | null | undefined {
  switch (listing.kind) {
    case 'impersonated': return listing.target;
    case 'external': return listing.target;
    case 'user': return null;
    case 'service-account': return null;
    case 'not-signed-in':
    case 'unreadable':
    case 'unrecognized':
      return undefined;
  }
}

/** The principal that authenticates the listing — the human (or key) behind
 *  ADC, before any impersonation. Null when it cannot be named. */
function listingPrincipal(listing: GcpListingIdentity): string | null {
  if (listing.kind === 'user') return listing.account.status === 'known' ? listing.account.email : null;
  if (listing.kind === 'service-account') return listing.email;
  if (listing.kind !== 'impersonated') return null;
  const { source } = listing;
  if (source.kind === 'service-account') return source.email;
  if (source.kind === 'user' && source.account.status === 'known') return source.account.email;
  return null;
}

/** Every disagreement between the two credential paths, provider checks
 *  first. `providerTarget` is the provider's `impersonateServiceAccount`
 *  (null when it sets none, or in the wizard before a provider exists).
 *
 *  A key-file provider is exempt: the key drives both the listing SDK and the
 *  download (`CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE`), so there is only one
 *  identity to disagree with. */
export function gcpIdentityWarnings(
  listing: GcpListingIdentity,
  download: GcpDownloadIdentity,
  providerTarget: string | null,
): GcpIdentityWarning[] {
  if (download.kind === 'key-file' || (listing.kind === 'service-account' && listing.origin === 'key-file')) return [];
  const warnings: GcpIdentityWarning[] = [];

  if (providerTarget !== null) {
    const adcTarget = listingImpersonation(listing);
    if (adcTarget === null) {
      warnings.push({ kind: 'adc-not-impersonated', providerTarget });
    } else if (adcTarget !== undefined && !samePrincipal(adcTarget, providerTarget)) {
      warnings.push({ kind: 'adc-target-mismatch', adcTarget, providerTarget });
    }
  }

  const listingAccount = listingPrincipal(listing);
  if (download.kind === 'gcloud' && download.account !== null && listingAccount !== null
    && !samePrincipal(listingAccount, download.account)) {
    warnings.push({ kind: 'split-accounts', listingAccount, downloadAccount: download.account });
  }
  return warnings;
}

/** What the panel cannot verify but should point out. Today one case: ADC's
 *  human is `not-recorded` (an impersonated sign-in), so whether gcloud's
 *  active account is the same person — the check `split-accounts` makes when
 *  it can — is left to the user, with the account to compare against. Not
 *  raised for an expired or unreachable lookup: the listing row already says
 *  that, and its remedy comes first. */
export function gcpIdentityNotes(listing: GcpListingIdentity, download: GcpDownloadIdentity): GcpIdentityNote[] {
  if (download.kind !== 'gcloud' || download.account === null) return [];
  const unrecorded = (account: GcpAccountLookup): boolean => account.status === 'unknown' && account.reason === 'not-recorded';
  if (listing.kind === 'user' && unrecorded(listing.account)) {
    return [{ kind: 'listing-account-unrecorded', downloadAccount: download.account, target: null }];
  }
  if (listing.kind === 'impersonated' && listing.source.kind === 'user' && unrecorded(listing.source.account)) {
    return [{ kind: 'listing-account-unrecorded', downloadAccount: download.account, target: listing.target }];
  }
  return [];
}
