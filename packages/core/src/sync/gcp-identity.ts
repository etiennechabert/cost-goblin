import { posix, win32 } from 'node:path';
import { isStringRecord, parseJsonObject } from '../utils/json.js';
import { impersonationTargetFromUrl } from './gcp-adc-classify.js';
import { isGcpCredentialError } from './gcp-credential-errors.js';
import type {
  GcpAccountLookup,
  GcpAccountLookupFailure,
  GcpCredentialFile,
  GcpDownloadIdentity,
  GcpListingIdentity,
  GcpSplitAccounts,
} from '../types/gcp-identity.js';

/** Pure half of "which accounts does a GCP provider run as": reading the
 *  credential file the Cloud Storage SDK uses, gcloud's configuration, and
 *  deciding when the two are different people. The I/O — reading files,
 *  spawning gcloud, the round trip that names a user — lives in the desktop
 *  main process and is injected here, so every rule below is testable
 *  against fixture JSON.
 *
 *  The one secret this module touches is a user credential's refresh token,
 *  carried in `AuthorizedUserSecret` only far enough to hand to the injected
 *  lookup. Nothing it returns as a `GcpListingIdentity` holds a secret. */

/** What minting a token for a user credential needs. Internal to the main
 *  process: never part of a `GcpListingIdentity`, never sent over IPC. */
export interface AuthorizedUserSecret {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
}

/** A credential file, described. Mirrors google-auth-library 9's
 *  `GoogleAuth.fromJSON` dispatch — `authorized_user`,
 *  `impersonated_service_account`, the federation types, and everything else
 *  through the JWT path, which needs only `client_email` + `private_key` —
 *  so what the panel says is what the SDK will do. */
export type ParsedAdc =
  | { readonly kind: 'user'; readonly account: string | null; readonly secret: AuthorizedUserSecret | null }
  | { readonly kind: 'impersonated'; readonly target: string }
  | { readonly kind: 'service-account'; readonly email: string }
  | { readonly kind: 'other'; readonly type: string | null };

const ADC_FILE_NAME = 'application_default_credentials.json';

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Describe a parsed credential file. Null when the payload is not a JSON
 *  object at all — the caller reports that as an unreadable file. */
export function parseAdcJson(raw: unknown): ParsedAdc | null {
  if (!isStringRecord(raw)) return null;
  const type = nonEmptyString(raw['type']);
  if (type === 'authorized_user') {
    const clientId = nonEmptyString(raw['client_id']);
    const clientSecret = nonEmptyString(raw['client_secret']);
    const refreshToken = nonEmptyString(raw['refresh_token']);
    return {
      kind: 'user',
      // gcloud writes `account` on some versions (often as ''); when present
      // it names the user without a network round trip.
      account: nonEmptyString(raw['account']),
      secret: clientId === null || clientSecret === null || refreshToken === null ? null : { clientId, clientSecret, refreshToken },
    };
  }
  if (type === 'impersonated_service_account') {
    const target = impersonationTargetFromUrl(raw['service_account_impersonation_url']);
    return target === null ? { kind: 'other', type } : { kind: 'impersonated', target };
  }
  if (type === 'external_account' || type === 'external_account_authorized_user') return { kind: 'other', type };
  // The JWT path: whatever the `type`, a file with both fields is a
  // service-account key to the SDK. Only the email is read.
  const email = nonEmptyString(raw['private_key']) === null ? null : nonEmptyString(raw['client_email']);
  return email === null ? { kind: 'other', type } : { kind: 'service-account', email };
}

/** Longer than any real path; a value past it is not one. */
const MAX_PATH_LENGTH = 4096;

const NOT_A_PATH_PREFIX = '<value of ';
const NOT_A_PATH_SUFFIX = ' is not a file path>';

/** `value`, or — when it is not shaped like a path (credential JSON pasted
 *  into `GOOGLE_APPLICATION_CREDENTIALS`) — a placeholder naming where it came
 *  from, so a pasted secret never crosses IPC to the panel. */
export function displayablePath(value: string, source: string): string {
  const pathLike = value.length <= MAX_PATH_LENGTH && !/[\r\n{]/.test(value) && !value.includes('private_key');
  return pathLike ? value : `${NOT_A_PATH_PREFIX}${source}${NOT_A_PATH_SUFFIX}`;
}

/** Whether `path` is `displayablePath`'s placeholder — nothing to read. */
export function isPathPlaceholder(path: string): boolean {
  return path.startsWith(NOT_A_PATH_PREFIX) && path.endsWith(NOT_A_PATH_SUFFIX);
}

function joinFor(platform: NodeJS.Platform): (...parts: string[]) => string {
  return platform === 'win32' ? win32.join : posix.join;
}

/** Where the Cloud Storage SDK will look for ADC, mirroring
 *  google-auth-library 9: `GOOGLE_APPLICATION_CREDENTIALS` (or its lowercase
 *  form) when non-empty — and then ONLY that file, it does not fall through —
 *  else the well-known file under `%APPDATA%` on Windows or `$HOME/.config`
 *  elsewhere. `CLOUDSDK_CONFIG` is deliberately not consulted: the SDK
 *  ignores it. Null when neither root is set. Pure — existence is the
 *  caller's check. */
export function adcCredentialsLocation(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): GcpCredentialFile | null {
  const fromEnv = nonEmptyString(env['GOOGLE_APPLICATION_CREDENTIALS']) ?? nonEmptyString(env['google_application_credentials']);
  if (fromEnv !== null) return { path: displayablePath(fromEnv, 'GOOGLE_APPLICATION_CREDENTIALS'), origin: 'env' };
  const join = joinFor(platform);
  if (platform === 'win32') {
    const appData = nonEmptyString(env['APPDATA']);
    return appData === null ? null : { path: join(appData, 'gcloud', ADC_FILE_NAME), origin: 'well-known' };
  }
  const home = nonEmptyString(env['HOME']);
  return home === null ? null : { path: join(home, '.config', 'gcloud', ADC_FILE_NAME), origin: 'well-known' };
}

/** gcloud's record of which named configuration is active, under its config
 *  directory: `CLOUDSDK_CONFIG`, else `%APPDATA%\gcloud` / `$HOME/.config/gcloud`. */
export function activeGcloudConfigPath(env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform): string | null {
  const join = joinFor(platform);
  const override = nonEmptyString(env['CLOUDSDK_CONFIG']);
  if (override !== null) return join(override, 'active_config');
  if (platform === 'win32') {
    const appData = nonEmptyString(env['APPDATA']);
    return appData === null ? null : join(appData, 'gcloud', 'active_config');
  }
  const home = nonEmptyString(env['HOME']);
  return home === null ? null : join(home, '.config', 'gcloud', 'active_config');
}

/** The active configuration's name, resolved the way gcloud does it:
 *  `CLOUDSDK_ACTIVE_CONFIG_NAME`, else the `active_config` file, else
 *  `default`. Read here rather than asked of gcloud, because
 *  `config list --format=json` suppresses the line that names it and a second
 *  spawn costs a second Python start-up. */
export function activeGcloudConfiguration(
  env: Readonly<Record<string, string | undefined>>,
  activeConfigFile: string | null,
): string {
  return nonEmptyString(env['CLOUDSDK_ACTIVE_CONFIG_NAME'])
    ?? nonEmptyString(activeConfigFile?.trim())
    ?? 'default';
}

/** gcloud's active account from `gcloud config list --format=json`, which
 *  reports effective values (a `CLOUDSDK_CORE_ACCOUNT` override included).
 *  `undefined` when stdout is not a JSON object (an update nag, say) — not
 *  the same as `null`, "no account set". */
export function parseGcloudAccount(stdout: string): string | null | undefined {
  const parsed = parseJsonObject(stdout);
  if (parsed === null) return undefined;
  const core = parsed['core'];
  return isStringRecord(core) ? nonEmptyString(core['account']) : null;
}

/** Markers of a refresh that failed because the client itself is no longer
 *  allowed — beyond the shared `isGcpCredentialError` list, which covers the
 *  expired and revoked cases. */
const LOOKUP_ONLY_DEAD_MARKERS = ['invalid_client', 'unauthorized_client'];

/** Classify a failed account lookup. The raw error is dropped on purpose: a
 *  gaxios error can quote the request it failed on. google-auth-library can
 *  leave a non-string in `message` (it copies an error response's body there
 *  verbatim), so the text is read defensively before the shared classifier
 *  sees it. */
export function classifyAccountLookupError(err: unknown): GcpAccountLookupFailure {
  const raw: unknown = err instanceof Error ? err.message : err;
  const text = typeof raw === 'string' ? raw : '';
  if (isGcpCredentialError(new Error(text))) return 'expired';
  return LOOKUP_ONLY_DEAD_MARKERS.some(marker => text.includes(marker)) ? 'expired' : 'unreachable';
}

/** Whether a token's granted `scope` (space-delimited) lets Google say whose
 *  it is. Null when the token response did not say what it granted. */
export function grantsEmailScope(scope: string | undefined): boolean | null {
  if (scope === undefined) return null;
  const granted = new Set(scope.split(/\s+/));
  return granted.has('email') || granted.has('openid') || granted.has('https://www.googleapis.com/auth/userinfo.email');
}

/** Names a user from a refresh credential — round trips to Google, done by
 *  the caller (google-auth-library in the main process). */
export type AccountLookupFn = (secret: AuthorizedUserSecret) => Promise<GcpAccountLookup>;

/** The listing identity a parsed credential file gives (`null`: the file did
 *  not parse). Never rejects: a failed lookup becomes an unknown account. */
export async function resolveListingIdentity(
  parsed: ParsedAdc | null,
  file: GcpCredentialFile,
  lookup: AccountLookupFn,
): Promise<GcpListingIdentity> {
  if (parsed === null) return { kind: 'unreadable', file };
  switch (parsed.kind) {
    case 'user': {
      if (parsed.account !== null) return { kind: 'user', file, account: { status: 'known', email: parsed.account } };
      // A user credential with no refresh token cannot mint anything; the
      // remedy is the same as for a revoked one — sign in again.
      if (parsed.secret === null) return { kind: 'user', file, account: { status: 'unknown', reason: 'expired' } };
      let account: GcpAccountLookup;
      try {
        account = await lookup(parsed.secret);
      } catch (err: unknown) {
        account = { status: 'unknown', reason: classifyAccountLookupError(err) };
      }
      return { kind: 'user', file, account };
    }
    case 'impersonated':
      return { kind: 'impersonated', file, target: parsed.target };
    case 'service-account':
      return { kind: 'service-account', file, email: parsed.email };
    case 'other':
      return { kind: 'other', file, type: parsed.type };
  }
}

/** The `email` claim of an OpenID Connect id_token, decoded locally. Only
 *  used to display who signed in — the token came straight from Google's
 *  token endpoint over TLS, so the signature is not what is being trusted. */
export function emailFromIdToken(idToken: string): string | null {
  const payload = idToken.split('.')[1];
  if (payload === undefined || payload.length === 0) return null;
  const claims = parseJsonObject(Buffer.from(payload, 'base64url').toString('utf8'));
  return claims === null ? null : nonEmptyString(claims['email']);
}

/** Listing and downloads running as two different people: a signed-in ADC
 *  user whose email is known, and a different gcloud account. Silent
 *  otherwise — service accounts and impersonation are the provider's
 *  business, and an account that cannot be named cannot be compared. */
export function splitAccounts(listing: GcpListingIdentity, download: GcpDownloadIdentity): GcpSplitAccounts | null {
  if (listing.kind !== 'user' || listing.account.status !== 'known') return null;
  if (download.kind !== 'gcloud' || download.account === null) return null;
  const listingAccount = listing.account.email;
  return listingAccount.toLowerCase() === download.account.toLowerCase()
    ? null
    : { listingAccount, downloadAccount: download.account };
}
