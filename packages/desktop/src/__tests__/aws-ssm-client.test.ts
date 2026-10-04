import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncRegionNames } from '../main/aws-ssm-client.js';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-ssm', () => {
  const SSMClientMock = vi.fn();
  SSMClientMock.prototype.send = mockSend;
  return {
    SSMClient: SSMClientMock,
    GetParametersByPathCommand: vi.fn(),
    GetParametersCommand: vi.fn(),
  };
});

// The client is pinned to its profile's ~/.aws/config region, so each test
// gets a throwaway config: the developer's own profiles never leak in.
let configDir = '';
function useAwsConfig(contents: string): void {
  writeFileSync(join(configDir, 'config'), contents);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSend.mockReset();
  configDir = mkdtempSync(join(tmpdir(), 'costgoblin-aws-'));
  useAwsConfig('');
  vi.stubEnv('AWS_CONFIG_FILE', join(configDir, 'config'));
  vi.stubEnv('AWS_SHARED_CREDENTIALS_FILE', join(configDir, 'credentials'));
  vi.stubEnv('AWS_PROFILE', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(configDir, { recursive: true, force: true });
});

describe('syncRegionNames', () => {
  it('pins a named profile to its own region', async () => {
    const { SSMClient } = await import('@aws-sdk/client-ssm');
    useAwsConfig('[profile billing]\nregion = eu-west-1\n');
    mockSend.mockResolvedValueOnce({ Parameters: [] });

    await syncRegionNames('billing');

    expect(SSMClient).toHaveBeenCalledWith({ region: 'eu-west-1', profile: 'billing' });
  });

  it('pins the default chain to the region of the profile AWS_PROFILE names, matching its credentials', async () => {
    const { SSMClient } = await import('@aws-sdk/client-ssm');
    useAwsConfig('[default]\nregion = us-east-1\n\n[profile corp]\nregion = eu-west-1\n');
    vi.stubEnv('AWS_PROFILE', 'corp');
    mockSend.mockResolvedValueOnce({ Parameters: [] });

    await syncRegionNames('default');

    expect(SSMClient).toHaveBeenCalledWith({ region: 'eu-west-1' });
  });

  it('names the profile the credentials come from when it has no region', async () => {
    const { SSMClient } = await import('@aws-sdk/client-ssm');
    useAwsConfig('[default]\nregion = us-east-1\n\n[profile corp]\noutput = json\n');
    vi.stubEnv('AWS_PROFILE', 'corp');

    await expect(syncRegionNames('default')).rejects.toThrow('Profile "corp" has no region configured');
    expect(SSMClient).not.toHaveBeenCalled();
  });
});
