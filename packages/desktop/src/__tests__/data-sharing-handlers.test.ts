import { chmod, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { NetworkInterfaceInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PACK_MANIFEST_VERSION,
  SHARING_KEY_VERSION,
  encodeSharingKey,
  generateIdentityKeyPair,
  parseSharingKey,
  publicKeyFingerprint,
  serializeSignedManifest,
  sha256Hex,
  signManifest,
  startSharingServer,
} from '@costgoblin/core';
import type { IdentityKeyPair, PackManifest, SharingServer, SharingServerConfig, SharingServerHandlers } from '@costgoblin/core';
import { registerDataSharingHandlers } from '../main/handlers/data-sharing.js';
import {
  FIXTURE_AWS_PROVIDER,
  at,
  awsProviderYaml,
  configYaml,
  createHarness,
  gcpProviderYaml,
  list,
  num,
  str,
  type FixtureConfigSet,
  type Harness,
} from './helpers/ipc-harness.js';

/** The LAN data-sharing IPC surface (publisher + consumer), driven end to end
 *  over a real TLS-PSK channel on loopback: a publisher app serves a copy of
 *  the synthetic tree, a second app previews / pulls it. Only the bind address
 *  is pinned (127.0.0.1, ephemeral port — the app's fixed 53178 is asserted
 *  as requested) and the interface list is scripted. */

const hoisted = vi.hoisted(() => {
  const state: { interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>; idleTimeoutMs: number | 'none' | undefined } = {
    interfaces: {},
    idleTimeoutMs: undefined,
  };
  return state;
});

vi.mock('electron', async () => (await import('./helpers/electron-fake.js')).fakeElectronModule);
vi.mock('@sentry/electron/main', async () => (await import('./helpers/electron-fake.js')).fakeSentryModule);
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, networkInterfaces: () => hoisted.interfaces };
});
vi.mock('@costgoblin/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@costgoblin/core')>();
  return {
    ...actual,
    startSharingServer: vi.fn((config: SharingServerConfig, handlers: SharingServerHandlers): Promise<SharingServer> => {
      const { idleTimeoutMs, ...rest } = config;
      const idle = hoisted.idleTimeoutMs === undefined ? idleTimeoutMs : hoisted.idleTimeoutMs;
      return actual.startSharingServer({
        ...rest,
        host: '127.0.0.1',
        port: 0,
        ...(idle === undefined || idle === 'none' ? {} : { idleTimeoutMs: idle }),
      }, handlers);
    }),
  };
});

const ORG_ACCOUNTS = JSON.stringify({
  orgId: 'o-publisher',
  syncedAt: '2026-02-20T00:00:00Z',
  accounts: [{
    id: '111111111111', name: 'Payments Prod', email: 'payments@example.com', status: 'ACTIVE',
    joinedTimestamp: '2024-01-01T00:00:00Z', ouPath: '/Root/Payments', tags: { team: 'payments' },
  }],
});
const REGION_NAMES = JSON.stringify({
  syncedAt: '2026-02-20T00:00:00Z',
  regions: { 'eu-central-1': { longName: 'Europe (Frankfurt)', country: 'DE', continent: 'EU' } },
});

const harnesses: Harness[] = [];
const rogues: SharingServer[] = [];

afterEach(async () => {
  for (const server of rogues.splice(0)) await server.close();
  for (const h of harnesses.splice(0)) {
    await h.ipc.invoke('data-sharing:disable').catch(() => undefined);
    await h.dispose();
  }
  hoisted.interfaces = {};
  hoisted.idleTimeoutMs = undefined;
  vi.mocked(startSharingServer).mockClear();
  vi.useRealTimers();
});

async function app(config: FixtureConfigSet, data: 'synthetic' | 'none'): Promise<Harness> {
  const h = await createHarness({ config, data });
  registerDataSharingHandlers(h.app);
  harnesses.push(h);
  return h;
}

/** A publisher over the synthetic aws-main tree, with org + region names. */
async function publisher(): Promise<Harness> {
  const h = await app('single', 'synthetic');
  await writeFile(join(h.ws.stateDir, 'org-accounts.json'), ORG_ACCOUNTS);
  await writeFile(join(h.ws.stateDir, 'region-names.json'), REGION_NAMES);
  return h;
}

async function enable(h: Harness): Promise<string> {
  const result = await h.ipc.invoke('data-sharing:enable');
  expect(at(result, 'status')).toBe('ok');
  return str(at(result, 'sharing', 'sharingKey'));
}

function rawFile(h: Harness, provider: string, dir: string): string {
  return join(h.ws.dataDir, provider, 'raw', dir, 'data.parquet');
}

/** A sharing server the test controls, serving a hand-built manifest — the
 *  peer a consumer must refuse when it lies. */
async function rogueServer(manifest: PackManifest, signer: IdentityKeyPair, files: ReadonlyMap<string, Buffer>, psk: Buffer): Promise<SharingServer> {
  const server = await startSharingServer({ psk }, {
    getManifest: () => serializeSignedManifest(signManifest(manifest, signer.privateKey)),
    readFile: (p) => {
      const buf = files.get(p);
      return buf === undefined ? Promise.reject(new Error(`unknown file ${p}`)) : Promise.resolve(buf);
    },
  });
  rogues.push(server);
  return server;
}

function rogueKey(port: number, pub: string, psk: Buffer): string {
  return encodeSharingKey({ v: SHARING_KEY_VERSION, hosts: ['127.0.0.1'], port, pub, psk: psk.toString('base64url'), label: 'Rogue peer' });
}

function manifestOf(publisherKey: string, files: PackManifest['files'], configBundle: string | null = null, v: PackManifest['v'] = PACK_MANIFEST_VERSION): PackManifest {
  return {
    v,
    createdAt: '2026-02-21T00:00:00.000Z',
    publisher: publisherKey,
    label: 'Rogue peer',
    configBundle,
    enrichment: { orgAccounts: null, regionNames: null, orgAccountTags: null },
    files,
  };
}

async function closedPort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((resolve) => { srv.listen(0, '127.0.0.1', resolve); });
  const address = srv.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => { srv.close(() => { resolve(); }); });
  return port;
}

describe('data-sharing: publisher status and lifecycle', () => {
  it('reports a disabled status with a persisted identity before sharing is enabled', async () => {
    const pub = await publisher();
    const status = await pub.ipc.invoke('data-sharing:status');
    expect(status).toMatchObject({ enabled: false, sharingKey: null, port: null, hosts: [], filesServed: 0, connectedClients: 0, autoStopsAt: null });
    // The identity and access secret are created on first use, next to the config.
    const identity: unknown = JSON.parse(await readFile(join(pub.ws.configDir, 'peer-identity.json'), 'utf-8'));
    expect(str(at(status, 'fingerprint'))).toBe(publicKeyFingerprint(str(at(identity, 'publicKey'))));
    const secret: unknown = JSON.parse(await readFile(join(pub.ws.configDir, 'peer-sharing.json'), 'utf-8'));
    expect(at(status, 'label')).toBe(at(secret, 'label'));
  });

  it('enables on the fixed port with an idle auto-stop, and a second enable reuses the running server', async () => {
    const pub = await publisher();
    const key = await enable(pub);
    expect(startSharingServer).toHaveBeenCalledTimes(1);
    const config = vi.mocked(startSharingServer).mock.calls[0]?.[0];
    expect(config?.port).toBe(53178);
    expect(config?.idleTimeoutMs).toBe(30 * 60_000);

    const payload = parseSharingKey(key);
    // No routable interface → loopback, so one machine can test both ends.
    expect(payload.hosts).toEqual(['127.0.0.1']);
    const status = await pub.ipc.invoke('data-sharing:status');
    expect(at(status, 'enabled')).toBe(true);
    expect(at(status, 'port')).toBe(payload.port);
    const autoStopsAt = Date.parse(str(at(status, 'autoStopsAt')));
    expect(autoStopsAt).toBeGreaterThan(Date.now() + 29 * 60_000);

    const again = await pub.ipc.invoke('data-sharing:enable');
    expect(at(again, 'sharing', 'sharingKey')).toBe(key);
    expect(startSharingServer).toHaveBeenCalledTimes(1);
  });

  it('advertises only external IPv4 interface addresses', async () => {
    const base = { netmask: '255.0.0.0', mac: '00:00:00:00:00:00', cidr: null };
    hoisted.interfaces = {
      lo0: [{ ...base, address: '127.0.0.1', family: 'IPv4', internal: true }],
      en0: [
        { ...base, address: 'fe80::1', family: 'IPv6', internal: false, scopeid: 4 },
        // Reported as external so the consumer below can still reach it.
        { ...base, address: '127.0.0.1', family: 'IPv4', internal: false },
      ],
      utun3: undefined,
    };
    const pub = await publisher();
    const key = await enable(pub);
    expect(parseSharingKey(key).hosts).toEqual(['127.0.0.1']);
  });

  it('disable stops the server and is idempotent', async () => {
    const pub = await publisher();
    await enable(pub);
    const off = await pub.ipc.invoke('data-sharing:disable');
    expect(off).toMatchObject({ status: 'ok', sharing: { enabled: false, sharingKey: null } });
    expect(await pub.ipc.invoke('data-sharing:disable')).toMatchObject({ status: 'ok', sharing: { enabled: false } });
  });

  it('rotate invalidates the handed-out key and restarts a running server', async () => {
    const pub = await publisher();
    const oldKey = await enable(pub);
    const rotated = await pub.ipc.invoke('data-sharing:rotate');
    expect(at(rotated, 'status')).toBe('ok');
    const newKey = str(at(rotated, 'sharing', 'sharingKey'));
    expect(parseSharingKey(newKey).psk).not.toBe(parseSharingKey(oldKey).psk);
    expect(startSharingServer).toHaveBeenCalledTimes(2);

    const con = await app('none', 'none');
    const stale = await con.ipc.invoke('data-sharing:preview-source', oldKey);
    expect(at(stale, 'status')).toBe('error');
    expect(str(at(stale, 'message'))).toMatch(/^Could not reach the shared source\./);
    expect(at(await con.ipc.invoke('data-sharing:preview-source', newKey), 'status')).toBe('ok');
  });

  it('rotate while disabled only replaces the secret', async () => {
    const pub = await publisher();
    const before: unknown = JSON.parse(await readFile(join(pub.ws.configDir, 'peer-sharing.json'), 'utf-8').catch(() => '{}'));
    const rotated = await pub.ipc.invoke('data-sharing:rotate');
    expect(rotated).toMatchObject({ status: 'ok', sharing: { enabled: false } });
    expect(startSharingServer).not.toHaveBeenCalled();
    const after: unknown = JSON.parse(await readFile(join(pub.ws.configDir, 'peer-sharing.json'), 'utf-8'));
    expect(at(after, 'psk')).not.toBe(at(before, 'psk'));
  });

  it('turns itself off when idle, ignoring a stale callback from a server rotate replaced', async () => {
    hoisted.idleTimeoutMs = 150;
    const pub = await publisher();
    await enable(pub);
    await vi.waitFor(async () => {
      expect(at(await pub.ipc.invoke('data-sharing:status'), 'enabled')).toBe(false);
    }, { timeout: 5_000, interval: 25 });

    hoisted.idleTimeoutMs = undefined;
    await enable(pub);
    const firstOnAutoStop = vi.mocked(startSharingServer).mock.calls[1]?.[0].onAutoStop;
    expect(await pub.ipc.invoke('data-sharing:rotate')).toMatchObject({ status: 'ok', sharing: { enabled: true } });
    // The replaced server's auto-stop lands after rotate: the live one stays.
    firstOnAutoStop?.();
    expect(at(await pub.ipc.invoke('data-sharing:status'), 'enabled')).toBe(true);
  });

  it('reports no auto-stop time for a server without an idle timeout', async () => {
    hoisted.idleTimeoutMs = 'none';
    const pub = await publisher();
    await enable(pub);
    expect(await pub.ipc.invoke('data-sharing:status')).toMatchObject({ enabled: true, autoStopsAt: null });
  });

  it('reports a failure to start (unwritable config directory) as an error result', async () => {
    const h = await createHarness({
      config: 'single',
      overrides: (ws) => ({ configPath: join(ws.root, 'not-a-dir', 'costgoblin.yaml') }),
    });
    harnesses.push(h);
    await writeFile(join(h.ws.root, 'not-a-dir'), 'a file where the config directory should be');
    registerDataSharingHandlers(h.app);
    const enabled = await h.ipc.invoke('data-sharing:enable');
    expect(at(enabled, 'status')).toBe('error');
    expect(str(at(enabled, 'message'))).toMatch(/ENOTDIR|EEXIST|not a directory/i);
    expect(at(await h.ipc.invoke('data-sharing:rotate'), 'status')).toBe('error');
    expect(startSharingServer).not.toHaveBeenCalled();
  });
});

describe('data-sharing: consumer preview', () => {
  it('previews what a publisher offers, per tier, with the config digest and the names it would replace', async () => {
    const pub = await publisher();
    const key = await enable(pub);
    const con = await app('none', 'none');

    const result = await con.ipc.invoke('data-sharing:preview-source', key);
    expect(at(result, 'status')).toBe('ok');
    const preview = at(result, 'preview');
    const pubStatus = await pub.ipc.invoke('data-sharing:status');
    expect(at(preview, 'fingerprint')).toBe(at(pubStatus, 'fingerprint'));
    expect(at(preview, 'hasConfig')).toBe(true);
    expect(at(preview, 'configSummary', 'providers', 0, 'name')).toBe(FIXTURE_AWS_PROVIDER);
    expect(at(preview, 'enrichment')).toEqual({ accounts: 1, regions: 1 });
    expect(list(at(preview, 'tiers')).map(t => [at(t, 'tier'), at(t, 'periods'), at(t, 'fileCount')])).toEqual([
      ['daily', ['2026-01', '2026-02'], 2],
      ['hourly', ['2026-02'], 1],
      ['cost-optimization', ['2026-02'], 1],
    ]);

    // Serving the manifest is publisher-visible activity (no file yet).
    const after = await pub.ipc.invoke('data-sharing:status');
    expect(at(after, 'filesServed')).toBe(0);
    expect(at(after, 'lastServedAt')).not.toBeNull();
    expect(num(at(after, 'bytesServed'))).toBeGreaterThan(0);
    expect(at(after, 'connectedClients')).toBe(1);
    expect(num(at(after, 'bytesPerSecond'))).toBeGreaterThan(0);
  });

  it('rejects malformed keys before touching the network', async () => {
    const con = await app('none', 'none');
    expect(await con.ipc.invoke('data-sharing:preview-source', 42)).toEqual({ status: 'error', message: 'Invalid sharing key' });
    expect(await con.ipc.invoke('data-sharing:add-source', null)).toEqual({ status: 'error', message: 'Invalid sharing key' });
    const garbage = await con.ipc.invoke('data-sharing:preview-source', 'not a key');
    expect(at(garbage, 'message')).toBe('This does not look like a CostGoblin sharing key.');
  });

  it('explains an unreachable publisher', async () => {
    const con = await app('none', 'none');
    const id = generateIdentityKeyPair();
    const key = rogueKey(await closedPort(), id.publicKey, Buffer.alloc(32, 7));
    const result = await con.ipc.invoke('data-sharing:preview-source', key);
    expect(at(result, 'status')).toBe('error');
    expect(str(at(result, 'message'))).toMatch(/^Could not reach the shared source\. .*ECONNREFUSED/);
  });

  it('refuses a snapshot whose signature does not verify', async () => {
    const signer = generateIdentityKeyPair();
    const claimed = generateIdentityKeyPair();
    const psk = Buffer.alloc(32, 1);
    const server = await rogueServer(manifestOf(claimed.publicKey, []), signer, new Map(), psk);
    const con = await app('none', 'none');
    const result = await con.ipc.invoke('data-sharing:preview-source', rogueKey(server.port, claimed.publicKey, psk));
    expect(result).toEqual({ status: 'error', message: 'Snapshot signature is invalid — refusing to import.' });
  });

  it('refuses a validly signed snapshot from a publisher other than the pinned one', async () => {
    const signer = generateIdentityKeyPair();
    const pinned = generateIdentityKeyPair();
    const psk = Buffer.alloc(32, 2);
    const server = await rogueServer(manifestOf(signer.publicKey, []), signer, new Map(), psk);
    const con = await app('none', 'none');
    const result = await con.ipc.invoke('data-sharing:preview-source', rogueKey(server.port, pinned.publicKey, psk));
    expect(result).toEqual({ status: 'error', message: 'Snapshot publisher does not match the sharing key — refusing to import.' });
  });

  it('previews a snapshot that carries no config bundle', async () => {
    const signer = generateIdentityKeyPair();
    const psk = Buffer.alloc(32, 6);
    const body = Buffer.from('hourly-bytes');
    const manifest = manifestOf(signer.publicKey, [
      { path: 'aws-main/raw/hourly-2026-02/data.parquet', size: body.length, sha256: sha256Hex(body) },
    ]);
    const server = await rogueServer(manifest, signer, new Map(), psk);
    const con = await app('none', 'none');
    const result = await con.ipc.invoke('data-sharing:preview-source', rogueKey(server.port, signer.publicKey, psk));
    expect(at(result, 'preview')).toMatchObject({ hasConfig: false, configSummary: null, label: 'Rogue peer' });
    expect(at(result, 'preview', 'tiers')).toEqual([{ tier: 'hourly', periods: ['2026-02'], fileCount: 1, bytes: body.length }]);
  });

  it('offers no snapshot from a publisher that has no provider configured', async () => {
    const pub = await app('none', 'none');
    const key = await enable(pub);
    const con = await app('none', 'none');
    const result = await con.ipc.invoke('data-sharing:preview-source', key);
    expect(at(result, 'status')).toBe('error');
    expect(at(await pub.ipc.invoke('data-sharing:status'), 'filesServed')).toBe(0);
  });

  it('skips unknown tiers and degrades an unparseable config bundle to no digest', async () => {
    const signer = generateIdentityKeyPair();
    const psk = Buffer.alloc(32, 3);
    const body = Buffer.from('weekly-bytes');
    const manifest = manifestOf(signer.publicKey, [
      { path: 'aws-main/raw/weekly-2026-01/data.parquet', size: body.length, sha256: sha256Hex(body) },
    ], 'kind: not-a-bundle\n');
    const server = await rogueServer(manifest, signer, new Map(), psk);
    const con = await app('none', 'none');
    const result = await con.ipc.invoke('data-sharing:preview-source', rogueKey(server.port, signer.publicKey, psk));
    expect(at(result, 'status')).toBe('ok');
    expect(at(result, 'preview', 'hasConfig')).toBe(true);
    expect(at(result, 'preview', 'configSummary')).toBeNull();
    expect(at(result, 'preview', 'enrichment')).toBeNull();
    expect(at(result, 'preview', 'tiers')).toEqual([]);
  });

  it('previews the stored source, and says so when none is stored', async () => {
    const con = await app('none', 'none');
    expect(await con.ipc.invoke('data-sharing:preview-stored-source')).toEqual({ status: 'error', message: 'No shared source configured' });
    expect(await con.ipc.invoke('data-sharing:get-source')).toBeNull();

    const pub = await publisher();
    const key = await enable(pub);
    const added = await con.ipc.invoke('data-sharing:add-source', key, { sources: ['hourly'] });
    expect(at(added, 'status')).toBe('ok');
    expect(at(await con.ipc.invoke('data-sharing:preview-stored-source'), 'status')).toBe('ok');

    // A stored key whose publisher went away surfaces the connect failure.
    await pub.ipc.invoke('data-sharing:disable');
    const gone = await con.ipc.invoke('data-sharing:preview-stored-source');
    expect(str(at(gone, 'message'))).toMatch(/^Could not reach the shared source\./);
  });
});

describe('data-sharing: consumer pull', () => {
  it('a fresh install pulls the chosen month plus config and names, then remembers the source', async () => {
    const pub = await publisher();
    const key = await enable(pub);
    const con = await app('none', 'none');
    expect(await con.ipc.invoke('data-sharing:pull-progress')).toMatchObject({ active: false, phase: 'idle' });

    const result = await con.ipc.invoke('data-sharing:add-source', key, { sources: ['config', 'daily'], periods: ['2026-01'] });
    expect(at(result, 'status')).toBe('ok');
    expect(at(result, 'filesDownloaded')).toBe(1);
    expect(at(result, 'source')).toMatchObject({
      host: '127.0.0.1',
      port: parseSharingKey(key).port,
      periods: ['2026-01'],
      selection: { sources: ['config', 'daily'], periods: ['2026-01'] },
    });
    expect(at(result, 'source', 'fingerprint')).toBe(at(await pub.ipc.invoke('data-sharing:status'), 'fingerprint'));

    // Byte-identical copy, under the provider the imported config names.
    const pulled = await readFile(rawFile(con, FIXTURE_AWS_PROVIDER, 'daily-2026-01'));
    expect(pulled.equals(await readFile(rawFile(pub, FIXTURE_AWS_PROVIDER, 'daily-2026-01')))).toBe(true);
    // No config on the consumer yet → the imported providers get 'default'.
    const config = await readFile(con.ws.configPath, 'utf-8');
    expect(config).toContain(FIXTURE_AWS_PROVIDER);
    expect(config).toContain('credentialsProfile: default');
    // Names rode along with the config tier.
    expect(await readFile(join(con.ws.stateDir, 'region-names.json'), 'utf-8')).toContain('Europe (Frankfurt)');

    expect(await con.ipc.invoke('data-sharing:pull-progress')).toMatchObject({ active: false, phase: 'done', filesDone: 1, filesTotal: 1, error: null });
    expect(at(await con.ipc.invoke('data-sharing:get-source'), 'periods')).toEqual(['2026-01']);
    expect(await con.ipc.invoke('data-sharing:get-source')).toMatchObject({ selection: { sources: ['config', 'daily'] } });

    // The publisher saw a file go out.
    const status = await pub.ipc.invoke('data-sharing:status');
    expect(at(status, 'filesServed')).toBe(1);
  });

  it('refresh reuses the stored selection, skips files already up to date, and an override widens it', async () => {
    const pub = await publisher();
    const key = await enable(pub);
    const con = await app('single', 'none');
    await con.ipc.invoke('data-sharing:add-source', key, { sources: ['daily'], periods: ['2026-01'] });
    const configBefore = await readFile(con.ws.configPath, 'utf-8');

    const same = await con.ipc.invoke('data-sharing:refresh-source');
    expect(at(same, 'status')).toBe('ok');
    expect(at(same, 'filesDownloaded')).toBe(0);
    expect(at(same, 'source', 'selection')).toEqual({ sources: ['daily'], periods: ['2026-01'] });

    const wider = await con.ipc.invoke('data-sharing:refresh-source', { sources: ['daily', 'hourly'] });
    expect(at(wider, 'filesDownloaded')).toBe(2);
    expect(at(wider, 'source', 'periods')).toEqual(['2026-01', '2026-02']);
    expect(await readFile(rawFile(con, FIXTURE_AWS_PROVIDER, 'hourly-2026-02'))).toHaveLength(
      (await readFile(rawFile(pub, FIXTURE_AWS_PROVIDER, 'hourly-2026-02'))).length,
    );
    // Without the config tier neither the config nor the names are touched.
    expect(await readFile(con.ws.configPath, 'utf-8')).toBe(configBefore);
    await expect(readFile(join(con.ws.stateDir, 'region-names.json'), 'utf-8')).rejects.toThrow();
  });

  it('lands data under this machine\'s own provider name', async () => {
    const pub = await publisher();
    const key = await enable(pub);
    const con = await app('none', 'none');
    await writeFile(con.ws.configPath, configYaml(awsProviderYaml('team-aws', 'my-sso')));
    const result = await con.ipc.invoke('data-sharing:add-source', key, { sources: ['daily'], periods: ['2026-02'] });
    expect(at(result, 'filesDownloaded')).toBe(1);
    expect((await readFile(rawFile(con, 'team-aws', 'daily-2026-02'))).length).toBeGreaterThan(0);
  });

  it('stamps an imported config with the first AWS provider\'s profile, never a GCP provider\'s', async () => {
    const pub = await publisher();
    const key = await enable(pub);
    const con = await app('multi', 'none');
    await con.ipc.invoke('data-sharing:add-source', key, { sources: ['config'] });
    expect(await readFile(con.ws.configPath, 'utf-8')).toContain('credentialsProfile: test-profile');

    const gcpOnly = await app('none', 'none');
    await writeFile(gcpOnly.ws.configPath, configYaml(gcpProviderYaml('gcp-only')));
    // The GCP-only config loads — the profile falls back because no AWS provider exists.
    expect((await gcpOnly.app.getConfig()).providers.map(p => p.type)).toEqual(['gcp']);
    gcpOnly.app.invalidateConfig();
    const imported = await gcpOnly.ipc.invoke('data-sharing:add-source', key, { sources: ['config'] });
    expect(at(imported, 'status')).toBe('ok');
    expect(at(imported, 'filesDownloaded')).toBe(0);
    expect(await readFile(gcpOnly.ws.configPath, 'utf-8')).toContain('credentialsProfile: default');
  });

  it('maps a legacy v1 pack\'s fixed aws/ segment onto the local provider, and never pulls an unknown tier', async () => {
    const signer = generateIdentityKeyPair();
    const psk = Buffer.alloc(32, 4);
    const body = Buffer.from('v1-parquet-bytes');
    const path = 'aws/raw/daily-2026-01/legacy.parquet';
    const weekly = 'aws/raw/weekly-2026-01/odd.parquet';
    const server = await rogueServer(
      manifestOf(signer.publicKey, [
        { path, size: body.length, sha256: sha256Hex(body) },
        { path: weekly, size: body.length, sha256: sha256Hex(body) },
      ], null, 1),
      signer, new Map([[path, body], [weekly, body]]), psk,
    );
    const con = await app('single', 'none');
    const result = await con.ipc.invoke('data-sharing:add-source', rogueKey(server.port, signer.publicKey, psk));
    expect(at(result, 'filesDownloaded')).toBe(1);
    expect(at(result, 'source', 'periods')).toEqual(['2026-01']);
    expect(await readFile(join(con.ws.dataDir, FIXTURE_AWS_PROVIDER, 'raw', 'daily-2026-01', 'legacy.parquet'), 'utf-8')).toBe('v1-parquet-bytes');
    await expect(readFile(join(con.ws.dataDir, FIXTURE_AWS_PROVIDER, 'raw', 'weekly-2026-01', 'odd.parquet'))).rejects.toThrow();
  });

  it('re-downloads a local file whose contents drifted from the signed copy', async () => {
    const pub = await publisher();
    const key = await enable(pub);
    const con = await app('single', 'none');
    const dest = rawFile(con, FIXTURE_AWS_PROVIDER, 'daily-2026-02');
    await mkdir(join(dest, '..'), { recursive: true });
    await writeFile(dest, 'stale local bytes');
    const result = await con.ipc.invoke('data-sharing:add-source', key, { sources: ['daily'], periods: ['2026-02'] });
    expect(at(result, 'filesDownloaded')).toBe(1);
    expect((await readFile(dest)).equals(await readFile(rawFile(pub, FIXTURE_AWS_PROVIDER, 'daily-2026-02')))).toBe(true);
  });

  it('a selection with no tiers pulls nothing; a pull with no selection pulls everything and refresh keeps it unscoped', async () => {
    const pub = await publisher();
    const key = await enable(pub);
    const con = await app('single', 'none');
    const nothing = await con.ipc.invoke('data-sharing:add-source', key, { periods: ['2026-01'] });
    expect(at(nothing, 'filesDownloaded')).toBe(0);
    expect(at(nothing, 'source', 'selection')).toEqual({ sources: [], periods: ['2026-01'] });

    const everything = await con.ipc.invoke('data-sharing:add-source', key);
    expect(at(everything, 'filesDownloaded')).toBe(4);
    expect(at(everything, 'source', 'selection')).toBeUndefined();
    const refreshed = await con.ipc.invoke('data-sharing:refresh-source');
    expect(at(refreshed, 'filesDownloaded')).toBe(0);
    expect(at(refreshed, 'source', 'selection')).toBeUndefined();
    expect(at(refreshed, 'source', 'periods')).toEqual(['2026-01', '2026-02']);
  });

  it('keeps the consumer\'s own names when the shared ones fail the strict decode', async () => {
    const pub = await publisher();
    await writeFile(join(pub.ws.stateDir, 'region-names.json'), JSON.stringify({ syncedAt: '2026-02-20T00:00:00Z', regions: {} }));
    const key = await enable(pub);
    const con = await app('single', 'none');
    const mine = JSON.stringify({ syncedAt: '2026-01-01T00:00:00Z', regions: { 'us-east-1': { longName: 'Mine', country: 'US', continent: 'NA' } } });
    await writeFile(join(con.ws.stateDir, 'region-names.json'), mine);
    const result = await con.ipc.invoke('data-sharing:add-source', key, { sources: ['config'] });
    expect(at(result, 'status')).toBe('ok');
    expect(await readFile(join(con.ws.stateDir, 'region-names.json'), 'utf-8')).toBe(mine);
    // The org accounts decoded fine, so they did land.
    expect(await readFile(join(con.ws.stateDir, 'org-accounts.json'), 'utf-8')).toContain('Payments Prod');
  });

  it('refuses a file whose bytes do not match the signed checksum, and reports it as pull progress', async () => {
    const signer = generateIdentityKeyPair();
    const psk = Buffer.alloc(32, 5);
    const path = 'aws-main/raw/daily-2026-01/data.parquet';
    const served = Buffer.from('tampered');
    const server = await rogueServer(
      manifestOf(signer.publicKey, [{ path, size: served.length, sha256: sha256Hex(Buffer.from('original')) }]),
      signer, new Map([[path, served]]), psk,
    );
    const con = await app('none', 'none');
    const result = await con.ipc.invoke('data-sharing:add-source', rogueKey(server.port, signer.publicKey, psk));
    expect(result).toEqual({ status: 'error', message: `Checksum mismatch for ${path} — refusing to import.` });
    expect(await con.ipc.invoke('data-sharing:pull-progress')).toMatchObject({
      active: false, phase: 'error', error: `Checksum mismatch for ${path} — refusing to import.`, filesTotal: 1,
    });
    expect(await con.ipc.invoke('data-sharing:get-source')).toBeNull();
  });

  it('refresh with no stored source errors, and a refresh failure keeps the stored source', async () => {
    const con = await app('none', 'none');
    expect(await con.ipc.invoke('data-sharing:refresh-source')).toEqual({ status: 'error', message: 'No shared source configured' });

    const pub = await publisher();
    const key = await enable(pub);
    await con.ipc.invoke('data-sharing:add-source', key, { sources: ['hourly'] });
    await pub.ipc.invoke('data-sharing:disable');
    const failed = await con.ipc.invoke('data-sharing:refresh-source');
    expect(str(at(failed, 'message'))).toMatch(/^Could not reach the shared source\./);
    expect(at(await con.ipc.invoke('data-sharing:get-source'), 'periods')).toEqual(['2026-02']);

    await con.ipc.invoke('data-sharing:remove-source');
    expect(await con.ipc.invoke('data-sharing:get-source')).toBeNull();
    // Removing again is a no-op.
    await expect(con.ipc.invoke('data-sharing:remove-source')).resolves.toBeUndefined();
  });

  it('drops peers and throughput from the banner once their activity window has passed', async () => {
    const pub = await publisher();
    const key = await enable(pub);
    const con = await app('none', 'none');
    await con.ipc.invoke('data-sharing:preview-source', key);
    expect(at(await pub.ipc.invoke('data-sharing:status'), 'connectedClients')).toBe(1);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 60_000);
    const later = await pub.ipc.invoke('data-sharing:status');
    expect(at(later, 'connectedClients')).toBe(0);
    expect(at(later, 'bytesPerSecond')).toBe(0);
    expect(num(at(later, 'bytesServed'))).toBeGreaterThan(0);
  });
});

describe('data-sharing: what a publisher serves', () => {
  it('serves only regular .parquet files from real period directories', async () => {
    const pub = await publisher();
    const raw = join(pub.ws.dataDir, FIXTURE_AWS_PROVIDER, 'raw');
    await writeFile(join(raw, 'README.txt'), 'not a period dir');
    await writeFile(join(raw, 'daily-2026-01', 'notes.txt'), 'not parquet');
    await writeFile(join(raw, 'daily-2026-01', 'bad name.parquet'), 'unsafe pack path');
    await mkdir(join(pub.ws.root, 'outside'), { recursive: true });
    await writeFile(join(pub.ws.root, 'outside', 'secret.parquet'), 'off-tree');
    await symlink(join(pub.ws.root, 'outside'), join(raw, 'daily-2025-12'));
    const key = await enable(pub);

    const con = await app('none', 'none');
    const result = await con.ipc.invoke('data-sharing:preview-source', key);
    const daily = list(at(result, 'preview', 'tiers')).find(t => at(t, 'tier') === 'daily');
    expect(at(daily, 'periods')).toEqual(['2026-01', '2026-02']);
    expect(at(daily, 'fileCount')).toBe(2);
  });

  // A period directory the publisher cannot list is skipped, not fatal.
  // (Permission bits don't stop root, and Windows has no chmod 000.)
  const canRevokeRead = process.platform !== 'win32' && process.getuid?.() !== 0;
  it.runIf(canRevokeRead)('skips a period directory it cannot read', async () => {
    const pub = await publisher();
    const locked = join(pub.ws.dataDir, FIXTURE_AWS_PROVIDER, 'raw', 'hourly-2026-02');
    await chmod(locked, 0o000);
    try {
      const key = await enable(pub);
      const con = await app('none', 'none');
      const result = await con.ipc.invoke('data-sharing:preview-source', key);
      expect(list(at(result, 'preview', 'tiers')).map(t => at(t, 'tier'))).toEqual(['daily', 'cost-optimization']);
    } finally {
      await chmod(locked, 0o755);
    }
  });

  it('serves an empty snapshot when the provider has no data on disk', async () => {
    const pub = await app('single', 'none');
    const key = await enable(pub);
    const con = await app('none', 'none');
    const result = await con.ipc.invoke('data-sharing:preview-source', key);
    expect(at(result, 'preview', 'tiers')).toEqual([]);
    expect(at(result, 'preview', 'enrichment')).toBeNull();
  });
});
