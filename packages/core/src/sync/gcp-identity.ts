import { posix, win32 } from 'node:path';
import { isServiceAccountEmail } from '../config/service-account.js';
import { isStringRecord, parseJsonObject } from '../utils/json.js';
import { classifyImpersonatedAdc, impersonationTargetFromUrl } from './gcp-adc-classify.js';
import type { ImpersonatedAdcSource } from './gcp-adc-classify.js';
import { isGcpCredentialError } from './gcp-credential-errors.js';
import type {
  GcloudSettingOrigin,
  GcpAccountLookup,
  GcpAccountLookupFailure,
  GcpCredentialFile,
  GcpDownloadIdentity,
  GcpDownloadImpersonation,
  GcpDownloadPrincipal,
  GcpGcloudImpersonation,
  GcpGcloudImpersonationSetting,
  GcpIdentityNote,
  GcpIdentityWarning,
  GcpImpersonationSource,
  GcpListingIdentity,
  GcpReaderAdvice,
} from '../types/gcp-identity.js';

export { impersonationTargetFromUrl } from './gcp-adc-classify.js';

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

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
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

function parseSource(source: ImpersonatedAdcSource): ParsedAdcSource {
  switch (source.kind) {
    case 'user': return parseUser(source.record);
    case 'service-account': return { kind: 'service-account', email: source.email };
    case 'other': return { kind: 'other', type: source.type };
  }
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
      // The same classification the listing client unwraps with, so a file
      // it would reject is never shown as a working impersonation.
      const legacy = classifyImpersonatedAdc(raw);
      return legacy.kind === 'impersonated'
        ? { kind: 'impersonated', target: legacy.target, source: parseSource(legacy.source) }
        : { kind: 'unrecognized', type };
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

/** Longer than any real path; a value this long is a pasted credential. */
const MAX_PATH_LENGTH = 1024;

/** Whether a variable or setting that should name a file plausibly does.
 *  Users paste credential JSON (or a raw token) where a path belongs; such a
 *  value must never be echoed to the renderer. */
export function looksLikeFilePath(value: string): boolean {
  return value.length <= MAX_PATH_LENGTH && !/[\r\n{]/.test(value) && !value.includes('private_key');
}

const NOT_A_PATH_PREFIX = '<value of ';
const NOT_A_PATH_SUFFIX = ' is not a file path>';

/** `value`, or — when it does not look like a path — a placeholder naming
 *  where it came from, so a pasted secret never crosses IPC verbatim. */
export function displayablePath(value: string, source: string): string {
  return looksLikeFilePath(value) ? value : `${NOT_A_PATH_PREFIX}${source}${NOT_A_PATH_SUFFIX}`;
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
 *  ignores it (see `adcLoginPath`). Null when neither root is set. Pure —
 *  existence is the caller's check. */
export function adcCredentialsLocation(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): GcpCredentialFile | null {
  for (const variable of ['GOOGLE_APPLICATION_CREDENTIALS', 'google_application_credentials']) {
    const fromEnv = nonEmptyString(env[variable]);
    if (fromEnv !== null) return { path: displayablePath(fromEnv, variable), origin: 'env' };
  }
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
      return { kind: 'impersonated', file, target: parsed.target, source: resolvedSource, via: { kind: 'credential' } };
    }
    case 'service-account':
      return { kind: 'service-account', file, email: parsed.email };
    case 'external':
      return { kind: 'external', file, target: parsed.target };
    case 'unrecognized':
      return { kind: 'unrecognized', file, type: parsed.type };
  }
}

function samePrincipal(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** What bucket listing does for a provider, given what ADC holds — the
 *  mirror of `createGcsStorage`. Without a reader (`target` null), listing
 *  uses ADC as it is, so a legacy impersonated ADC file still lists as its
 *  own target. With one, listing impersonates `target`, minted from ADC's
 *  own principal: a plain user's login, a service-account key, a federated
 *  credential — or, for a legacy impersonated file, the login underneath it
 *  (unwrapped, never chained through the file's target). A principal that
 *  already IS `target` (its key, or federation impersonating it) is used as
 *  it is: nothing mints an account from itself. A missing, unreadable or
 *  unusable ADC stays as it is: there is nothing to mint from, and signing
 *  in is the remedy either way. */
export function applyProviderImpersonation(adc: GcpListingIdentity, target: string | null): GcpListingIdentity {
  if (target === null) return adc;
  const minted = (file: GcpCredentialFile, source: GcpImpersonationSource, adcTarget: string | null): GcpListingIdentity => (
    { kind: 'impersonated', file, source, target, via: { kind: 'provider', adcTarget } }
  );
  switch (adc.kind) {
    case 'not-signed-in':
    case 'unreadable':
    case 'unrecognized':
      return adc;
    case 'user':
      return minted(adc.file, { kind: 'user', account: adc.account }, null);
    case 'service-account':
      return samePrincipal(adc.email, target) ? adc : minted(adc.file, { kind: 'service-account', email: adc.email }, null);
    case 'external':
      return adc.target !== null && samePrincipal(adc.target, target) ? adc : minted(adc.file, { kind: 'federated', target: adc.target }, null);
    case 'impersonated': {
      const adcTarget = adc.via.kind === 'credential' ? adc.target : adc.via.adcTarget;
      switch (adc.source.kind) {
        case 'other':
          // The listing client unwraps a user login or a key only; it refuses
          // to mint a reader from anything else underneath a legacy file.
          return { kind: 'unrecognized', file: adc.file, type: 'impersonated_service_account' };
        case 'federated':
          // Already minted from federation (applied twice): unchanged.
          return minted(adc.file, adc.source, adcTarget);
        case 'service-account':
          return samePrincipal(adc.source.email, target)
            ? { kind: 'service-account', file: adc.file, email: adc.source.email }
            : minted(adc.file, adc.source, adcTarget);
        case 'user':
          return minted(adc.file, adc.source, adcTarget);
      }
    }
  }
}

/** The email a credential authenticates as, when it can be named. */
export function credentialEmail(identity: GcpListingIdentity): string | null {
  if (identity.kind === 'service-account') return identity.email;
  if (identity.kind === 'user' && identity.account.status === 'known') return identity.account.email;
  return null;
}

/** What matters about a credential file handed to gcloud: who it is (a key's
 *  email), and whom it impersonates by itself. */
export interface CredentialFileSummary {
  readonly email: string | null;
  readonly impersonates: string | null;
}

export function summarizeCredentialFile(identity: GcpListingIdentity): CredentialFileSummary {
  const impersonates = identity.kind === 'impersonated' || identity.kind === 'external' ? identity.target : null;
  return { email: credentialEmail(identity), impersonates };
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
  /** The chain's earlier hops, in order; empty for a single account. */
  readonly impersonationDelegates: readonly string[];
  readonly credentialFileOverride: string | null;
  readonly accessTokenFile: string | null;
}

function section(record: Readonly<Record<string, unknown>>, name: string): Readonly<Record<string, unknown>> {
  const value = record[name];
  return isStringRecord(value) ? value : {};
}

/** The non-empty entries of a comma-separated list. */
function listEntries(list: string): string[] {
  return list.split(',').map(part => part.trim()).filter(part => part.length > 0);
}

/** Parse `gcloud config list --format=json`. Null when stdout is not a JSON
 *  object (an update nag, say) — not the same as "nothing set". */
export function parseGcloudConfigList(stdout: string): GcloudConfigValues | null {
  const parsed = parseJsonObject(stdout);
  if (parsed === null) return null;
  const core = section(parsed, 'core');
  const auth = section(parsed, 'auth');
  const chain = listEntries(nonEmptyString(auth['impersonate_service_account']) ?? '');
  return {
    account: nonEmptyString(core['account']),
    impersonateServiceAccount: chain[chain.length - 1] ?? null,
    impersonationDelegates: chain.slice(0, -1),
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

/** Which of gcloud's credential settings CostGoblin's own environment sets.
 *  `config list` reports effective values without saying where they came
 *  from; an env value beats the configuration file (an EMPTY one included),
 *  so it decides whether `gcloud config unset` can undo it. */
export interface GcloudEnvFacts {
  /** `CLOUDSDK_CORE_ACCOUNT` is set, an empty value included. */
  readonly accountFromEnv: boolean;
  /** `CLOUDSDK_AUTH_ACCESS_TOKEN` is non-empty: gcloud authenticates with
   *  that token before consulting anything else. */
  readonly accessTokenInEnv: boolean;
  readonly impersonation: GcloudSettingOrigin;
  readonly credentialFileOverride: GcloudSettingOrigin;
  readonly accessTokenFile: GcloudSettingOrigin;
}

export function gcloudEnvFacts(env: Readonly<Record<string, string | undefined>>): GcloudEnvFacts {
  const origin = (variable: string): GcloudSettingOrigin => (env[variable] === undefined ? 'gcloud-config' : 'env');
  return {
    accountFromEnv: env['CLOUDSDK_CORE_ACCOUNT'] !== undefined,
    accessTokenInEnv: nonEmptyString(env['CLOUDSDK_AUTH_ACCESS_TOKEN']) !== null,
    impersonation: origin('CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT'),
    credentialFileOverride: origin('CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE'),
    accessTokenFile: origin('CLOUDSDK_AUTH_ACCESS_TOKEN_FILE'),
  };
}

/** Whether a pre-minted token decides gcloud's identity, so nothing below it
 *  in gcloud's precedence (a credential file override, the active account)
 *  is consulted — and must not be read or refreshed to describe it. */
export function gcloudTokenWins(config: GcloudConfigValues, facts: GcloudEnvFacts): boolean {
  return facts.accessTokenInEnv || config.accessTokenFile !== null;
}

/** gcloud's own `auth/impersonate_service_account`, with where it came from. */
export function gcloudImpersonationSetting(config: GcloudConfigValues, facts: GcloudEnvFacts): GcpGcloudImpersonationSetting | null {
  return config.impersonateServiceAccount === null
    ? null
    : { origin: facts.impersonation, target: config.impersonateServiceAccount, delegates: config.impersonationDelegates };
}

/** Who `gcloud storage rsync` authenticates as, from gcloud's effective
 *  config plus what the sync passes it. gcloud's precedence:
 *  `CLOUDSDK_AUTH_ACCESS_TOKEN`, `auth/access_token_file`, then a credential
 *  file override — the provider's `keyFile` (passed as
 *  `CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE`, so it beats gcloud's own
 *  `auth/credential_file_override`) — then the active account.
 *  Impersonation is applied on top: the provider's
 *  `impersonateServiceAccount` is passed as a flag and so beats gcloud's
 *  `auth/impersonate_service_account`; with neither, a credential file that
 *  impersonates by itself does. */
export function assembleDownloadIdentity(params: {
  readonly config: GcloudConfigValues;
  readonly configuration: string;
  readonly facts: GcloudEnvFacts;
  readonly providerKeyFile: { readonly path: string; readonly summary: CredentialFileSummary } | null;
  readonly providerTarget: string | null;
  /** gcloud's own `auth/credential_file_override`, described; null when
   *  unset or not read (a token wins). */
  readonly overrideFile: CredentialFileSummary | null;
}): GcpDownloadIdentity {
  const { config, facts } = params;
  let principal: GcpDownloadPrincipal;
  let fileImpersonates: string | null = null;
  if (facts.accessTokenInEnv) {
    principal = { kind: 'access-token' };
  } else if (config.accessTokenFile !== null) {
    principal = { kind: 'access-token-file', path: displayablePath(config.accessTokenFile, 'auth/access_token_file'), origin: facts.accessTokenFile };
  } else if (params.providerKeyFile !== null) {
    principal = { kind: 'key-file', path: params.providerKeyFile.path, origin: 'provider', email: params.providerKeyFile.summary.email };
    fileImpersonates = params.providerKeyFile.summary.impersonates;
  } else if (config.credentialFileOverride !== null) {
    principal = {
      kind: 'key-file',
      path: displayablePath(config.credentialFileOverride, 'auth/credential_file_override'),
      origin: facts.credentialFileOverride,
      email: params.overrideFile?.email ?? null,
    };
    fileImpersonates = params.overrideFile?.impersonates ?? null;
  } else {
    principal = { kind: 'account', account: config.account, fromEnv: facts.accountFromEnv };
  }
  let impersonate: GcpDownloadImpersonation | null = gcloudImpersonationSetting(config, facts);
  if (params.providerTarget !== null) impersonate = { origin: 'provider', target: params.providerTarget };
  else if (impersonate === null && fileImpersonates !== null && principal.kind === 'key-file') {
    impersonate = { origin: 'credential-file', target: fileImpersonates, fileOrigin: principal.origin };
  }
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

function sourcePrincipal(source: GcpImpersonationSource): Principal {
  switch (source.kind) {
    case 'user': return lookupPrincipal(source.account);
    case 'service-account': return { status: 'known', email: source.email };
    case 'federated':
    case 'other':
      return { status: 'unknown' };
  }
}

/** Listing as two facts: the principal it authenticates as (the human or key
 *  before any impersonation — for a reader minted from a legacy impersonated
 *  ADC file, the login underneath it), and the service account it then
 *  impersonates, if any. Null when listing is absent or unusable, so no
 *  claim about it can be made. */
interface ListingSide {
  readonly file: GcpCredentialFile;
  readonly principal: Principal;
  readonly impersonates: string | null;
}

function listingSide(listing: GcpListingIdentity): ListingSide | null {
  switch (listing.kind) {
    case 'user': return { file: listing.file, principal: lookupPrincipal(listing.account), impersonates: null };
    case 'service-account': return { file: listing.file, principal: { status: 'known', email: listing.email }, impersonates: null };
    case 'impersonated': return { file: listing.file, principal: sourcePrincipal(listing.source), impersonates: listing.target };
    case 'external': return { file: listing.file, principal: { status: 'unknown' }, impersonates: listing.target };
    case 'not-signed-in':
    case 'unreadable':
    case 'unrecognized':
      return null;
  }
}

/** The key file behind listing's principal, when that principal is a
 *  service account read from a standalone key: ADC as a key, or the key a
 *  provider's reader is minted from. A key embedded in a legacy impersonated
 *  file is not one gcloud can be pointed at. */
function listingKeyFile(listing: GcpListingIdentity): GcpCredentialFile | null {
  if (listing.kind === 'service-account') return listing.file;
  if (listing.kind === 'impersonated' && listing.source.kind === 'service-account'
    && listing.via.kind === 'provider' && listing.via.adcTarget === null) {
    return listing.file;
  }
  return null;
}

function downloadAccount(principal: GcpDownloadPrincipal): string | null {
  switch (principal.kind) {
    case 'account': return principal.account;
    case 'key-file': return principal.email;
    case 'access-token-file':
    case 'access-token':
      return null;
  }
}

/** Whether naming `target` as the provider's reader would settle a
 *  disagreement. Never offered to a key-file provider (the two are
 *  exclusive), for a delegation chain (a reader is one account), for an
 *  address a provider cannot name, or when gcloud already IS the target —
 *  the flag would make it impersonate itself. */
function readerAdvice(
  side: ListingSide,
  target: string,
  chain: GcpGcloudImpersonation | null,
  downloadPrincipal: GcpDownloadPrincipal,
): GcpReaderAdvice {
  if (side.file.origin === 'key-file') return { kind: 'key-file-provider' };
  if (chain !== null && chain.origin !== 'credential-file' && chain.delegates.length > 0) {
    return { kind: 'delegation-chain', target, delegates: chain.delegates };
  }
  if (!isServiceAccountEmail(target)) return { kind: 'not-a-reader', target };
  const gcloudIs = downloadAccount(downloadPrincipal);
  if (gcloudIs !== null && samePrincipal(gcloudIs, target)) return { kind: 'download-is-target', target };
  return { kind: 'set-reader', target };
}

/** The impersonation half, compared by EFFECTIVE identity — the account each
 *  half ends up as (its impersonation target, else its principal) — so a
 *  half that already IS the other's target is not reported. Only an
 *  impersonation the provider did not ask for can disagree with listing: a
 *  provider's `impersonateServiceAccount` drives BOTH halves
 *  (`applyProviderImpersonation` and the download flag), so a
 *  provider-origin download impersonation always matches a listing built for
 *  that provider, and is never reported. */
function impersonationWarning(
  listing: GcpListingIdentity,
  download: Extract<GcpDownloadIdentity, { readonly kind: 'gcloud' }>,
): GcpIdentityWarning | null {
  const side = listingSide(listing);
  if (side === null) return null;
  const gcloud = download.impersonate;
  if (gcloud?.origin === 'provider') return null;
  const gcloudIs = downloadAccount(download.principal);
  if (gcloud === null) {
    if (side.impersonates === null) return null;
    if (gcloudIs !== null && samePrincipal(gcloudIs, side.impersonates)) return null;
    return {
      kind: 'download-not-impersonated',
      listingTarget: side.impersonates,
      advice: readerAdvice(side, side.impersonates, null, download.principal),
    };
  }
  if (side.impersonates === null) {
    if (side.principal.status === 'known' && samePrincipal(side.principal.email, gcloud.target)) return null;
    return { kind: 'listing-not-impersonated', gcloud, advice: readerAdvice(side, gcloud.target, gcloud, download.principal) };
  }
  if (samePrincipal(side.impersonates, gcloud.target)) return null;
  return {
    kind: 'target-mismatch',
    listingTarget: side.impersonates,
    gcloud,
    advice: readerAdvice(side, side.impersonates, null, download.principal),
  };
}

/** Every disagreement between the two credential paths: the impersonation
 *  targets first, then the principals underneath them. Silent when gcloud
 *  could not be read — there is nothing to compare listing against. */
export function gcpIdentityWarnings(listing: GcpListingIdentity, download: GcpDownloadIdentity): GcpIdentityWarning[] {
  if (download.kind !== 'gcloud') return [];
  const warnings: GcpIdentityWarning[] = [];

  const impersonation = impersonationWarning(listing, download);
  if (impersonation !== null) warnings.push(impersonation);

  const side = listingSide(listing);
  const downloadWho = downloadAccount(download.principal);
  if (side?.principal.status === 'known' && downloadWho !== null && !samePrincipal(side.principal.email, downloadWho)) {
    const listingEnd = side.impersonates ?? side.principal.email;
    const downloadEnd = download.impersonate?.target ?? downloadWho;
    const sameEnd = samePrincipal(listingEnd, downloadEnd);
    const bothMint = side.impersonates !== null && download.impersonate !== null;
    // Ending as the same account with only one half minting it is one
    // identity reached two ways — nothing to reconcile.
    if (!sameEnd || bothMint) {
      warnings.push({
        kind: 'split-accounts',
        listingAccount: side.principal.email,
        downloadAccount: downloadWho,
        listingKeyFile: listingKeyFile(listing),
        downloadPrincipal: download.principal,
        sharedTarget: sameEnd ? downloadEnd : null,
      });
    }
  }
  return warnings;
}

/** What the panel cannot verify but should point out. Today one case: the
 *  human behind listing is `not-recorded` (the login inside a legacy
 *  impersonated ADC file — used as it is, or unwrapped to mint a provider's
 *  reader), so whether gcloud's active account is the same person — the
 *  check `split-accounts` makes when it can — is left to the user, with the
 *  account to compare against. Not raised for an expired or unreachable
 *  lookup: the listing row already says that, and its remedy comes first. */
export function gcpIdentityNotes(listing: GcpListingIdentity, download: GcpDownloadIdentity): GcpIdentityNote[] {
  if (download.kind !== 'gcloud' || download.principal.kind !== 'account' || download.principal.account === null) return [];
  if (listingSide(listing)?.principal.status !== 'unrecorded') return [];
  return [{
    kind: 'listing-account-unrecorded',
    downloadAccount: download.principal.account,
    downloadTarget: download.impersonate?.target ?? null,
  }];
}

/** The provider fields that decide how a provider lists. */
export interface GcpProviderCredentialOptions {
  readonly keyFile?: string | undefined;
  readonly impersonateServiceAccount?: string | undefined;
}

/** The impersonation the app's ADC Sign in button must keep, as the
 *  `--impersonate-service-account` value — or null for a plain sign-in.
 *
 *  A provider with neither a reader nor a key file lists through ADC as it
 *  is. When ADC is a legacy impersonated file, that provider reads as the
 *  file's service account; a plain sign-in would silently widen it to the
 *  user's own access. So while any such provider exists, signing in again
 *  re-creates the same impersonation (delegation chain included). Once every
 *  provider names its reader, the plain sign-in is safe. Only well-formed
 *  service-account addresses are passed on: the value becomes an argv
 *  entry. */
export function adcLoginImpersonationToKeep(
  adcContent: unknown,
  providers: readonly GcpProviderCredentialOptions[],
): string | null {
  const legacy = classifyImpersonatedAdc(adcContent);
  if (legacy.kind !== 'impersonated') return null;
  if (!providers.some(p => p.impersonateServiceAccount === undefined && p.keyFile === undefined)) return null;
  const chain = [...legacy.delegates, legacy.target];
  return chain.every(isArgvSafeServiceAccount) ? chain.join(',') : null;
}

/** Any Google service-account address — user-created (`*.iam`) or
 *  Google-managed (`*-compute@developer`, `*@appspot`) — and nothing an argv
 *  entry or a Windows shell could misread. Looser than `isServiceAccountEmail`
 *  (the reader a provider may NAME) on purpose: refusing a managed account
 *  here would fall back to a plain sign-in and widen the provider. */
function isArgvSafeServiceAccount(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]*@[a-z0-9][a-z0-9.-]*\.gserviceaccount\.com$/.test(value);
}
