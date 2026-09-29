/**
 * Cuts the Electron processes the e2e suites spawn off from every cloud
 * credential on the machine running them.
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
 * variable a cloud SDK reads credentials, profiles, projects or endpoints
 * from, then pins each discovery location inside a throwaway sandbox
 * directory that holds no credentials. Checked against the SDKs this repo
 * actually ships (google-auth-library 9, gcp-metadata 6, @aws-sdk/*
 * credential-provider-node 3, the gcloud CLI):
 *
 * - `GOOGLE_APPLICATION_CREDENTIALS` must be SET, not merely unset. With it
 *   unset, google-auth-library falls through to the well-known ADC file under
 *   `$HOME/.config/gcloud` (`%APPDATA%\gcloud` on Windows) and it does NOT
 *   honour `CLOUDSDK_CONFIG` — only `$HOME`, which cannot be moved without
 *   also moving Electron's and the Keychain's view of home. Pointing it at a
 *   missing file makes ADC throw before that lookup ever happens.
 * - `CLOUDSDK_CONFIG` redirects the gcloud CLI: the `gcloud storage rsync`
 *   downloads, the setup wizard's `gcloud projects list`, and
 *   google-auth-library's own `gcloud config config-helper` project probe.
 * - `METADATA_SERVER_DETECTION=none` stops gcp-metadata pinging the GCE
 *   metadata server, so a check fails immediately offline rather than after a
 *   network timeout.
 * - `AWS_CONFIG_FILE` / `AWS_SHARED_CREDENTIALS_FILE` gate every profile-based
 *   AWS provider (SSO, ini, credential_process, `aws login`). The SSO token
 *   cache path is not configurable, but it is only reached through a profile
 *   in the config file, which no longer exists. `AWS_LOGIN_CACHE_DIRECTORY` is
 *   pinned as well so no `aws login` session is found either.
 * - `AWS_EC2_METADATA_DISABLED=true` stops the default chain from probing the
 *   EC2 instance metadata service at the end of the chain.
 *
 * Pure: no I/O. The e2e helpers create the directory and own its cleanup.
 *
 * A new cloud provider brings a new SDK with its own discovery variables —
 * add them to `CLOUD_ENV_PREFIXES` / `CLOUD_ENV_NAMES` and pin them in
 * `cloudSandboxEnv`, or the suites will reach that cloud as the developer.
 *
 * Lives under `packages/core/src` rather than `e2e/` for the same reason as
 * `e2e-coverage/`: `e2e/` is outside every `npm run check` gate, and this is
 * the one piece of the harness whose silent breakage leaks credentials.
 */

import { join } from 'node:path';

/** Inherited variables starting with any of these are dropped, matched
 *  case-insensitively: google-auth-library also reads the lowercase
 *  `google_application_credentials` / `gcloud_project`, and Windows env names
 *  are case-insensitive anyway. Whole prefixes rather than an allow-list of
 *  names, because a single missed name is a credential leak — `AWS_PROFILE`,
 *  `AWS_ACCESS_KEY_ID`, `AWS_WEB_IDENTITY_TOKEN_FILE`, `AWS_CONTAINER_*`,
 *  `AWS_ENDPOINT_URL*`, `GOOGLE_CLOUD_PROJECT`,
 *  `CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE`, `CLOUDSDK_CORE_ACCOUNT`, … */
const CLOUD_ENV_PREFIXES = ['AWS_', 'GOOGLE_', 'GCLOUD_', 'CLOUDSDK_', 'GCE_METADATA_'] as const;

/** Exact names outside those prefixes: the Cloud Storage SDK's endpoint
 *  redirect, and the metadata-server switch pinned below. */
const CLOUD_ENV_NAMES = ['STORAGE_EMULATOR_HOST', 'METADATA_SERVER_DETECTION'] as const;

/** Where each credential lookup is pointed. None of these files exist; the
 *  gcloud config dir is created empty by the e2e helpers. */
export interface CloudSandboxPaths {
  readonly awsConfigFile: string;
  readonly awsSharedCredentialsFile: string;
  readonly awsLoginCacheDir: string;
  readonly gcloudConfigDir: string;
  /** Where `gcloud auth application-default login` would write ADC for this
   *  config dir — so the sandbox stays self-consistent — and never does. */
  readonly googleApplicationCredentials: string;
}

export function cloudSandboxPaths(sandboxDir: string): CloudSandboxPaths {
  const gcloudConfigDir = join(sandboxDir, 'gcloud');
  return {
    awsConfigFile: join(sandboxDir, 'aws', 'config'),
    awsSharedCredentialsFile: join(sandboxDir, 'aws', 'credentials'),
    awsLoginCacheDir: join(sandboxDir, 'aws', 'login', 'cache'),
    gcloudConfigDir,
    googleApplicationCredentials: join(gcloudConfigDir, 'application_default_credentials.json'),
  };
}

/** Whether a cloud SDK reads this variable for credentials, profiles,
 *  projects or endpoints — i.e. whether it must never be inherited. */
export function isCloudEnvVar(name: string): boolean {
  const upper = name.toUpperCase();
  return CLOUD_ENV_PREFIXES.some(prefix => upper.startsWith(prefix))
    || CLOUD_ENV_NAMES.some(exact => upper === exact);
}

/** The only cloud variables a sandboxed launch carries, and their values. */
function pinnedCloudEnv(sandboxDir: string): Readonly<Record<string, string>> {
  const paths = cloudSandboxPaths(sandboxDir);
  return {
    AWS_CONFIG_FILE: paths.awsConfigFile,
    AWS_SHARED_CREDENTIALS_FILE: paths.awsSharedCredentialsFile,
    AWS_LOGIN_CACHE_DIRECTORY: paths.awsLoginCacheDir,
    AWS_EC2_METADATA_DISABLED: 'true',
    CLOUDSDK_CONFIG: paths.gcloudConfigDir,
    GOOGLE_APPLICATION_CREDENTIALS: paths.googleApplicationCredentials,
    METADATA_SERVER_DETECTION: 'none',
  };
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
  return { ...env, ...pinnedCloudEnv(sandboxDir) };
}

/** Every way `env` departs from a launch sandboxed into `sandboxDir`: a cloud
 *  variable that is not one of the pins (inherited, or re-added by a caller),
 *  or a pin that is missing or points elsewhere. Empty means the process can
 *  only find the sandbox's (absent) credentials. */
export function cloudSandboxViolations(
  env: Readonly<Record<string, string | undefined>>,
  sandboxDir: string,
): string[] {
  const pinned = pinnedCloudEnv(sandboxDir);
  const violations: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || !isCloudEnvVar(name) || Object.hasOwn(pinned, name)) continue;
    violations.push(`${name} must not reach the app (set to ${JSON.stringify(value)})`);
  }
  for (const [name, expected] of Object.entries(pinned)) {
    const actual = env[name];
    if (actual !== expected) {
      violations.push(`${name} must be ${JSON.stringify(expected)}, got ${actual === undefined ? 'unset' : JSON.stringify(actual)}`);
    }
  }
  return violations;
}
