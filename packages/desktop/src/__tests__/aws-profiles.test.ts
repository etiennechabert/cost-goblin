import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSharedConfigFiles } from '@smithy/shared-ini-file-loader';
import { afterAll, describe, it, expect } from 'vitest';
import { awsProfileNames } from '../main/aws-profiles.js';

const dir = mkdtempSync(join(tmpdir(), 'cg-aws-profiles-'));
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

/** What setup:list-profiles does, with the file paths passed explicitly so
 *  the test never reads the machine's own AWS files. */
async function listProfiles(config: string, credentials: string): Promise<string[]> {
  const configFilepath = join(dir, `config-${String(Math.random())}`);
  const filepath = join(dir, `credentials-${String(Math.random())}`);
  writeFileSync(configFilepath, config);
  writeFileSync(filepath, credentials);
  return awsProfileNames(await loadSharedConfigFiles({ configFilepath, filepath, ignoreCache: true }));
}

describe('awsProfileNames', () => {
  it('lists only the profiles the SDK can load', async () => {
    const config = [
      '[default]', 'region = eu-west-1',
      '[profile a]', 'region = eu-west-1',
      // A header comment used to fail the hand-rolled endsWith(']') check.
      '[profile b] # main account', 'region = eu-west-1',
      // Not profiles: offering them sent the user to a profile the SDK
      // cannot resolve.
      '[sso-session corp]', 'sso_region = eu-west-1',
      '[services local-s3]', 's3 =', '  endpoint_url = http://localhost:9000',
      // A bare section in the config file is not a profile either.
      '[bare]', 'region = eu-west-1',
    ].join('\n');
    const credentials = ['[c]', 'aws_access_key_id = AKIAEXAMPLE'].join('\n');
    expect(await listProfiles(config, credentials)).toEqual(['a', 'b', 'c', 'default']);
  });

  it('always offers default, even with no AWS files', async () => {
    expect(awsProfileNames(await loadSharedConfigFiles({
      configFilepath: join(dir, 'missing-config'),
      filepath: join(dir, 'missing-credentials'),
      ignoreCache: true,
    }))).toEqual(['default']);
  });
});
