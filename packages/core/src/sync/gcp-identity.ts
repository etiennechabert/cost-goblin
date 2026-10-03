import { posix, win32 } from 'node:path';
import { isStringRecord, parseJsonObject } from '../utils/json.js';
import { isGcpCredentialError } from './gcp-credential-errors.js';
import type {
  GcpAccountLookup,
  GcpAccountLookupFailure,
  GcpCredentialFile,
  GcpDownloadIdentity,
  GcpDownloadImpersonation,
  GcpDownloadPrincipal,
  GcpIdentityNote,
  GcpIdentityWarning,
  GcpImpersonationSource,
  GcpListingIdentity,
} from '../types/gcp-identity.js';

/** Pure half of "which identities does a GCP provider run as": reading the
 *  credential files the Cloud Storage SDK uses, gcloud's effective
 *  configuration, and deciding when the two disagree. The I/O — reading
 *  files, spawning gcloud, the round trips that name a user — lives in the
 *  desktop main process and is injected here, so every rule below is
 *  testable against fixture JSON.
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

interface ParsedUser { readonly kind: 'user'; readonly account: string | null; readonly secret: AuthorizedUserSecret | null }
interface ParsedServiceAccount { readonly kind: 'service-account'; readonly email: string }

/** The source credential of an impersonating file. */
export type ParsedAdcSource = ParsedUser | ParsedServiceAccount | { readonly kind: 'other'; readonly type: string | null };

/** A credential file, described. Mirrors google-auth-library 9's
 *  `GoogleAuth.fromJSON` dispatch — `authorized_user`,
 *  `impersonated_service_account`, `external_account`,
 *  `external_account_authorized_user`, and everything else through the JWT
 *  path, which needs only `client_email` + `private_key` — so what the panel
 *  says is what the SDK will do. */
export type ParsedAdc =
  | ParsedUser
  | ParsedServiceAccount
  | { readonly kind: 'impersonated'; readonly source: ParsedAdcSource; readonly target: string }
  | { readonly kind: 'external'; readonly target: string | null }
  | { readonly kind: 'unrecognized'; readonly type: string | null };

const ADC_FILE_NAME = 'application_default_credentials.json';

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

function parseUser(record: Readonly<Record<string, unknown>>): ParsedUser {
  const clientId = nonEmptyString(record['client_id']);
  const clientSecret = nonEmptyString(record['client_secret']);
  const refreshToken = nonEmptyString(record['refresh_token']);
  return {
    kind: 'user',
    // gcloud writes `account` on some versions (often as ''); when present
    // it names the user without a network round trip.
    account: nonEmptyString(record['account']),
    secret: clientId === null || clientSecret === null || refreshToken === null ? null : { clientId, clientSecret, refreshToken },
  };
}

/** The JWT path: whatever the `type`, a file with both fields is a
 *  service-account key to the SDK. Only the email is read. */
function serviceAccountEmail(record: Readonly<Record<string, unknown>>): string | null {
  if (nonEmptyString(record['private_key']) === null) return null;
  return nonEmptyString(record['client_email']);
}

function parseSource(raw: unknown): ParsedAdcSource {
  if (!isStringRecord(raw)) return { kind: 'other', type: null };
  const type = nonEmptyString(raw['type']);
  if (type === 'authorized_user') return parseUser(raw);
  const email = serviceAccountEmail(raw);
  return email === null ? { kind: 'other', type } : { kind: 'service-account', email };
}

/** Describe a parsed credential file. Null when the payload is not a JSON
 *  object at all — the caller reports that as an unreadable file. */
export function parseAdcJson(raw: unknown): ParsedAdc | null {
  if (!isStringRecord(raw)) return null;
  const type = nonEmptyString(raw['type']);
  switch (type) {
    case 'authorized_user':
      return parseUser(raw);
    case 'impersonated_service_account': {
      const target = impersonationTargetFromUrl(raw['service_account_impersonation_url']);
      return target === null ? { kind: 'unrecognized', type } : { kind: 'impersonated', target, source: parseSource(raw['source_credentials']) };
    }
    case 'external_account':
      return { kind: 'external', target: impersonationTargetFromUrl(raw['service_account_impersonation_url']) };
    case 'external_account_authorized_user':
      // Workforce identity federation for a person: no service account.
      return { kind: 'external', target: null };
    default: {
      const email = serviceAccountEmail(raw);
      return email === null ? { kind: 'unrecognized', type } : { kind: 'service-account', email };
    }
  }
}

function joinFor(platform: NodeJS.Platform): (...parts: string[]) => string {
  return platform === 'win32' ? win32.join : posix.join;
}

/** Where the Cloud Storage SDK will look for ADC, mirroring
 *  google-auth-library 9: `GOOGLE_APPLICATION_CREDENTIALS` (or its lowercase
 *  form) when non-empty — and then ONLY that file, it does not fall through —
 *  else the well-known file under `%APPDATA%` on Windows or `$HOME/.config`
 *  elsewhere. `CLOUDSDK_CONFIG` is deliberately not consulted: the SDK
 *  ignores it (see `adcLoginPath`). Null when neither root is set. Pure —
 *  existence is the caller's check. */
export function adcCredentialsLocation(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): GcpCredentialFile | null {
  const fromEnv = nonEmptyString(env['GOOGLE_APPLICATION_CREDENTIALS']) ?? nonEmptyString(env['google_application_credentials']);
  if (fromEnv !== null) return { path: fromEnv, origin: 'env' };
  const join = joinFor(platform);
  if (platform === 'win32') {
    const appData = nonEmptyString(env['APPDATA']);
    return appData === null ? null : { path: join(appData, 'gcloud', ADC_FILE_NAME), origin: 'well-known' };
  }
  const home = nonEmptyString(env['HOME']);
  return home === null ? null : { path: join(home, '.config', 'gcloud', ADC_FILE_NAME), origin: 'well-known' };
}

/** gcloud's own configuration directory: `CLOUDSDK_CONFIG`, else
 *  `%APPDATA%\gcloud` / `$HOME/.config/gcloud`. */
export function gcloudConfigDir(env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform): string | null {
  const override = nonEmptyString(env['CLOUDSDK_CONFIG']);
  if (override !== null) return override;
  const join = joinFor(platform);
  if (platform === 'win32') {
    const appData = nonEmptyString(env['APPDATA']);
    return appData === null ? null : join(appData, 'gcloud');
  }
  const home = nonEmptyString(env['HOME']);
  return home === null ? null : join(home, '.config', 'gcloud');
}

/** gcloud's record of which named configuration is active. */
export function activeGcloudConfigPath(env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform): string | null {
  const dir = gcloudConfigDir(env, platform);
  return dir === null ? null : joinFor(platform)(dir, 'active_config');
}

/** Where `gcloud auth application-default login` writes, when that is NOT
 *  the file the SDK reads. gcloud writes into its configuration directory,
 *  which `CLOUDSDK_CONFIG` moves; the Node SDK reads the well-known path
 *  regardless — so with `CLOUDSDK_CONFIG` set, signing in "succeeds" into a
 *  file listing never reads. Null when they agree, or when
 *  `GOOGLE_APPLICATION_CREDENTIALS` names the file (that remedy is different:
 *  the variable itself). */
export function adcLoginPath(env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform): string | null {
  const read = adcCredentialsLocation(env, platform);
  if (read?.origin === 'env') return null;
  const dir = gcloudConfigDir(env, platform);
  if (dir === null) return null;
  const written = joinFor(platform)(dir, ADC_FILE_NAME);
  if (read === null) return written;
  // Case-insensitive file systems are the default on both of these.
  const fold = platform === 'win32' || platform === 'darwin';
  const same = fold ? written.toLowerCase() === read.path.toLowerCase() : written === read.path;
  return same ? null : written;
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

async function lookupUser(user: ParsedUser, lookup: AccountLookupFn): Promise<GcpAccountLookup> {
  if (user.account !== null) return { status: 'known', email: user.account };
  // A user credential with no refresh token cannot mint anything; the remedy
  // is the same as for a revoked one — sign in again.
  if (user.secret === null) return { status: 'unknown', reason: 'expired' };
  try {
    return await lookup(user.secret);
  } catch (err: unknown) {
    return { status: 'unknown', reason: classifyAccountLookupError(err) };
  }
}

/** The listing identity a parsed credential file gives (`null`: the file did
 *  not parse). Never rejects: a failed lookup becomes an unknown account. */
export async function resolveListingIdentity(
  parsed: ParsedAdc | null,
  file: GcpCredentialFile,
  lookup: AccountLookupFn,
): Promise<GcpListingIdentity> {
  if (parsed === null) return { kind: 'unreadable', file };
  switch (parsed.kind) {
    case 'user':
      return { kind: 'user', file, account: await lookupUser(parsed, lookup) };
    case 'impersonated': {
      const { source } = parsed;
      const resolvedSource: GcpImpersonationSource = source.kind === 'user'
        ? { kind: 'user', account: await lookupUser(source, lookup) }
        : source;
      return { kind: 'impersonated', file, target: parsed.target, source: resolvedSource };
    }
    case 'service-account':
      return { kind: 'service-account', file, email: parsed.email };
    case 'external':
      return { kind: 'external', file, target: parsed.target };
    case 'unrecognized':
      return { kind: 'unrecognized', file, type: parsed.type };
  }
}

/** The email a credential authenticates as, when it can be named. */
export function credentialEmail(identity: GcpListingIdentity): string | null {
  if (identity.kind === 'service-account') return identity.email;
  if (identity.kind === 'user' && identity.account.status === 'known') return identity.account.email;
  return null;
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

/** The credential-relevant properties of `gcloud config list --format=json`,
 *  which reports EFFECTIVE values — `CLOUDSDK_*` environment overrides
 *  included — for the active configuration. */
export interface GcloudConfigValues {
  readonly account: string | null;
  /** The final target: gcloud accepts a comma-separated delegation chain and
   *  impersonates the last account in it. */
  readonly impersonateServiceAccount: string | null;
  readonly credentialFileOverride: string | null;
  readonly accessTokenFile: string | null;
}

function section(record: Readonly<Record<string, unknown>>, name: string): Readonly<Record<string, unknown>> {
  const value = record[name];
  return isStringRecord(value) ? value : {};
}

/** Parse `gcloud config list --format=json`. Null when stdout is not a JSON
 *  object (an update nag, say) — not the same as "nothing set". */
export function parseGcloudConfigList(stdout: string): GcloudConfigValues | null {
  const parsed = parseJsonObject(stdout);
  if (parsed === null) return null;
  const core = section(parsed, 'core');
  const auth = section(parsed, 'auth');
  const chain = nonEmptyString(auth['impersonate_service_account']);
  const target = chain === null ? null : (chain.split(',').map(part => part.trim()).filter(part => part.length > 0).pop() ?? null);
  return {
    account: nonEmptyString(core['account']),
    impersonateServiceAccount: target,
    credentialFileOverride: nonEmptyString(auth['credential_file_override']),
    accessTokenFile: nonEmptyString(auth['access_token_file']),
  };
}

/** The active configuration's name, resolved the way gcloud does it:
 *  `CLOUDSDK_ACTIVE_CONFIG_NAME`, else the `active_config` file in the config
 *  directory, else `default`. Read here rather than asked of gcloud, because
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

/** Who `gcloud storage rsync` authenticates as, from gcloud's effective
 *  config plus what the sync passes it. gcloud's precedence:
 *  `auth/access_token_file`, then a credential file override — the
 *  provider's `keyFile` (passed as `CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE`,
 *  so it beats gcloud's own `auth/credential_file_override`) — then the
 *  active account. Impersonation is applied on top: the provider's
 *  `impersonateServiceAccount` is passed as a flag and so beats gcloud's
 *  `auth/impersonate_service_account`. */
export function assembleDownloadIdentity(params: {
  readonly config: GcloudConfigValues;
  readonly configuration: string;
  readonly accountFromEnv: boolean;
  readonly providerKeyFile: { readonly path: string; readonly email: string | null } | null;
  readonly providerTarget: string | null;
  /** The email in gcloud's own `auth/credential_file_override`, when set. */
  readonly overrideFileEmail: string | null;
}): GcpDownloadIdentity {
  const { config } = params;
  let principal: GcpDownloadPrincipal;
  if (config.accessTokenFile !== null) {
    principal = { kind: 'access-token-file', path: config.accessTokenFile };
  } else if (params.providerKeyFile !== null) {
    principal = { kind: 'key-file', path: params.providerKeyFile.path, origin: 'provider', email: params.providerKeyFile.email };
  } else if (config.credentialFileOverride !== null) {
    principal = { kind: 'key-file', path: config.credentialFileOverride, origin: 'gcloud-config', email: params.overrideFileEmail };
  } else {
    principal = { kind: 'account', account: config.account, fromEnv: params.accountFromEnv };
  }
  let impersonate: GcpDownloadImpersonation | null = null;
  if (params.providerTarget !== null) impersonate = { target: params.providerTarget, origin: 'provider' };
  else if (config.impersonateServiceAccount !== null) impersonate = { target: config.impersonateServiceAccount, origin: 'gcloud-config' };
  return { kind: 'gcloud', principal, impersonate, configuration: params.configuration };
}

/** A principal as far as it can be named: `unrecorded` is the impersonated-ADC
 *  case where the credential works but will not say whose it is — distinct
 *  from `unknown` (expired, unreachable, opaque), because only the former is
 *  worth asking the user to compare by hand. */
type Principal =
  | { readonly status: 'known'; readonly email: string }
  | { readonly status: 'unrecorded' }
  | { readonly status: 'unknown' };

function lookupPrincipal(account: GcpAccountLookup): Principal {
  if (account.status === 'known') return { status: 'known', email: account.email };
  return account.reason === 'not-recorded' ? { status: 'unrecorded' } : { status: 'unknown' };
}

/** The principal behind listing — the human (or key) before any
 *  impersonation. */
function listingPrincipal(listing: GcpListingIdentity): Principal {
  switch (listing.kind) {
    case 'user': return lookupPrincipal(listing.account);
    case 'service-account': return { status: 'known', email: listing.email };
    case 'impersonated':
      if (listing.source.kind === 'user') return lookupPrincipal(listing.source.account);
      return listing.source.kind === 'service-account' ? { status: 'known', email: listing.source.email } : { status: 'unknown' };
    case 'not-signed-in':
    case 'unreadable':
    case 'external':
    case 'unrecognized':
      return { status: 'unknown' };
  }
}

/** The service account listing ends up as; null when it uses its own
 *  identity directly; undefined when listing is absent or opaque, so no
 *  impersonation claim can be made. */
function listingTarget(listing: GcpListingIdentity): string | null | undefined {
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

function downloadAccount(principal: GcpDownloadPrincipal): string | null {
  switch (principal.kind) {
    case 'account': return principal.account;
    case 'key-file': return principal.email;
    case 'access-token-file': return null;
  }
}

function samePrincipal(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Every disagreement between the two credential paths: the impersonation
 *  targets first, then the principals underneath them. Silent when gcloud
 *  could not be read — there is nothing to compare listing against. */
export function gcpIdentityWarnings(listing: GcpListingIdentity, download: GcpDownloadIdentity): GcpIdentityWarning[] {
  if (download.kind !== 'gcloud') return [];
  const warnings: GcpIdentityWarning[] = [];

  const fromListing = listingTarget(listing);
  if (fromListing !== undefined) {
    if (fromListing !== null && download.impersonate !== null && !samePrincipal(fromListing, download.impersonate.target)) {
      warnings.push({ kind: 'target-mismatch', listingTarget: fromListing, download: download.impersonate });
    } else if (fromListing === null && download.impersonate !== null) {
      warnings.push({ kind: 'listing-not-impersonated', download: download.impersonate });
    } else if (fromListing !== null && download.impersonate === null) {
      warnings.push({ kind: 'download-not-impersonated', listingTarget: fromListing });
    }
  }

  const listingWho = listingPrincipal(listing);
  const downloadWho = downloadAccount(download.principal);
  if (listingWho.status === 'known' && downloadWho !== null && !samePrincipal(listingWho.email, downloadWho)) {
    warnings.push({
      kind: 'split-accounts',
      listingAccount: listingWho.email,
      downloadAccount: downloadWho,
      listingKeyFile: listing.kind === 'service-account' ? listing.file.path : null,
      downloadAccountFromEnv: download.principal.kind === 'account' && download.principal.fromEnv,
    });
  }
  return warnings;
}

/** What the panel cannot verify but should point out. Today one case: the
 *  human behind listing is `not-recorded` (an impersonated sign-in), so
 *  whether gcloud's active account is the same person — the check
 *  `split-accounts` makes when it can — is left to the user, with the
 *  account to compare against. Not raised for an expired or unreachable
 *  lookup: the listing row already says that, and its remedy comes first. */
export function gcpIdentityNotes(listing: GcpListingIdentity, download: GcpDownloadIdentity): GcpIdentityNote[] {
  if (download.kind !== 'gcloud' || download.principal.kind !== 'account' || download.principal.account === null) return [];
  if (listingPrincipal(listing).status !== 'unrecorded') return [];
  return [{
    kind: 'listing-account-unrecorded',
    downloadAccount: download.principal.account,
    downloadTarget: download.impersonate?.target ?? null,
  }];
}
