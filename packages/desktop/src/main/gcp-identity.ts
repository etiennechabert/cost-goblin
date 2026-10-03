import {
  adcCredentialsLocation,
  emailFromIdToken,
  findGcloudCli,
  gcloudChildPath,
  gcloudSpawnShape,
  gcpIdentityNotes,
  gcpIdentityWarnings,
  parseActiveGcloudConfiguration,
  parseAdcJson,
  parseGcloudConfigValue,
  parseServiceAccountKeyEmail,
  resolveListingIdentity,
} from '@costgoblin/core';
import type {
  AccountLookupFn,
  AuthorizedUserSecret,
  GcpAccountLookup,
  GcpDownloadIdentity,
  GcpIdentities,
  GcpListingIdentity,
} from '@costgoblin/core';

/** Main-process half of the "Signed in as" panel: the I/O around core's pure
 *  `gcp-identity.ts`. Read-only throughout — it reads two credential files,
 *  runs two `gcloud config` reads, and makes at most one round trip to
 *  Google to name a user. It never writes gcloud's config, never prints a
 *  token, and never returns one: only emails, configuration names and paths
 *  leave this module. */

/** Ceiling on each `gcloud config` read. They touch no network, but the CLI
 *  can stall on a first-run prompt (stdin is ignored, so it would wait
 *  forever) and the panel must not spin indefinitely. */
const GCLOUD_CONFIG_TIMEOUT_MS = 15_000;

/** Ceiling on naming an ADC user (refresh + optional tokeninfo). */
const ACCOUNT_LOOKUP_TIMEOUT_MS = 10_000;

/** Long gcloud failure text is truncated: it lands in a compact panel. */
const MAX_CLI_ERROR_LENGTH = 300;

/** The provider fields that change which identity runs. Undefined fields are
 *  the wizard's case: no provider exists yet. */
export interface IdentityProviderOptions {
  readonly keyFile?: string | undefined;
  readonly impersonateServiceAccount?: string | undefined;
}

export type GcloudRunResult =
  | { readonly kind: 'missing' }
  | { readonly kind: 'exited'; readonly code: number | null; readonly stdout: string; readonly stderr: string }
  | { readonly kind: 'failed'; readonly message: string };

export interface IdentityDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  /** Rejects with an ErrnoException; `ENOENT` means "no such file". */
  readonly readFile: (path: string) => Promise<string>;
  readonly runGcloud: (args: readonly string[]) => Promise<GcloudRunResult>;
  readonly lookupEmail: AccountLookupFn;
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT';
}

function parseJson(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return null;
  }
}

/** Read the email out of a provider's service-account key. Null when the file
 *  is missing, unreadable or not a key. */
async function readKeyFileEmail(keyFile: string, deps: IdentityDeps): Promise<string | null> {
  try {
    return parseServiceAccountKeyEmail(parseJson(await deps.readFile(keyFile)));
  } catch {
    return null;
  }
}

async function readListingIdentity(provider: IdentityProviderOptions, deps: IdentityDeps, keyFileEmail: string | null): Promise<GcpListingIdentity> {
  if (provider.keyFile !== undefined) {
    return keyFileEmail === null
      ? { kind: 'unreadable', credentialsPath: provider.keyFile }
      : { kind: 'service-account', credentialsPath: provider.keyFile, email: keyFileEmail, origin: 'key-file' };
  }
  const location = adcCredentialsLocation(deps.env, deps.platform);
  if (location === null) return { kind: 'not-signed-in', credentialsPath: null };
  let text: string;
  try {
    text = await deps.readFile(location.path);
  } catch (err: unknown) {
    return isEnoent(err)
      ? { kind: 'not-signed-in', credentialsPath: location.path }
      : { kind: 'unreadable', credentialsPath: location.path };
  }
  return resolveListingIdentity(parseAdcJson(parseJson(text)), location.path, deps.lookupEmail);
}

function cliErrorMessage(result: Extract<GcloudRunResult, { kind: 'exited' }>): string {
  const text = result.stderr.trim();
  const message = text.length > 0 ? text : `gcloud exited with code ${String(result.code)}`;
  return message.length > MAX_CLI_ERROR_LENGTH ? `${message.slice(0, MAX_CLI_ERROR_LENGTH)}…` : message;
}

async function readDownloadIdentity(provider: IdentityProviderOptions, deps: IdentityDeps, keyFileEmail: string | null): Promise<GcpDownloadIdentity> {
  // A key file reaches `gcloud storage rsync` through
  // CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE, so gcloud's active account plays
  // no part in the download — no need to ask gcloud at all.
  if (provider.keyFile !== undefined) {
    return { kind: 'key-file', keyFile: provider.keyFile, email: keyFileEmail };
  }
  // `get-value` reports the effective value, env overrides
  // (CLOUDSDK_CORE_ACCOUNT) included — exactly what a spawned rsync sees.
  const [account, configurations] = await Promise.all([
    deps.runGcloud(['config', 'get-value', 'account']),
    deps.runGcloud(['config', 'configurations', 'list', '--format=json']),
  ]);
  if (account.kind === 'missing') return { kind: 'cli-missing' };
  if (account.kind === 'failed') return { kind: 'cli-error', message: account.message };
  if (account.code !== 0) return { kind: 'cli-error', message: cliErrorMessage(account) };
  const configuration = configurations.kind === 'exited' && configurations.code === 0
    ? parseActiveGcloudConfiguration(configurations.stdout)
    : null;
  return {
    kind: 'gcloud',
    account: parseGcloudConfigValue(account.stdout),
    configuration,
    impersonate: provider.impersonateServiceAccount ?? null,
  };
}

/** Both identities and their disagreements, for one provider (or none). */
export async function resolveGcpIdentities(provider: IdentityProviderOptions, deps: IdentityDeps): Promise<GcpIdentities> {
  const keyFileEmail = provider.keyFile === undefined ? null : await readKeyFileEmail(provider.keyFile, deps);
  const [listing, download] = await Promise.all([
    readListingIdentity(provider, deps, keyFileEmail),
    readDownloadIdentity(provider, deps, keyFileEmail),
  ]);
  return {
    listing,
    download,
    warnings: gcpIdentityWarnings(listing, download, provider.impersonateServiceAccount ?? null),
    notes: gcpIdentityNotes(listing, download),
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new Error('Timed out reaching Google')); }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => { clearTimeout(timer); });
}

/** Name an ADC user: refresh the credential (the same call the Cloud Storage
 *  SDK makes on its first request) and read the email from the id_token the
 *  refresh returns, falling back to tokeninfo. The access token is used only
 *  to ask tokeninfo who it belongs to; neither token leaves this function.
 *
 *  Both routes need the email scope. A plain `application-default login`
 *  grants it; the impersonated variant does not (verified against gcloud 578:
 *  the source token's tokeninfo lists `cloud-platform` alone), so for that
 *  file the honest answer is `not-recorded`, not a guess. */
export async function lookupAuthorizedUserEmail(secret: AuthorizedUserSecret): Promise<GcpAccountLookup> {
  const { UserRefreshClient } = await import('google-auth-library');
  const client = new UserRefreshClient({
    clientId: secret.clientId,
    clientSecret: secret.clientSecret,
    refreshToken: secret.refreshToken,
  });
  const { token } = await withTimeout(client.getAccessToken(), ACCOUNT_LOOKUP_TIMEOUT_MS);
  const idToken = client.credentials.id_token;
  if (typeof idToken === 'string') {
    const email = emailFromIdToken(idToken);
    if (email !== null) return { status: 'known', email };
  }
  if (typeof token !== 'string' || token.length === 0) return { status: 'unknown', reason: 'expired' };
  const info = await withTimeout(client.getTokenInfo(token), ACCOUNT_LOOKUP_TIMEOUT_MS);
  return typeof info.email === 'string' && info.email.length > 0
    ? { status: 'known', email: info.email }
    : { status: 'unknown', reason: 'not-recorded' };
}

/** Run a read-only gcloud command through the trusted-binary resolver and
 *  the shared spawn shape — never a bare-name PATH lookup. Inherits the
 *  process env, so an e2e launch's cloud-sandbox pins (`CLOUDSDK_CONFIG`
 *  etc.) apply here exactly as they do to the sync's rsync. */
export async function runGcloudCapture(args: readonly string[]): Promise<GcloudRunResult> {
  const bin = findGcloudCli();
  if (bin === null) return { kind: 'missing' };
  const { spawn } = await import('node:child_process');
  const { StringDecoder } = await import('node:string_decoder');
  let shape: ReturnType<typeof gcloudSpawnShape>;
  try {
    shape = gcloudSpawnShape(bin, args);
  } catch (err: unknown) {
    return { kind: 'failed', message: err instanceof Error ? err.message : String(err) };
  }

  return new Promise<GcloudRunResult>((resolve) => {
    const proc = spawn(shape.command, shape.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: shape.shell,
      env: { ...process.env, PATH: gcloudChildPath(process.env['PATH'] ?? '') },
    });
    const outDecoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: GcloudRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      proc.kill();
      finish({ kind: 'failed', message: 'Timed out waiting for gcloud.' });
    }, GCLOUD_CONFIG_TIMEOUT_MS);

    proc.stdout.on('data', (chunk: Buffer) => { stdout += outDecoder.write(chunk); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += errDecoder.write(chunk); });
    proc.on('error', (err: NodeJS.ErrnoException) => {
      finish(err.code === 'ENOENT' ? { kind: 'missing' } : { kind: 'failed', message: err.message });
    });
    proc.on('close', (code) => {
      stdout += outDecoder.end();
      stderr += errDecoder.end();
      finish({ kind: 'exited', code, stdout, stderr });
    });
  });
}

/** The real I/O, for the IPC handler. */
export async function defaultIdentityDeps(): Promise<IdentityDeps> {
  const { readFile } = await import('node:fs/promises');
  return {
    env: process.env,
    platform: process.platform,
    readFile: (path) => readFile(path, 'utf8'),
    runGcloud: runGcloudCapture,
    lookupEmail: lookupAuthorizedUserEmail,
  };
}
