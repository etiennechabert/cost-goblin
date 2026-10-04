import { readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  cloudSandboxCredentialStores,
  cloudSandboxDirs,
  cloudSandboxEnv,
  cloudSandboxPins,
  cloudSandboxViolations,
  isCloudEnvVar,
} from '../e2e-harness/cloud-sandbox.js';
import { adcCredentialsLocation } from '../sync/gcp-identity.js';

const SANDBOX = join('/tmp', 'costgoblin-e2e-run-abc123', 'cloud-sandbox');
const HOME = join('/Users', 'dev');

/** What a developer's shell plausibly exports: every value here is a way for
 *  the spawned app to find real credentials or talk to a real account. */
const DEVELOPER_CLOUD_ENV: Readonly<Record<string, string>> = {
  AWS_PROFILE: 'prod-admin',
  AWS_DEFAULT_PROFILE: 'prod-admin',
  AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
  AWS_SECRET_ACCESS_KEY: 'secret-example',
  AWS_SESSION_TOKEN: 'session-example',
  AWS_CONFIG_FILE: join(HOME, '.aws', 'config'),
  AWS_SHARED_CREDENTIALS_FILE: join(HOME, '.aws', 'credentials'),
  AWS_WEB_IDENTITY_TOKEN_FILE: join(HOME, 'token'),
  AWS_ROLE_ARN: 'arn:aws:iam::123456789012:role/example',
  AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://127.0.0.1:1338/creds',
  AWS_ENDPOINT_URL_S3: 'https://s3.example.test',
  AWS_REGION: 'eu-west-1',
  GOOGLE_APPLICATION_CREDENTIALS: join(HOME, '.config', 'gcloud', 'application_default_credentials.json'),
  google_application_credentials: join(HOME, 'sa-key.json'),
  GOOGLE_CLOUD_PROJECT: 'billing-prod',
  GOOGLE_CLOUD_QUOTA_PROJECT: 'billing-prod',
  gcloud_project: 'billing-prod',
  GCLOUD_PROJECT: 'billing-prod',
  CLOUDSDK_CONFIG: join(HOME, '.config', 'gcloud'),
  CLOUDSDK_CORE_ACCOUNT: 'dev@example.com',
  CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: join(HOME, 'sa-key.json'),
  CLOUDSDK_AUTH_ACCESS_TOKEN: 'ya29.example',
  GCE_METADATA_HOST: '169.254.169.254',
  STORAGE_EMULATOR_HOST: 'https://storage.example.test',
  METADATA_SERVER_DETECTION: 'assume-present',
};

const ORDINARY_ENV: Readonly<Record<string, string>> = {
  HOME,
  PATH: '/usr/bin:/bin',
  COSTGOBLIN_DATA_DIR: '/tmp/data',
  NODE_OPTIONS: '--max-old-space-size=4096',
  // Contains a cloud prefix, but not AT the start — no SDK reads it.
  MY_AWS_NOTES: 'kept',
};

function isInside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

describe('isCloudEnvVar', () => {
  it('matches every SDK prefix, in any case', () => {
    for (const name of Object.keys(DEVELOPER_CLOUD_ENV)) {
      expect(isCloudEnvVar(name), name).toBe(true);
    }
    expect(isCloudEnvVar('aws_profile')).toBe(true);
    expect(isCloudEnvVar('CloudSdk_Core_Project')).toBe(true);
  });

  it('leaves unrelated variables alone', () => {
    for (const name of Object.keys(ORDINARY_ENV)) {
      expect(isCloudEnvVar(name), name).toBe(false);
    }
    // Not a prefix match: the exact names are exact.
    expect(isCloudEnvVar('STORAGE_EMULATOR_HOSTNAME')).toBe(false);
  });

  it('covers every variable it pins', () => {
    for (const name of Object.keys(cloudSandboxPins(SANDBOX))) {
      expect(isCloudEnvVar(name), name).toBe(true);
    }
  });
});

describe('cloudSandboxEnv', () => {
  const env = cloudSandboxEnv({ ...ORDINARY_ENV, ...DEVELOPER_CLOUD_ENV, UNSET: undefined }, SANDBOX);

  it('carries no inherited cloud variable through', () => {
    for (const name of ['AWS_PROFILE', 'AWS_ACCESS_KEY_ID', 'AWS_SESSION_TOKEN', 'google_application_credentials', 'GOOGLE_CLOUD_PROJECT', 'CLOUDSDK_CORE_ACCOUNT', 'CLOUDSDK_AUTH_ACCESS_TOKEN', 'GCE_METADATA_HOST', 'STORAGE_EMULATOR_HOST']) {
      expect(env, name).not.toHaveProperty(name);
    }
    const inheritedValues = new Set(Object.values(DEVELOPER_CLOUD_ENV));
    expect(Object.entries(env).filter(([, value]) => inheritedValues.has(value))).toEqual([]);
  });

  it('keeps the rest of the inherited env and drops unset entries', () => {
    expect(env).toMatchObject(ORDINARY_ENV);
    expect(env).not.toHaveProperty('UNSET');
  });

  it('points every credential location inside the sandbox', () => {
    const pins = cloudSandboxPins(SANDBOX);
    expect(env).toMatchObject(pins);
    const paths = Object.values(pins).filter(value => isAbsolute(value));
    expect(paths.length).toBeGreaterThanOrEqual(6);
    for (const path of paths) expect(isInside(SANDBOX, path), path).toBe(true);
    // Set, not unset: unset lets google-auth-library fall through to the ADC
    // file under $HOME, which CLOUDSDK_CONFIG does not redirect.
    expect(env['GOOGLE_APPLICATION_CREDENTIALS']).toBe(join(SANDBOX, 'gcloud', 'application_default_credentials.json'));
    expect(cloudSandboxDirs(SANDBOX)).toEqual([env['CLOUDSDK_CONFIG']]);
  });

  it('keeps the SDKs and the gcloud CLI off every metadata server', () => {
    expect(env).toMatchObject({
      AWS_EC2_METADATA_DISABLED: 'true',
      METADATA_SERVER_DETECTION: 'none',
      CLOUDSDK_CORE_CHECK_GCE_METADATA: 'false',
      CLOUDSDK_METRICS_ENVIRONMENT: 'costgoblin-e2e',
    });
  });

  it('keeps a sandboxed gcloud from reporting usage, whatever the install opted into', () => {
    // The "Signed in as" panel runs `gcloud config list` on every Data & Sync
    // visit; installation-scope properties are outside CLOUDSDK_CONFIG's reach.
    expect(env['CLOUDSDK_CORE_DISABLE_USAGE_REPORTING']).toBe('true');
  });

  it('makes every gcloud invocation fail on a missing token file', () => {
    // auth/access_token_file outranks installation-scope properties and the
    // app's keyFile override (CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE).
    expect(env['CLOUDSDK_AUTH_ACCESS_TOKEN_FILE']).toBe(join(SANDBOX, 'gcloud', 'access_token'));
    expect(env['CLOUDSDK_AUTH_DISABLE_CREDENTIALS']).toBe('false');
  });

  it('points the "Signed in as" panel at the sandbox ADC file, never the developer s', () => {
    // The panel resolves ADC the way google-auth-library does; if that ever
    // stopped honouring the pinned variable it would read — and call Google
    // with — the refresh token under the developer's $HOME.
    const platforms: readonly NodeJS.Platform[] = ['darwin', 'linux', 'win32'];
    for (const platform of platforms) {
      const location = adcCredentialsLocation(env, platform);
      expect(location, platform).toEqual({ path: env['GOOGLE_APPLICATION_CREDENTIALS'], origin: 'env' });
      expect(isInside(SANDBOX, location?.path ?? ''), platform).toBe(true);
    }
  });

  it('produces an env with no violations', () => {
    expect(cloudSandboxViolations(env, SANDBOX)).toEqual([]);
  });
});

describe('cloudSandboxViolations', () => {
  const leaked = cloudSandboxViolations({ ...ORDINARY_ENV, ...DEVELOPER_CLOUD_ENV }, SANDBOX);

  it('flags a bare process.env spread, which is what the launches used to do', () => {
    expect(leaked).toEqual(expect.arrayContaining([
      'AWS_PROFILE must not reach the app',
      'google_application_credentials must not reach the app',
      expect.stringMatching(/^CLOUDSDK_CONFIG must be .* \(overridden\)$/),
      expect.stringMatching(/^AWS_EC2_METADATA_DISABLED must be .* \(unset\)$/),
    ]));
  });

  it('never prints a leaked value', () => {
    // Violations surface exactly when a value is a live secret.
    const report = leaked.join('\n');
    for (const value of Object.values(DEVELOPER_CLOUD_ENV)) expect(report).not.toContain(value);
  });

  it('flags a cloud variable re-added on top of a sandboxed env', () => {
    const env = { ...cloudSandboxEnv(ORDINARY_ENV, SANDBOX), AWS_PROFILE: 'prod-admin' };
    expect(cloudSandboxViolations(env, SANDBOX)).toEqual(['AWS_PROFILE must not reach the app']);
  });

  it('flags a pin blanked or pointed at a real credential location', () => {
    const env = {
      ...cloudSandboxEnv(ORDINARY_ENV, SANDBOX),
      // Empty is as bad as unset: the SDKs then fall back to $HOME.
      GOOGLE_APPLICATION_CREDENTIALS: '',
      CLOUDSDK_CONFIG: join(HOME, '.config', 'gcloud'),
    };
    expect(cloudSandboxViolations(env, SANDBOX)).toEqual([
      `GOOGLE_APPLICATION_CREDENTIALS must be ${JSON.stringify(join(SANDBOX, 'gcloud', 'application_default_credentials.json'))} (overridden)`,
      `CLOUDSDK_CONFIG must be ${JSON.stringify(join(SANDBOX, 'gcloud'))} (overridden)`,
    ]);
  });

  it('flags an env sandboxed into a different directory', () => {
    const env = cloudSandboxEnv(ORDINARY_ENV, join('/tmp', 'another-run'));
    expect(cloudSandboxViolations(env, SANDBOX).length).toBeGreaterThan(0);
  });
});

describe('cloudSandboxCredentialStores', () => {
  it('accepts the sandbox as launched, and gcloud logs and config', () => {
    expect(cloudSandboxCredentialStores([
      'gcloud',
      join('gcloud', 'logs'),
      join('gcloud', 'logs', '2026.09.30', 'run.log'),
      join('gcloud', 'configurations', 'config_default'),
      join('gcloud', 'active_config'),
    ])).toEqual([]);
  });

  it('flags anything a sign-in would leave behind, with either separator', () => {
    const stores = [
      'aws',
      join('aws', 'login', 'cache', 'token.json'),
      join('gcloud', 'credentials.db'),
      join('gcloud', 'access_tokens.db'),
      join('gcloud', 'application_default_credentials.json'),
      join('gcloud', 'legacy_credentials', 'dev@example.com', 'adc.json'),
      'gcloud\\credentials.db',
    ];
    expect(cloudSandboxCredentialStores(stores)).toEqual(stores);
  });
});

// The sandbox only protects launches that use it. `e2e/` is outside every
// `npm run check` gate, so this is where a launch that bypasses
// launchElectron gets caught. Playwright's documented form —
// `import { _electron as electron }` with no `env` — inherits the runner's
// whole process.env, so the check is on the `_electron` identifier itself,
// not on one spelling of the call.
describe('e2e launch policy', () => {
  const e2eDir = join(import.meta.dirname, '..', '..', '..', '..', 'e2e');
  const sources = readdirSync(e2eDir, { recursive: true, encoding: 'utf-8' })
    .filter(file => /\.[cm]?[jt]s$/.test(file))
    .map(file => ({ file, text: readFileSync(join(e2eDir, file), 'utf-8') }));
  const helpers = sources.find(s => s.file === 'helpers.ts')?.text ?? '';

  it('finds the e2e sources', () => {
    expect(sources.map(s => s.file)).toContain('helpers.ts');
  });

  it('leaves Playwright\'s _electron to helpers.ts alone', () => {
    const users = sources.filter(s => s.file !== 'helpers.ts' && /\b_electron\b/.test(s.text)).map(s => s.file);
    expect(users).toEqual([]);
  });

  it('launches Electron exactly once in helpers.ts', () => {
    expect(helpers.match(/_electron\s*\.\s*launch\s*\(/g)).toHaveLength(1);
  });

  it('sandboxes and validates the helpers launch env', () => {
    expect(helpers).toContain('cloudSandboxEnv(');
    expect(helpers).toContain('cloudSandboxViolations(');
  });
});
