import {
  activeGcloudConfigPath,
  activeGcloudConfiguration,
  adcCredentialsLocation,
  adcLoginPath,
  applyProviderImpersonation,
  assembleDownloadIdentity,
  emailFromIdToken,
  logger,
  gcloudEnvFacts,
  gcloudImpersonationSetting,
  gcloudTokenWins,
  gcpIdentityNotes,
  gcpIdentityWarnings,
  grantsEmailScope,
  isPathPlaceholder,
  looksLikeFilePath,
  parseAdcJson,
  parseGcloudConfigList,
  parseJsonObject,
  resolveListingIdentity,
  summarizeCredentialFile,
} from '@costgoblin/core';
import { readFile } from 'node:fs/promises';
import type {
  AccountLookupFn,
  AuthorizedUserSecret,
  CostGoblinConfig,
  CredentialFileSummary,
  GcloudConfigValues,
  GcloudEnvFacts,
  GcpAccountLookup,
  GcpCredentialFile,
  GcpDownloadIdentity,
  GcpIdentities,
  GcpIdentityResult,
  GcpListingIdentity,
} from '@costgoblin/core';
import type { GcloudCaptureResult } from './gcloud-capture.js';
import { runGcloudCapture } from './gcloud-capture.js';

/** Main-process half of the "Signed in as" panel: the I/O around core's pure
 *  `gcp-identity.ts`. Read-only throughout — it reads credential files and
 *  gcloud's `active_config`, runs one `gcloud config list`, and makes at most
 *  two round trips to Google (a token refresh, then tokeninfo only when the
 *  refresh did not name the account but could have) to name a user. It never
 *  writes gcloud's config, never prints a token, and never returns one: only
 *  emails, configuration names and paths leave this module. */

/** Ceiling on the `gcloud config list` read. It touches no network, but the
 *  CLI can stall on a first-run prompt and the panel must not spin forever. */
const GCLOUD_CONFIG_TIMEOUT_MS = 15_000;

/** Per-request ceiling on naming an ADC user. Enforced by gaxios itself, so
 *  a stalled request is aborted rather than abandoned still running. */
const ACCOUNT_LOOKUP_REQUEST_TIMEOUT_MS = 8_000;

/** Long gcloud failure text is truncated: it lands in a compact panel. */
const MAX_CLI_ERROR_LENGTH = 300;

/** The provider fields that change which identity runs. Undefined fields are
 *  the wizard's case: no provider exists yet. */
export interface IdentityProviderOptions {
  readonly keyFile?: string | undefined;
  readonly impersonateServiceAccount?: string | undefined;
}

export interface IdentityDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  /** Rejects with an ErrnoException; `ENOENT` means "no such file". */
  readonly readFile: (path: string) => Promise<string>;
  readonly runGcloud: (args: readonly string[]) => Promise<GcloudCaptureResult>;
  readonly lookupEmail: AccountLookupFn;
}

type GcloudState =
  | {
    readonly kind: 'ok';
    readonly config: GcloudConfigValues;
    readonly configuration: string;
    readonly facts: GcloudEnvFacts;
    /** gcloud's own `auth/credential_file_override`, described — null when
     *  unset, or not consulted because a token outranks it. */
    readonly overrideFile: CredentialFileSummary | null;
  }
  | { readonly kind: 'cli-missing' }
  | { readonly kind: 'cli-error'; readonly message: string };

function isEnoent(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT';
}

/** Describe one credential file the way the SDK will read it. A missing
 *  ADC file means "not signed in"; a missing key file is a broken config. */
async function describeCredentialFile(file: GcpCredentialFile, deps: IdentityDeps): Promise<GcpListingIdentity> {
  // A value that was not a path (pasted credential JSON) is shown redacted;
  // there is nothing to read.
  if (isPathPlaceholder(file.path)) return { kind: 'unreadable', file };
  let text: string;
  try {
    text = await deps.readFile(file.path);
  } catch (err: unknown) {
    return isEnoent(err) && file.origin !== 'key-file'
      ? { kind: 'not-signed-in', file }
      : { kind: 'unreadable', file };
  }
  return resolveListingIdentity(parseAdcJson(parseJsonObject(text)), file, deps.lookupEmail);
}

async function readAdc(deps: IdentityDeps): Promise<GcpListingIdentity> {
  const location = adcCredentialsLocation(deps.env, deps.platform);
  return location === null ? { kind: 'not-signed-in', file: null } : describeCredentialFile(location, deps);
}

function truncate(message: string): string {
  return message.length > MAX_CLI_ERROR_LENGTH ? `${message.slice(0, MAX_CLI_ERROR_LENGTH)}…` : message;
}

async function readActiveConfigFile(deps: IdentityDeps): Promise<string | null> {
  const path = activeGcloudConfigPath(deps.env, deps.platform);
  if (path === null) return null;
  try {
    return await deps.readFile(path);
  } catch {
    // Absent until a second configuration is ever created: gcloud then
    // uses `default`, which `activeGcloudConfiguration` falls back to.
    return null;
  }
}

/** gcloud's effective credential configuration, from ONE spawn:
 *  `config list --format=json` reports env overrides (`CLOUDSDK_CORE_ACCOUNT`,
 *  `CLOUDSDK_AUTH_*`) as well as the active configuration's file — exactly
 *  what a spawned rsync resolves. The configuration's name is read from disk
 *  instead of a second spawn. */
async function readGcloud(deps: IdentityDeps): Promise<GcloudState> {
  const [result, activeConfigFile] = await Promise.all([
    deps.runGcloud(['config', 'list', '--format=json']),
    readActiveConfigFile(deps),
  ]);
  switch (result.kind) {
    case 'missing': return { kind: 'cli-missing' };
    case 'timeout': return { kind: 'cli-error', message: 'Timed out waiting for gcloud.' };
    case 'failed': return { kind: 'cli-error', message: truncate(result.message) };
    case 'exited': break;
  }
  if (result.code !== 0) {
    const text = result.stderr.trim();
    return { kind: 'cli-error', message: truncate(text.length > 0 ? text : `gcloud exited with code ${String(result.code)}`) };
  }
  const config = parseGcloudConfigList(result.stdout);
  if (config === null) {
    return { kind: 'cli-error', message: 'gcloud printed something other than its configuration. Run `gcloud config list` in a terminal to see what.' };
  }
  const facts = gcloudEnvFacts(deps.env);
  // gcloud never consults its credential file override while a token wins,
  // so neither does this: describing it could mean a token refresh against
  // a credential the download does not use.
  const override = config.credentialFileOverride;
  const overrideIdentity = override === null || gcloudTokenWins(config, facts) || !looksLikeFilePath(override)
    ? null
    : await describeCredentialFile({ path: override, origin: 'key-file' }, deps);
  return {
    kind: 'ok',
    config,
    configuration: activeGcloudConfiguration(deps.env, activeConfigFile),
    facts,
    overrideFile: overrideIdentity === null ? null : summarizeCredentialFile(overrideIdentity),
  };
}

function downloadIdentity(gcloud: GcloudState, provider: IdentityProviderOptions, keyListing: GcpListingIdentity | null): GcpDownloadIdentity {
  if (gcloud.kind !== 'ok') return gcloud;
  return assembleDownloadIdentity({
    config: gcloud.config,
    configuration: gcloud.configuration,
    facts: gcloud.facts,
    providerKeyFile: provider.keyFile === undefined
      ? null
      : { path: provider.keyFile, summary: keyListing === null ? { email: null, impersonates: null } : summarizeCredentialFile(keyListing) },
    providerTarget: provider.impersonateServiceAccount ?? null,
    overrideFile: gcloud.overrideFile,
  });
}

/** Share one in-flight run among concurrent callers, and only while it is in
 *  flight: Data Management mounts one panel per GCP provider at once, all
 *  asking about the same machine-wide credentials, but a later Re-check (the
 *  user may just have signed in) must never be served an earlier answer. */
function coalesce<T>(run: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return () => {
    if (inFlight !== null) return inFlight;
    const started = run();
    inFlight = started;
    const clear = (): void => { if (inFlight === started) inFlight = null; };
    started.then(clear, clear);
    return started;
  };
}

export interface GcpIdentityResolver {
  resolve(provider: IdentityProviderOptions): Promise<GcpIdentities>;
}

export function createGcpIdentityResolver(deps: IdentityDeps): GcpIdentityResolver {
  const gcloud = coalesce(() => readGcloud(deps));
  const adc = coalesce(() => readAdc(deps));
  return {
    async resolve(provider) {
      // A key file drives listing (the SDK's keyFilename) and the download
      // (CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE) alike, so ADC is not read.
      const keyListing = provider.keyFile === undefined ? null : describeCredentialFile({ path: provider.keyFile, origin: 'key-file' }, deps);
      const [gcloudState, credential] = await Promise.all([gcloud(), keyListing ?? adc()]);
      // ADC is machine-wide and read once; the provider's reader is applied
      // per provider on top of it, exactly as `createGcsStorage` does.
      const listing = keyListing === null ? applyProviderImpersonation(credential, provider.impersonateServiceAccount ?? null) : credential;
      const download = downloadIdentity(gcloudState, provider, keyListing === null ? null : credential);
      return {
        listing,
        download,
        adcLoginPath: keyListing === null ? adcLoginPath(deps.env, deps.platform) : null,
        gcloudImpersonation: gcloudState.kind === 'ok' ? gcloudImpersonationSetting(gcloudState.config, gcloudState.facts) : null,
        warnings: gcpIdentityWarnings(listing, download),
        notes: gcpIdentityNotes(listing, download),
      };
    },
  };
}

/** Name an ADC user: refresh the credential (the same call the Cloud Storage
 *  SDK makes on its first request) and read the email from the id_token the
 *  refresh returns, falling back to tokeninfo. The access token is used only
 *  to ask tokeninfo who it belongs to; neither token leaves this function.
 *
 *  Both routes need an email scope. A plain `application-default login`
 *  grants one; the impersonated variant does not (verified against gcloud
 *  578: its source token carries `cloud-platform` alone), so when the
 *  refresh's granted scopes rule it out the answer is `not-recorded` with no
 *  second round trip. */
export async function lookupAuthorizedUserEmail(secret: AuthorizedUserSecret): Promise<GcpAccountLookup> {
  const { UserRefreshClient } = await import('google-auth-library');
  const client = new UserRefreshClient({
    clientId: secret.clientId,
    clientSecret: secret.clientSecret,
    refreshToken: secret.refreshToken,
    transporterOptions: { timeout: ACCOUNT_LOOKUP_REQUEST_TIMEOUT_MS },
  });
  const { token } = await client.getAccessToken();
  const idToken = client.credentials.id_token;
  if (typeof idToken === 'string') {
    const email = emailFromIdToken(idToken);
    if (email !== null) return { status: 'known', email };
  }
  if (grantsEmailScope(client.credentials.scope) === false) return { status: 'unknown', reason: 'not-recorded' };
  if (typeof token !== 'string' || token.length === 0) return { status: 'unknown', reason: 'expired' };
  const info = await client.getTokenInfo(token);
  return typeof info.email === 'string' && info.email.length > 0
    ? { status: 'known', email: info.email }
    : { status: 'unknown', reason: 'not-recorded' };
}

/** The real I/O, for the IPC handler. Synchronous on purpose: the handler
 *  creates its one resolver on first use, and an `await` there would let the
 *  first burst of panels each create their own — defeating the coalescing. */
export function defaultIdentityDeps(): IdentityDeps {
  return {
    env: process.env,
    platform: process.platform,
    readFile: (path) => readFile(path, 'utf8'),
    runGcloud: (args) => runGcloudCapture(args, GCLOUD_CONFIG_TIMEOUT_MS),
    lookupEmail: lookupAuthorizedUserEmail,
  };
}

/** The `data:gcp-identities` handler's body, kept out of `handlers/setup.ts`
 *  so it can be tested without Electron. `rawProvider` arrives over IPC, so
 *  it is narrowed here: a string names a provider whose `keyFile` /
 *  `impersonateServiceAccount` apply; anything else is the wizard's "no
 *  provider yet". */
export async function gcpIdentitiesFor(
  rawProvider: unknown,
  loadConfig: () => Promise<CostGoblinConfig | null>,
  resolver: () => GcpIdentityResolver,
): Promise<GcpIdentityResult> {
  let provider: IdentityProviderOptions = {};
  if (typeof rawProvider === 'string') {
    // The wizard runs before a config exists, so a load failure is only an
    // error when a provider was actually named.
    const config = await loadConfig();
    const named = config?.providers.find(p => String(p.name) === rawProvider);
    if (named === undefined) return { status: 'unavailable', reason: `No provider named "${rawProvider}" is configured.` };
    if (named.type !== 'gcp') return { status: 'unavailable', reason: `"${rawProvider}" is not a Google Cloud provider.` };
    provider = named;
  }
  try {
    return { status: 'ok', identities: await resolver().resolve(provider) };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.info('data:gcp-identities failed', { error: message });
    return { status: 'unavailable', reason: message };
  }
}
