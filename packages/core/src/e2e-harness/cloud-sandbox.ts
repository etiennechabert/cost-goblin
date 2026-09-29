/**
 * Cuts the Electron processes the e2e suites spawn off from the cloud
 * credentials of the machine running them.
 *
 * The suites used to launch the app with a bare `...process.env`. In CI that
 * is harmless — the runner holds no cloud credentials, so every availability
 * check fails fast and the app falls back to the local fixture inventory. On a
 * developer machine the same launch picked up the developer's gcloud
 * Application Default Credentials and AWS profiles, and the app issued REAL
 * Cloud Storage / S3 requests for the fixture buckets as that developer. The
 * visible symptom was the GCP provider card stuck on "Checking Cloud
 * Storage..." while a real request ran; the real problem is that a test run
 * can reach a real cloud account at all.
 *
 * `cloudSandboxEnv` builds the launch env instead: it drops every inherited
 * variable a provider's SDK or CLI reads credentials, profiles, projects or
 * endpoints from, then pins each discovery location inside a throwaway sandbox
 * directory that holds no credentials. The rules live in `PROVIDER_SANDBOXES`,
 * keyed on the provider type union: adding a provider to `ProviderConfig`
 * fails core's type-check here until its SDK's discovery is covered.
 *
 * Scope is AMBIENT discovery — environment variables, the default credential
 * file locations, metadata services. Credentials a config under test names
 * explicitly (a GCP `keyFile`) are used as named; the fixture configs name
 * none, so pointing a launch at a real config means accepting that.
 *
 * Checked against the SDKs and CLIs the app ships (google-auth-library 9,
 * gcp-metadata 6, @google-cloud/storage 7, @aws-sdk credential-provider-node
 * 3, the gcloud CLI):
 *
 * - `GOOGLE_APPLICATION_CREDENTIALS` must be SET, not merely unset. Unset (or
 *   empty), google-auth-library falls through to the well-known ADC file under
 *   `$HOME/.config/gcloud` (`%APPDATA%\gcloud` on Windows) and does NOT honour
 *   `CLOUDSDK_CONFIG` — only `$HOME`, which cannot be moved without also moving
 *   Electron's and the Keychain's view of home. Pointing it at a missing file
 *   makes ADC reject before that lookup happens.
 *   Trade-off: the app then sees "The file at … does not exist", which it does
 *   not classify as a credential error, instead of the NO_ADC_FOUND a
 *   signed-out user gets. That is deliberate — on NO_ADC_FOUND,
 *   @google-cloud/storage retries the request anonymously, so the run would
 *   still reach storage.googleapis.com. Test the signed-out UX below e2e.
 * - `METADATA_SERVER_DETECTION=none` stops gcp-metadata's availability ping to
 *   the GCE metadata server, so a check fails immediately offline.
 * - `CLOUDSDK_CONFIG` moves the gcloud CLI's user config and credential store
 *   (the `gcloud storage rsync` downloads, the wizard's `gcloud projects list`,
 *   google-auth-library's `gcloud config config-helper` probe). It does not
 *   cover installation-scope properties (`<sdk_root>/properties`) or gcloud's
 *   own GCE metadata fallback, so `CLOUDSDK_AUTH_ACCESS_TOKEN_FILE` points at a
 *   missing file — it outranks every other gcloud credential source,
 *   installation scope and the app's keyFile override included, so any
 *   invocation fails fast — and the remaining gcloud pins keep the CLI off the
 *   metadata server and dl.google.com.
 * - `AWS_CONFIG_FILE` / `AWS_SHARED_CREDENTIALS_FILE` gate every profile-based
 *   AWS provider (SSO, ini, credential_process, `aws login`), in the SDK and in
 *   the aws CLI alike. The SSO token cache path is not configurable, but it is
 *   only reached through a profile in the config file, which does not exist.
 *   `AWS_LOGIN_CACHE_DIRECTORY` is pinned as well, and
 *   `AWS_EC2_METADATA_DISABLED=true` stops the default chain probing the EC2
 *   instance metadata service at its end.
 *
 * Pure: no I/O. The e2e helpers create the directories and own the cleanup.
 *
 * Lives under `packages/core/src` rather than `e2e/` for the same reason as
 * `e2e-coverage/`: `e2e/` is outside every `npm run check` gate, and this is
 * the one piece of the harness whose silent breakage leaks credentials.
 */

import { join } from 'node:path';
import type { ProviderConfig } from '../types/config.js';

interface ProviderSandbox {
  /** Inherited variables starting with any of these are dropped, matched
   *  case-insensitively: google-auth-library also reads the lowercase
   *  `google_application_credentials` / `gcloud_project`, and Windows env
   *  names are case-insensitive anyway. Whole prefixes rather than a list of
   *  names, because one missed name is a credential leak. */
  readonly prefixes: readonly string[];
  /** Exact names outside those prefixes, dropped the same way. */
  readonly names: readonly string[];
  /** The only values of this provider's variables a sandboxed launch carries.
   *  Every path names a location inside the sandbox that holds nothing. */
  readonly pins: (sandboxDir: string) => Readonly<Record<string, string>>;
}

const AWS_DIR = 'aws';
const GCLOUD_DIR = 'gcloud';

function gcloudConfigDir(sandboxDir: string): string {
  return join(sandboxDir, GCLOUD_DIR);
}

const PROVIDER_SANDBOXES: Readonly<Record<ProviderConfig['type'], ProviderSandbox>> = {
  aws: {
    // AWS_PROFILE, AWS_ACCESS_KEY_ID, AWS_WEB_IDENTITY_TOKEN_FILE,
    // AWS_CONTAINER_*, AWS_ENDPOINT_URL*, AWS_REGION, …
    prefixes: ['AWS_'],
    names: [],
    pins: sandboxDir => ({
      AWS_CONFIG_FILE: join(sandboxDir, AWS_DIR, 'config'),
      AWS_SHARED_CREDENTIALS_FILE: join(sandboxDir, AWS_DIR, 'credentials'),
      AWS_LOGIN_CACHE_DIRECTORY: join(sandboxDir, AWS_DIR, 'login', 'cache'),
      AWS_EC2_METADATA_DISABLED: 'true',
    }),
  },
  gcp: {
    // GOOGLE_CLOUD_PROJECT, CLOUDSDK_CORE_ACCOUNT,
    // CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE, GCE_METADATA_HOST, …, plus the
    // Cloud Storage SDK's endpoint redirect.
    prefixes: ['GOOGLE_', 'GCLOUD_', 'CLOUDSDK_', 'GCE_METADATA_'],
    names: ['STORAGE_EMULATOR_HOST', 'METADATA_SERVER_DETECTION'],
    pins: sandboxDir => ({
      // Where `gcloud auth application-default login` would write ADC for this
      // config dir — so the sandbox stays self-consistent — and never does.
      GOOGLE_APPLICATION_CREDENTIALS: join(gcloudConfigDir(sandboxDir), 'application_default_credentials.json'),
      METADATA_SERVER_DETECTION: 'none',
      CLOUDSDK_CONFIG: gcloudConfigDir(sandboxDir),
      CLOUDSDK_AUTH_ACCESS_TOKEN_FILE: join(gcloudConfigDir(sandboxDir), 'access_token'),
      // An installation-scope `auth/disable_credentials` would otherwise turn
      // the token-file failure into unauthenticated API calls.
      CLOUDSDK_AUTH_DISABLE_CREDENTIALS: 'false',
      CLOUDSDK_CORE_CHECK_GCE_METADATA: 'false',
      // Without it the User-Agent build probes the metadata server.
      CLOUDSDK_METRICS_ENVIRONMENT: 'costgoblin-e2e',
      CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK: 'true',
    }),
  },
};

const PROVIDERS = Object.values(PROVIDER_SANDBOXES);

/** Whether a provider's SDK or CLI reads this variable for credentials,
 *  profiles, projects or endpoints — i.e. whether it must never be inherited. */
export function isCloudEnvVar(name: string): boolean {
  const upper = name.toUpperCase();
  return PROVIDERS.some(provider =>
    provider.prefixes.some(prefix => upper.startsWith(prefix))
    || provider.names.some(exact => upper === exact));
}

/** Every pin, across providers: the only cloud variables a sandboxed launch
 *  carries, and their values. */
export function cloudSandboxPins(sandboxDir: string): Readonly<Record<string, string>> {
  const pins: Record<string, string> = {};
  for (const provider of PROVIDERS) Object.assign(pins, provider.pins(sandboxDir));
  return pins;
}

/** Directories to create (empty) before a launch: gcloud expects its config
 *  dir to exist. Every other pinned location must stay absent. */
export function cloudSandboxDirs(sandboxDir: string): string[] {
  return [gcloudConfigDir(sandboxDir)];
}

/** `inherited` minus every cloud variable, plus the sandbox pins. Unset
 *  (`undefined`) entries are dropped, so the result is a plain launch env. */
export function cloudSandboxEnv(
  inherited: Readonly<Record<string, string | undefined>>,
  sandboxDir: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(inherited)) {
    if (value === undefined || isCloudEnvVar(name)) continue;
    env[name] = value;
  }
  return { ...env, ...cloudSandboxPins(sandboxDir) };
}

/** Every way `env` departs from a launch sandboxed into `sandboxDir`: a cloud
 *  variable that is not a pin (inherited, or re-added by a caller), or a pin
 *  that is missing or overridden. Empty means the process can only find the
 *  sandbox's (absent) credentials.
 *
 *  Messages name variables, never their values: they are printed exactly when
 *  the sandbox has regressed, which is when a value is a live secret. */
export function cloudSandboxViolations(
  env: Readonly<Record<string, string | undefined>>,
  sandboxDir: string,
): string[] {
  const pins = cloudSandboxPins(sandboxDir);
  const violations: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || !isCloudEnvVar(name) || Object.hasOwn(pins, name)) continue;
    violations.push(`${name} must not reach the app`);
  }
  for (const [name, expected] of Object.entries(pins)) {
    const actual = env[name];
    if (actual !== expected) {
      violations.push(`${name} must be ${JSON.stringify(expected)} (${actual === undefined ? 'unset' : 'overridden'})`);
    }
  }
  return violations;
}

/** Names gcloud keeps credentials under in its config dir, besides the ADC
 *  and token files the pins point at. */
const GCLOUD_CREDENTIAL_STORES = new Set([
  'application_default_credentials.json',
  'access_token',
  'credentials.db',
  'access_tokens.db',
  'legacy_credentials',
]);

/** Of the sandbox's entries (paths relative to it, either separator), those
 *  holding credentials: anything under `aws/` — every AWS pin lives there and
 *  must stay absent — and any gcloud credential store, which is where a
 *  sign-in completed during a run would land. */
export function cloudSandboxCredentialStores(entries: readonly string[]): string[] {
  return entries.filter(entry => {
    const [top, ...rest] = entry.split(/[\\/]/);
    return top === AWS_DIR || (top === GCLOUD_DIR && rest.some(part => GCLOUD_CREDENTIAL_STORES.has(part)));
  });
}
