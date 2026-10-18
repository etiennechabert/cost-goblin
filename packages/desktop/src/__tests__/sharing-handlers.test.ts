import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG_BEACON_KEY, serializeConfigBundle } from '@costgoblin/core';
import { buildCurrentBundle } from '../main/handlers/bundle-io.js';
import { registerSharingHandlers } from '../main/handlers/sharing.js';
import { dialog, resetElectronFakes } from './helpers/electron-fake.js';
import {
  FIXTURE_AWS_PROVIDER,
  at,
  configYaml,
  createHarness,
  gcpProviderYaml,
  str,
  type FixtureConfigSet,
  type Harness,
} from './helpers/ipc-harness.js';

/** The config-bundle IPC surface: export to / preview from a file, apply
 *  (re-validated in main), and publish / fetch / discover a bundle in S3. The
 *  S3 SDK is the only fake — every command the handlers build is recorded. */

const s3 = vi.hoisted(() => {
  const clients: unknown[] = [];
  return { clients, send: vi.fn<(command: unknown) => Promise<unknown>>() };
});

vi.mock('electron', async () => (await import('./helpers/electron-fake.js')).fakeElectronModule);
vi.mock('@sentry/electron/main', async () => (await import('./helpers/electron-fake.js')).fakeSentryModule);
vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    constructor(config: unknown) { s3.clients.push(config); }
    send(command: unknown): Promise<unknown> { return s3.send(command); }
  }
  class PutObjectCommand {
    readonly kind = 'put';
    constructor(readonly input: unknown) {}
  }
  class GetObjectCommand {
    readonly kind = 'get';
    constructor(readonly input: unknown) {}
  }
  return { S3Client, PutObjectCommand, GetObjectCommand };
});

const harnesses: Harness[] = [];

beforeEach(async () => {
  resetElectronFakes();
  s3.send.mockReset();
  s3.clients.length = 0;
  // Every client starts in its profile's ~/.aws/config region: give each test
  // a throwaway config so the developer's own profiles never leak in.
  const h = await createHarness({ config: 'none' });
  harnesses.push(h);
  const awsConfig = join(h.ws.root, 'aws-config');
  await writeFile(awsConfig, '[profile publisher]\nregion = eu-west-1\n');
  vi.stubEnv('AWS_CONFIG_FILE', awsConfig);
  vi.stubEnv('AWS_SHARED_CREDENTIALS_FILE', join(h.ws.root, 'aws-credentials'));
  vi.stubEnv('AWS_PROFILE', '');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const h of harnesses.splice(0)) await h.dispose();
});

async function sharingApp(config: FixtureConfigSet = 'single'): Promise<Harness> {
  const h = await createHarness({ config });
  registerSharingHandlers(h.app);
  harnesses.push(h);
  return h;
}

async function bundleText(h: Harness): Promise<string> {
  return serializeConfigBundle(await buildCurrentBundle(h.app));
}

function body(text: string | undefined): { Body?: { transformToString: () => Promise<string> } } {
  return text === undefined ? {} : { Body: { transformToString: () => Promise.resolve(text) } };
}

function namedError(name: string, message = name): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

describe('sharing:export-bundle', () => {
  it('writes the current bundle where the user chose', async () => {
    const h = await sharingApp();
    const target = join(h.ws.root, 'exported.yaml');
    dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: target });
    expect(await h.ipc.invoke('sharing:export-bundle')).toEqual({ status: 'saved', path: target });
    const written = await readFile(target, 'utf-8');
    expect(written).toContain('kind: costgoblin-config-bundle');
    expect(written).toContain(FIXTURE_AWS_PROVIDER);
    expect(written).not.toContain('test-profile');
    const options = dialog.showSaveDialog.mock.calls[0]?.[0];
    expect(options?.defaultPath).toMatch(/^costgoblin-config-\d{4}-\d{2}-\d{2}\.yaml$/);
  });

  it('reports a cancelled or empty save as canceled', async () => {
    const h = await sharingApp();
    expect(await h.ipc.invoke('sharing:export-bundle')).toEqual({ status: 'canceled' });
    dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: '' });
    expect(await h.ipc.invoke('sharing:export-bundle')).toEqual({ status: 'canceled' });
  });

  it('reports an export with no config as an error', async () => {
    const h = await sharingApp('none');
    const result = await h.ipc.invoke('sharing:export-bundle');
    expect(at(result, 'status')).toBe('error');
    expect(dialog.showSaveDialog).not.toHaveBeenCalled();
  });
});

describe('sharing:preview-bundle-file', () => {
  it('previews a chosen bundle file with its summary', async () => {
    const h = await sharingApp();
    const file = join(h.ws.root, 'incoming.yaml');
    await writeFile(file, await bundleText(h));
    dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [file] });
    const result = await h.ipc.invoke('sharing:preview-bundle-file');
    expect(at(result, 'status')).toBe('ok');
    expect(str(at(result, 'content'))).toContain('kind: costgoblin-config-bundle');
    expect(at(result, 'summary', 'providers', 0, 'name')).toBe(FIXTURE_AWS_PROVIDER);
    expect(at(result, 'summary', 'fingerprintValid')).toBe(true);
  });

  it('reports a cancelled pick, or one with no file, as canceled', async () => {
    const h = await sharingApp();
    expect(await h.ipc.invoke('sharing:preview-bundle-file')).toEqual({ status: 'canceled' });
    dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [] });
    expect(await h.ipc.invoke('sharing:preview-bundle-file')).toEqual({ status: 'canceled' });
  });

  it('reports a file that is not a bundle', async () => {
    const h = await sharingApp();
    const file = join(h.ws.root, 'random.yaml');
    await writeFile(file, 'hello: world\n');
    dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [file] });
    expect(await h.ipc.invoke('sharing:preview-bundle-file')).toEqual({
      status: 'error',
      message: 'Not a CostGoblin configuration bundle (missing or wrong "kind" field)',
    });
  });
});

describe('sharing:apply-bundle', () => {
  it('rejects malformed parameters before parsing anything', async () => {
    const h = await sharingApp();
    const content = await bundleText(h);
    for (const raw of [null, 'text', { content: 42, credentialsProfile: 'p' }, { content, credentialsProfile: '' }, { content }]) {
      expect(await h.ipc.invoke('sharing:apply-bundle', raw)).toEqual({ status: 'error', message: 'Invalid import parameters' });
    }
  });

  it('applies the bundle with the chosen profile, backing up the files it replaces, then clears caches', async () => {
    const h = await sharingApp();
    const content = await bundleText(h);
    expect(h.app.state.config).not.toBeNull();
    const result = await h.ipc.invoke('sharing:apply-bundle', { content, credentialsProfile: 'imported-sso' });
    expect(at(result, 'status')).toBe('applied');
    expect(at(result, 'sections')).toEqual(expect.arrayContaining(['config', 'dimensions']));
    const backupDir = str(at(result, 'backupDir'));
    expect(await readdir(backupDir)).toEqual(expect.arrayContaining(['costgoblin.yaml', 'dimensions.yaml']));
    expect(await readFile(h.ws.configPath, 'utf-8')).toContain('credentialsProfile: imported-sso');
    // Caches dropped (a stale cache would still hold test-profile).
    expect(h.db.cancelPendingQueries).toHaveBeenCalledTimes(1);
    expect((await h.app.getConfig()).providers[0]).toMatchObject({ credentialsProfile: 'imported-sso' });
  });

  it('accepts the legacy `profile` key a stale renderer still sends', async () => {
    const h = await sharingApp();
    const content = await bundleText(h);
    const result = await h.ipc.invoke('sharing:apply-bundle', { content, profile: 'legacy-key' });
    expect(at(result, 'status')).toBe('applied');
    expect(await readFile(h.ws.configPath, 'utf-8')).toContain('credentialsProfile: legacy-key');
  });

  it('carries only the mandatory sections when the optional files are absent, and needs no backup on a fresh install', async () => {
    const source = await sharingApp();
    for (const path of [source.ws.orgTreePath, source.ws.viewsPath, source.ws.costScopePath]) await rm(path);
    const content = await bundleText(source);

    const fresh = await sharingApp('none');
    const result = await fresh.ipc.invoke('sharing:apply-bundle', { content, credentialsProfile: 'first-run' });
    expect(at(result, 'status')).toBe('applied');
    expect(at(result, 'backupDir')).toBeNull();
    const sections = at(result, 'sections');
    expect(sections).toEqual(expect.arrayContaining(['config', 'dimensions']));
    expect(sections).not.toContain('orgTree');
    expect(sections).not.toContain('views');
    expect((await readdir(fresh.ws.configDir)).sort()).toEqual(['costgoblin.yaml', 'dimensions.yaml']);
  });

  it('re-validates the content and reports a bad bundle', async () => {
    const h = await sharingApp();
    const result = await h.ipc.invoke('sharing:apply-bundle', { content: 'kind: nope\n', credentialsProfile: 'p' });
    expect(at(result, 'status')).toBe('error');
    expect(await readFile(h.ws.configPath, 'utf-8')).toContain('credentialsProfile: test-profile');
  });
});

describe('sharing:publish-bundle', () => {
  it('needs an AWS provider to publish to', async () => {
    const h = await sharingApp();
    const config = await h.app.getConfig();
    h.app.state.config = { ...config, providers: [] };
    expect(await h.ipc.invoke('sharing:publish-bundle')).toEqual({
      status: 'error', message: 'No provider configured — complete setup before publishing',
    });

    const gcp = await sharingApp('none');
    await writeFile(gcp.ws.configPath, configYaml(gcpProviderYaml('gcp-only')));
    expect(await gcp.ipc.invoke('sharing:publish-bundle', {})).toEqual({
      status: 'error',
      message: 'Publishing a config bundle to a shared bucket needs an AWS provider — the beacon is written to S3',
    });
    expect(s3.send).not.toHaveBeenCalled();
  });

  it('publishes to the discoverable beacon at the daily bucket root by default', async () => {
    const h = await sharingApp();
    s3.send.mockResolvedValueOnce({});
    const result = await h.ipc.invoke('sharing:publish-bundle', { location: '   ', profile: '' });
    expect(result).toEqual({ status: 'published', location: `s3://test-cur-bucket/${CONFIG_BEACON_KEY}` });
    expect(s3.clients).toEqual([expect.objectContaining({ profile: 'test-profile', followRegionRedirects: true })]);
    const command = s3.send.mock.calls[0]?.[0];
    expect(at(command, 'kind')).toBe('put');
    expect(at(command, 'input', 'Bucket')).toBe('test-cur-bucket');
    expect(at(command, 'input', 'Key')).toBe(CONFIG_BEACON_KEY);
    expect(at(command, 'input', 'ContentType')).toBe('application/yaml');
    expect(str(at(command, 'input', 'Body'))).toContain('kind: costgoblin-config-bundle');
  });

  it('honours a custom location and an elevated publishing profile', async () => {
    const h = await sharingApp();
    s3.send.mockResolvedValueOnce({});
    const result = await h.ipc.invoke('sharing:publish-bundle', { location: 's3://config-bucket/team/org.yaml', profile: 'publisher' });
    expect(result).toEqual({ status: 'published', location: 's3://config-bucket/team/org.yaml' });
    expect(s3.clients).toEqual([{ region: 'eu-west-1', followRegionRedirects: true, profile: 'publisher' }]);
  });

  it('rejects a location with no object key, and reports a failed upload', async () => {
    const h = await sharingApp();
    expect(await h.ipc.invoke('sharing:publish-bundle', { location: 's3://only-a-bucket/' })).toEqual({
      status: 'error', message: 'Invalid S3 location — expected s3://bucket/path/to/org-config.yaml',
    });
    s3.send.mockRejectedValueOnce(namedError('AccessDenied', 'Access Denied'));
    expect(await h.ipc.invoke('sharing:publish-bundle')).toEqual({ status: 'error', message: 'Access Denied' });
  });
});

describe('sharing:fetch-bundle-from-s3', () => {
  it('rejects malformed parameters and locations', async () => {
    const h = await sharingApp();
    expect(await h.ipc.invoke('sharing:fetch-bundle-from-s3', { profile: 'p' })).toEqual({ status: 'error', message: 'Invalid fetch parameters' });
    expect(await h.ipc.invoke('sharing:fetch-bundle-from-s3', 'nope')).toEqual({ status: 'error', message: 'Invalid fetch parameters' });
    expect(await h.ipc.invoke('sharing:fetch-bundle-from-s3', { profile: 'p', location: 'bucket-only' })).toEqual({
      status: 'error', message: 'Invalid S3 location — expected s3://bucket/path/to/org-config.yaml',
    });
  });

  it('previews the bundle found at the location', async () => {
    const h = await sharingApp();
    s3.send.mockResolvedValueOnce(body(await bundleText(h)));
    const result = await h.ipc.invoke('sharing:fetch-bundle-from-s3', { profile: 'default', location: 's3://team-config/org.yaml' });
    expect(at(result, 'status')).toBe('ok');
    expect(at(result, 'summary', 'providers', 0, 'name')).toBe(FIXTURE_AWS_PROVIDER);
    expect(at(s3.send.mock.calls[0]?.[0], 'input')).toEqual({ Bucket: 'team-config', Key: 'org.yaml' });
    // The 'default' profile is the SDK's own default — never named explicitly.
    expect(s3.clients).toEqual([{ region: 'eu-central-1', followRegionRedirects: true }]);
  });

  it('surfaces every failure, phrasing absence distinctly', async () => {
    const h = await sharingApp();
    const params = { profile: 'p', location: 's3://team-config/org.yaml' };
    s3.send.mockResolvedValueOnce(body(undefined));
    expect(await h.ipc.invoke('sharing:fetch-bundle-from-s3', params)).toEqual({ status: 'error', message: 'Nothing found at s3://team-config/org.yaml' });
    for (const name of ['NoSuchKey', 'NotFound', 'NoSuchBucket', 'AccessDenied']) {
      s3.send.mockRejectedValueOnce(namedError(name));
      expect(await h.ipc.invoke('sharing:fetch-bundle-from-s3', params)).toEqual({
        status: 'error', message: 'No bundle found at s3://team-config/org.yaml (missing object or access denied)',
      });
    }
    s3.send.mockRejectedValueOnce(namedError('TimeoutError', 'socket timed out'));
    expect(await h.ipc.invoke('sharing:fetch-bundle-from-s3', params)).toEqual({ status: 'error', message: 'socket timed out' });
    s3.send.mockRejectedValueOnce('not an error object');
    expect(await h.ipc.invoke('sharing:fetch-bundle-from-s3', params)).toEqual({ status: 'error', message: 'not an error object' });
    s3.send.mockResolvedValueOnce(body('kind: something-else\n'));
    expect(at(await h.ipc.invoke('sharing:fetch-bundle-from-s3', params), 'status')).toBe('error');
  });
});

describe('sharing:check-beacon', () => {
  it('rejects malformed parameters', async () => {
    const h = await sharingApp();
    for (const raw of [undefined, { profile: 'p' }, { profile: 'p', bucket: '' }, { profile: 1, bucket: 'b' }]) {
      expect(await h.ipc.invoke('sharing:check-beacon', raw)).toEqual({ status: 'error', message: 'Invalid beacon parameters' });
    }
  });

  it('finds a published beacon at the well-known key', async () => {
    const h = await sharingApp();
    s3.send.mockResolvedValueOnce(body(await bundleText(h)));
    const result = await h.ipc.invoke('sharing:check-beacon', { profile: 'p', bucket: 'billing-bucket' });
    expect(at(result, 'status')).toBe('found');
    expect(at(result, 'location')).toBe(`s3://billing-bucket/${CONFIG_BEACON_KEY}`);
    expect(at(s3.send.mock.calls[0]?.[0], 'input')).toEqual({ Bucket: 'billing-bucket', Key: CONFIG_BEACON_KEY });
  });

  it('treats absence, an empty object and transient failures as no beacon, but flags an invalid one', async () => {
    const h = await sharingApp();
    const params = { profile: 'p', bucket: 'billing-bucket' };
    s3.send.mockResolvedValueOnce(body(undefined));
    expect(await h.ipc.invoke('sharing:check-beacon', params)).toEqual({ status: 'none' });
    s3.send.mockRejectedValueOnce(namedError('NoSuchKey'));
    expect(await h.ipc.invoke('sharing:check-beacon', params)).toEqual({ status: 'none' });
    s3.send.mockRejectedValueOnce(namedError('CredentialsProviderError', 'Could not load credentials from any providers'));
    expect(await h.ipc.invoke('sharing:check-beacon', params)).toEqual({ status: 'none' });
    s3.send.mockRejectedValueOnce('opaque');
    expect(await h.ipc.invoke('sharing:check-beacon', params)).toEqual({ status: 'none' });
    s3.send.mockResolvedValueOnce(body('kind: nope\n'));
    expect(await h.ipc.invoke('sharing:check-beacon', params)).toEqual({
      status: 'error',
      message: `Found s3://billing-bucket/${CONFIG_BEACON_KEY} but it is not a valid bundle: Not a CostGoblin configuration bundle (missing or wrong "kind" field)`,
    });
  });
});
