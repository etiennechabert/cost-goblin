import { readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  cloudSandboxEnv,
  cloudSandboxPaths,
  cloudSandboxViolations,
  isCloudEnvVar,
} from '../e2e-harness/cloud-sandbox.js';

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
});

describe('cloudSandboxEnv', () => {
  const env = cloudSandboxEnv({ ...ORDINARY_ENV, ...DEVELOPER_CLOUD_ENV, UNSET: undefined }, SANDBOX);

  it('carries no inherited cloud value through', () => {
    const leaked = Object.entries(env).filter(([name, value]) =>
      isCloudEnvVar(name) && DEVELOPER_CLOUD_ENV[name] === value);
    expect(leaked).toEqual([]);
    for (const name of ['AWS_PROFILE', 'AWS_ACCESS_KEY_ID', 'AWS_SESSION_TOKEN', 'google_application_credentials', 'GOOGLE_CLOUD_PROJECT', 'CLOUDSDK_CORE_ACCOUNT', 'GCE_METADATA_HOST', 'STORAGE_EMULATOR_HOST']) {
      expect(env, name).not.toHaveProperty(name);
    }
  });

  it('keeps the rest of the inherited env and drops unset entries', () => {
    expect(env).toMatchObject(ORDINARY_ENV);
    expect(env).not.toHaveProperty('UNSET');
  });

  it('points every credential lookup inside the sandbox', () => {
    const paths = cloudSandboxPaths(SANDBOX);
    for (const path of Object.values(paths)) expect(isInside(SANDBOX, path), path).toBe(true);
    expect(env['AWS_CONFIG_FILE']).toBe(paths.awsConfigFile);
    expect(env['AWS_SHARED_CREDENTIALS_FILE']).toBe(paths.awsSharedCredentialsFile);
    expect(env['AWS_LOGIN_CACHE_DIRECTORY']).toBe(paths.awsLoginCacheDir);
    expect(env['CLOUDSDK_CONFIG']).toBe(paths.gcloudConfigDir);
    // Set, not unset: unset lets google-auth-library fall through to the ADC
    // file under $HOME, which CLOUDSDK_CONFIG does not redirect.
    expect(env['GOOGLE_APPLICATION_CREDENTIALS']).toBe(paths.googleApplicationCredentials);
  });

  it('turns off both metadata-server probes', () => {
    expect(env['AWS_EC2_METADATA_DISABLED']).toBe('true');
    expect(env['METADATA_SERVER_DETECTION']).toBe('none');
  });

  it('produces an env with no violations', () => {
    expect(cloudSandboxViolations(env, SANDBOX)).toEqual([]);
  });
});

describe('cloudSandboxViolations', () => {
  it('flags a bare process.env spread, which is what the launches used to do', () => {
    const violations = cloudSandboxViolations({ ...ORDINARY_ENV, ...DEVELOPER_CLOUD_ENV }, SANDBOX);
    expect(violations.some(v => v.startsWith('AWS_PROFILE must not reach the app'))).toBe(true);
    expect(violations.some(v => v.startsWith('google_application_credentials must not reach the app'))).toBe(true);
    expect(violations.some(v => v.startsWith('CLOUDSDK_CONFIG must be'))).toBe(true);
    expect(violations.some(v => v.startsWith('AWS_EC2_METADATA_DISABLED must be') && v.endsWith('got unset'))).toBe(true);
  });

  it('flags a cloud variable re-added on top of a sandboxed env', () => {
    const env = { ...cloudSandboxEnv(ORDINARY_ENV, SANDBOX), AWS_PROFILE: 'prod-admin' };
    expect(cloudSandboxViolations(env, SANDBOX)).toEqual([
      'AWS_PROFILE must not reach the app (set to "prod-admin")',
    ]);
  });

  it('flags a pin that points at a real credential location', () => {
    const env = { ...cloudSandboxEnv(ORDINARY_ENV, SANDBOX), CLOUDSDK_CONFIG: join(HOME, '.config', 'gcloud') };
    expect(cloudSandboxViolations(env, SANDBOX)).toEqual([
      `CLOUDSDK_CONFIG must be ${JSON.stringify(cloudSandboxPaths(SANDBOX).gcloudConfigDir)}, got ${JSON.stringify(join(HOME, '.config', 'gcloud'))}`,
    ]);
  });

  it('flags an env sandboxed into a different directory', () => {
    const env = cloudSandboxEnv(ORDINARY_ENV, join('/tmp', 'another-run'));
    expect(cloudSandboxViolations(env, SANDBOX).length).toBeGreaterThan(0);
  });
});

// The sandbox only protects launches that use it. `e2e/` is outside every
// `npm run check` gate, so this is the one place a new suite that reaches for
// `_electron.launch({ env: { ...process.env } })` gets caught.
describe('e2e launch policy', () => {
  const e2eDir = join(import.meta.dirname, '..', '..', '..', '..', 'e2e');
  const sources = readdirSync(e2eDir, { recursive: true, encoding: 'utf-8' })
    .filter(file => file.endsWith('.ts'))
    .map(file => ({ file, text: readFileSync(join(e2eDir, file), 'utf-8') }));

  it('finds the e2e sources', () => {
    expect(sources.map(s => s.file)).toContain('helpers.ts');
  });

  it('launches Electron only from helpers.ts', () => {
    const launchers = sources.filter(s => s.text.includes('_electron.launch')).map(s => s.file);
    expect(launchers).toEqual(['helpers.ts']);
  });

  it('builds the helpers launch env from cloudSandboxEnv', () => {
    const helpers = sources.find(s => s.file === 'helpers.ts')?.text ?? '';
    expect(helpers).toContain('cloudSandboxEnv(');
  });

  it('never spreads process.env into a launch', () => {
    const spreaders = sources.filter(s => /\.\.\.\s*process\.env\b/.test(s.text)).map(s => s.file);
    expect(spreaders).toEqual([]);
  });
});
