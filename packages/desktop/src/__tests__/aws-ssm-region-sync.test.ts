import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GetParametersByPathCommand, GetParametersCommand } from '@aws-sdk/client-ssm';
import { syncRegionNames } from '../main/aws-ssm-client.js';

/** syncRegionNames against a scripted SSM Parameter Store: region codes are
 *  listed page by page, then their metadata fetched in batches of ten. */

const ssm = vi.hoisted(() => ({ send: vi.fn<(command: unknown) => Promise<unknown>>() }));

vi.mock('@aws-sdk/client-ssm', () => {
  const command = (): new (input: unknown) => { readonly input: unknown } =>
    class {
      readonly input: unknown;
      constructor(input: unknown) { this.input = input; }
    };
  class SSMClient {
    send(cmd: unknown): Promise<unknown> { return ssm.send(cmd); }
  }
  return { SSMClient, GetParametersByPathCommand: command(), GetParametersCommand: command() };
});

const ROOT = '/aws/service/global-infrastructure/regions';

/** Published metadata, keyed by full parameter name. */
const PUBLISHED: Readonly<Record<string, string>> = {
  [`${ROOT}/eu-west-1/longName`]: 'Europe (Ireland)',
  [`${ROOT}/eu-west-1/geolocationCountry`]: 'IE',
  [`${ROOT}/eu-west-1/geolocationRegion`]: 'EU',
  [`${ROOT}/us-east-1/longName`]: 'US East (N. Virginia)',
  [`${ROOT}/us-east-1/geolocationCountry`]: 'US',
  // ap-south-1 publishes no longName, so it can't be displayed.
  [`${ROOT}/ap-south-1/geolocationCountry`]: 'IN',
  [`${ROOT}/eu-central-1/longName`]: 'Europe (Frankfurt)',
  [`${ROOT}/eu-central-1/geolocationCountry`]: 'DE',
  [`${ROOT}/eu-central-1/geolocationRegion`]: 'EU',
};

/** Pages of the region-code listing. */
const CODE_PAGES: readonly (readonly { Name?: string }[])[] = [
  [{ Name: `${ROOT}/eu-west-1` }, { Name: `${ROOT}/` }, {}],
  [{ Name: `${ROOT}/us-east-1` }, { Name: `${ROOT}/ap-south-1` }, { Name: `${ROOT}/eu-central-1` }],
];

function nameBatches(): string[][] {
  return ssm.send.mock.calls.flatMap(([cmd]) => (cmd instanceof GetParametersCommand ? [[...(cmd.input.Names ?? [])]] : []));
}

/** Serve the listing and the metadata. `failBatch` rejects that GetParameters
 *  call (0-based); `extra` adds parameters to every metadata response. */
function serve(opts: { failBatch?: number; extra?: readonly { Name?: string; Value?: string }[] } = {}): void {
  let batch = 0;
  ssm.send.mockImplementation((cmd: unknown) => {
    if (cmd instanceof GetParametersByPathCommand) {
      const index = cmd.input.NextToken === undefined ? 0 : Number(cmd.input.NextToken);
      const items = CODE_PAGES[index];
      if (items === undefined) return Promise.resolve({});
      return Promise.resolve({ Parameters: items, ...(index + 1 < CODE_PAGES.length ? { NextToken: String(index + 1) } : {}) });
    }
    if (cmd instanceof GetParametersCommand) {
      const current = batch++;
      if (current === opts.failBatch) return Promise.reject(new Error('ThrottlingException'));
      const found = (cmd.input.Names ?? []).flatMap(name => {
        const value = PUBLISHED[name];
        return value === undefined ? [] : [{ Name: name, Value: value }];
      });
      return Promise.resolve({ Parameters: [...found, ...(opts.extra ?? [])] });
    }
    return Promise.reject(new Error('unexpected command'));
  });
}

let configDir = '';

beforeEach(() => {
  ssm.send.mockReset();
  configDir = mkdtempSync(join(tmpdir(), 'costgoblin-ssm-'));
  writeFileSync(join(configDir, 'config'), '[profile billing]\nregion = eu-west-1\n');
  vi.stubEnv('AWS_CONFIG_FILE', join(configDir, 'config'));
  vi.stubEnv('AWS_SHARED_CREDENTIALS_FILE', join(configDir, 'credentials'));
  vi.stubEnv('AWS_PROFILE', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(configDir, { recursive: true, force: true });
});

describe('syncRegionNames — region metadata', () => {
  it('lists the region codes across pages and resolves each displayable region', async () => {
    serve();

    const result = await syncRegionNames('billing');

    expect(result.regions).toEqual({
      'eu-west-1': { longName: 'Europe (Ireland)', country: 'IE', continent: 'EU' },
      'us-east-1': { longName: 'US East (N. Virginia)', country: 'US', continent: '' },
      'eu-central-1': { longName: 'Europe (Frankfurt)', country: 'DE', continent: 'EU' },
    });
    expect(Number.isNaN(Date.parse(result.syncedAt))).toBe(false);
  });

  it('asks for the three fields of every region in batches of at most ten names', async () => {
    serve();

    await syncRegionNames('billing');

    const batches = nameBatches();
    expect(batches.map(b => b.length)).toEqual([10, 2]);
    expect(batches[0]?.slice(0, 3)).toEqual([
      `${ROOT}/eu-west-1/longName`,
      `${ROOT}/eu-west-1/geolocationCountry`,
      `${ROOT}/eu-west-1/geolocationRegion`,
    ]);
    expect(batches[1]).toEqual([`${ROOT}/eu-central-1/geolocationCountry`, `${ROOT}/eu-central-1/geolocationRegion`]);
  });

  it('skips a failed batch but keeps what the other batches resolved', async () => {
    serve({ failBatch: 1 });

    const result = await syncRegionNames('billing');

    // The second batch carried Frankfurt's country and continent.
    expect(result.regions['eu-central-1']).toEqual({ longName: 'Europe (Frankfurt)', country: '', continent: '' });
    expect(result.regions['eu-west-1']).toEqual({ longName: 'Europe (Ireland)', country: 'IE', continent: 'EU' });
  });

  it('ignores blank values, unknown fields and names that carry no region code', async () => {
    serve({
      extra: [
        { Name: `${ROOT}/eu-west-1/longName`, Value: '' },
        { Name: `${ROOT}/eu-west-1/domain`, Value: 'amazonaws.com' },
        { Name: 'longName', Value: 'orphan' },
        { Name: `${ROOT}/us-east-1/geolocationRegion` },
        { Value: 'nameless' },
      ],
    });

    const result = await syncRegionNames('billing');

    expect(Object.keys(result.regions).sort()).toEqual(['eu-central-1', 'eu-west-1', 'us-east-1']);
    expect(result.regions['eu-west-1']).toEqual({ longName: 'Europe (Ireland)', country: 'IE', continent: 'EU' });
    expect(result.regions['us-east-1']?.continent).toBe('');
  });

  it('returns no regions when the listing has none, without fetching metadata', async () => {
    ssm.send.mockResolvedValue({});

    const result = await syncRegionNames('billing');

    expect(result.regions).toEqual({});
    expect(nameBatches()).toEqual([]);
  });

  it('reads a metadata response that carries no parameters as nothing resolved', async () => {
    ssm.send.mockImplementation((cmd: unknown) =>
      Promise.resolve(cmd instanceof GetParametersByPathCommand ? { Parameters: [{ Name: `${ROOT}/eu-west-1` }] } : {}));

    const result = await syncRegionNames('billing');

    expect(result.regions).toEqual({});
    expect(nameBatches()).toHaveLength(1);
  });
});

describe('syncRegionNames — profile region hint', () => {
  const realPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform });
  });

  it('points Windows users at %USERPROFILE%\\.aws\\config when the profile has no region', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });

    await expect(syncRegionNames('no-such-profile')).rejects.toThrow(String.raw`no region configured in %USERPROFILE%\.aws\config`);
    expect(ssm.send).not.toHaveBeenCalled();
  });

  it('points everyone else at ~/.aws/config', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });

    await expect(syncRegionNames('no-such-profile')).rejects.toThrow('no region configured in ~/.aws/config');
  });
});
