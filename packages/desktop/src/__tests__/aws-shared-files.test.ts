import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { awsSharedConfigFiles } from '../main/aws-shared-files.js';

const HOME = join('/Users', 'dev');

describe('awsSharedConfigFiles', () => {
  it('defaults to ~/.aws/config and ~/.aws/credentials', () => {
    expect(awsSharedConfigFiles({}, HOME)).toEqual({
      configFile: join(HOME, '.aws', 'config'),
      credentialsFile: join(HOME, '.aws', 'credentials'),
    });
  });

  it('follows AWS_CONFIG_FILE and AWS_SHARED_CREDENTIALS_FILE, as the SDK does', () => {
    // Listing ~/.aws while the SDK reads the overridden files offered profiles
    // the SDK could not load — and read the files the override exists to avoid.
    const env = { AWS_CONFIG_FILE: '/elsewhere/config', AWS_SHARED_CREDENTIALS_FILE: '/elsewhere/credentials' };
    expect(awsSharedConfigFiles(env, HOME)).toEqual({
      configFile: '/elsewhere/config',
      credentialsFile: '/elsewhere/credentials',
    });
  });

  it('treats an empty override as unset, matching the SDK', () => {
    // The SDK resolves with `process.env[X] || default`, so an empty value
    // (what a YAML `env:` entry fed by an unset input produces) is the default.
    const env = { AWS_CONFIG_FILE: '', AWS_SHARED_CREDENTIALS_FILE: '' };
    expect(awsSharedConfigFiles(env, HOME)).toEqual(awsSharedConfigFiles({}, HOME));
  });
});
