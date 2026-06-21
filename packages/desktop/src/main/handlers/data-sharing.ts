import { ipcMain } from 'electron';
import { networkInterfaces } from 'node:os';
import {
  encodeSharingKey,
  fetchFile,
  fetchManifest,
  isSafePackPath,
  logger,
  parseSharingKey,
  parseSignedManifest,
  publicKeyFingerprint,
  serializeConfigBundle,
  serializeSignedManifest,
  sha256Hex,
  signManifest,
  startSharingServer,
  verifyManifestSignature,
  PACK_MANIFEST_VERSION,
  SHARING_KEY_VERSION,
} from '@costgoblin/core';
import type {
  DataSharingResult,
  DataSharingStatus,
  IdentityKeyPair,
  PackEnrichment,
  PackFileEntry,
  PackManifest,
  PeerEndpoint,
  PullSharedSourceResult,
  SharedSourceInfo,
  SharingKeyPayload,
  SharingServer,
} from '@costgoblin/core';
import type { AppContext } from './context.js';
import { applyBundleSectionsToDisk, buildCurrentBundle } from './bundle-io.js';
import {
  clearSharedSource,
  loadOrCreateIdentity,
  loadOrCreateSharingSecret,
  loadSharedSource,
  rotateSharingSecret,
  saveSharedSource,
  type StoredSharedSource,
} from './peer-store.js';

/** Fixed port so a handed-out sharing key stays valid across restarts (the
 *  user accepted re-sharing on the rarer IP change). */
const SHARING_PORT = 53178;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Non-internal IPv4 addresses of this machine, with loopback as a fallback
 *  so publisher and consumer can also be tested on one machine. */
function lanHosts(): string[] {
  const hosts: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) hosts.push(addr.address);
    }
  }
  if (hosts.length === 0) hosts.push('127.0.0.1');
  return hosts;
}

function extractPeriodFromPath(path: string): string | null {
  const m = /\/[a-z-]+-(\d{4}-\d{2})/.exec(path);
  return m?.[1] ?? null;
}

export function registerDataSharingHandlers(app: AppContext): void {
  const { ctx, clearAllCaches } = app;
  let server: SharingServer | null = null;

  async function readEnrichment(): Promise<PackEnrichment> {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const base = path.dirname(ctx.dataDir);
    const read = async (name: string): Promise<string | null> => {
      try {
        return await fs.readFile(path.join(base, name), 'utf-8');
      } catch {
        return null;
      }
    };
    return {
      orgAccounts: await read('org-accounts.json'),
      regionNames: await read('region-names.json'),
      orgAccountTags: await read('org-account-tags.json'),
    };
  }

  async function writeEnrichment(enrichment: PackEnrichment): Promise<void> {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const base = path.dirname(ctx.dataDir);
    await fs.mkdir(base, { recursive: true });
    const write = async (name: string, content: string | null): Promise<void> => {
      if (content !== null) await fs.writeFile(path.join(base, name), content, 'utf-8');
    };
    await write('org-accounts.json', enrichment.orgAccounts);
    await write('region-names.json', enrichment.regionNames);
    await write('org-account-tags.json', enrichment.orgAccountTags);
  }

  /** Scan local Parquet, hash every file, and bundle config + enrichment into
   *  a signed manifest. Rebuilt on each request so a peer always sees fresh
   *  data (fine at fixture scale; large datasets are a future optimization). */
  async function buildLocalManifest(identity: IdentityKeyPair, label: string): Promise<PackManifest> {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const rawDir = path.join(ctx.dataDir, 'aws', 'raw');
    const files: PackFileEntry[] = [];
    let dirs: string[] = [];
    try {
      dirs = await fs.readdir(rawDir);
    } catch {
      dirs = [];
    }
    for (const dir of dirs) {
      let names: string[] = [];
      try {
        names = await fs.readdir(path.join(rawDir, dir));
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith('.parquet')) continue;
        const rel = `aws/raw/${dir}/${name}`;
        if (!isSafePackPath(rel)) continue;
        const buf = await fs.readFile(path.join(rawDir, dir, name));
        files.push({ path: rel, size: buf.length, sha256: sha256Hex(buf) });
      }
    }
    return {
      v: PACK_MANIFEST_VERSION,
      createdAt: new Date().toISOString(),
      publisher: identity.publicKey,
      label,
      configBundle: serializeConfigBundle(await buildCurrentBundle(app)),
      enrichment: await readEnrichment(),
      files,
    };
  }

  function currentStatus(): DataSharingStatus {
    const identity = loadOrCreateIdentity(ctx.configPath);
    const secret = loadOrCreateSharingSecret(ctx.configPath);
    const fingerprint = publicKeyFingerprint(identity.publicKey);
    if (server === null) {
      return { enabled: false, sharingKey: null, label: secret.label, port: null, hosts: [], fingerprint };
    }
    const hosts = lanHosts();
    const sharingKey = encodeSharingKey({
      v: SHARING_KEY_VERSION,
      hosts,
      port: server.port,
      pub: identity.publicKey,
      psk: secret.psk,
      label: secret.label,
    });
    return { enabled: true, sharingKey, label: secret.label, port: server.port, hosts, fingerprint };
  }

  async function enable(): Promise<DataSharingStatus> {
    if (server !== null) return currentStatus();
    const identity = loadOrCreateIdentity(ctx.configPath);
    const secret = loadOrCreateSharingSecret(ctx.configPath);
    server = await startSharingServer(
      { psk: Buffer.from(secret.psk, 'base64url'), port: SHARING_PORT },
      {
        getManifest: async () =>
          serializeSignedManifest(signManifest(await buildLocalManifest(identity, secret.label), identity.privateKey)),
        readFile: async (p) => {
          const fs = await import('node:fs/promises');
          const path = await import('node:path');
          return fs.readFile(path.join(ctx.dataDir, p));
        },
      },
    );
    logger.info('Data sharing enabled', { port: server.port });
    return currentStatus();
  }

  async function disable(): Promise<DataSharingStatus> {
    if (server !== null) {
      await server.close();
      server = null;
      logger.info('Data sharing disabled');
    }
    return currentStatus();
  }

  async function pull(payload: SharingKeyPayload): Promise<{
    filesDownloaded: number;
    periods: string[];
    label: string;
    fingerprint: string;
    host: string;
  }> {
    const psk = Buffer.from(payload.psk, 'base64url');
    let endpoint: PeerEndpoint | null = null;
    let signed = null;
    let lastError: unknown = null;
    for (const host of payload.hosts) {
      try {
        const candidate: PeerEndpoint = { host, port: payload.port, psk };
        signed = parseSignedManifest(await fetchManifest(candidate));
        endpoint = candidate;
        break;
      } catch (err: unknown) {
        lastError = err;
      }
    }
    if (endpoint === null || signed === null) {
      throw new Error(`Could not reach the shared source. ${errorMessage(lastError)}`);
    }
    if (!verifyManifestSignature(signed)) {
      throw new Error('Snapshot signature is invalid — refusing to import.');
    }
    if (signed.manifest.publisher !== payload.pub) {
      throw new Error('Snapshot publisher does not match the sharing key — refusing to import.');
    }

    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    let downloaded = 0;
    for (const entry of signed.manifest.files) {
      const dest = path.join(ctx.dataDir, entry.path);
      try {
        const existing = await fs.readFile(dest);
        if (existing.length === entry.size && sha256Hex(existing) === entry.sha256) continue;
      } catch {
        // not present locally — fetch it
      }
      const buf = await fetchFile(endpoint, entry.path);
      if (sha256Hex(buf) !== entry.sha256) {
        throw new Error(`Checksum mismatch for ${entry.path} — refusing to import.`);
      }
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, buf);
      downloaded++;
    }

    if (signed.manifest.configBundle !== null) {
      await applyBundleSectionsToDisk(ctx, signed.manifest.configBundle, 'default');
    }
    await writeEnrichment(signed.manifest.enrichment);
    await clearAllCaches();

    const periods = [...new Set(
      signed.manifest.files.map(f => extractPeriodFromPath(f.path)).filter((p): p is string => p !== null),
    )].sort();
    logger.info('Pulled shared snapshot', { from: endpoint.host, files: downloaded, periods: periods.length });
    return {
      filesDownloaded: downloaded,
      periods,
      label: signed.manifest.label,
      fingerprint: publicKeyFingerprint(signed.manifest.publisher),
      host: endpoint.host,
    };
  }

  function toInfo(source: StoredSharedSource): SharedSourceInfo {
    return {
      label: source.label,
      fingerprint: source.fingerprint,
      host: source.host,
      port: source.port,
      lastPulledAt: source.lastPulledAt,
      periods: source.periods,
    };
  }

  ipcMain.handle('data-sharing:status', (): DataSharingStatus => currentStatus());

  ipcMain.handle('data-sharing:enable', async (): Promise<DataSharingResult> => {
    try {
      return { status: 'ok', sharing: await enable() };
    } catch (err: unknown) {
      return { status: 'error', message: errorMessage(err) };
    }
  });

  ipcMain.handle('data-sharing:disable', async (): Promise<DataSharingResult> => {
    try {
      return { status: 'ok', sharing: await disable() };
    } catch (err: unknown) {
      return { status: 'error', message: errorMessage(err) };
    }
  });

  ipcMain.handle('data-sharing:rotate', async (): Promise<DataSharingResult> => {
    try {
      rotateSharingSecret(ctx.configPath);
      if (server !== null) {
        await server.close();
        server = null;
        await enable();
      }
      return { status: 'ok', sharing: currentStatus() };
    } catch (err: unknown) {
      return { status: 'error', message: errorMessage(err) };
    }
  });

  ipcMain.handle('data-sharing:add-source', async (_event, raw: unknown): Promise<PullSharedSourceResult> => {
    if (typeof raw !== 'string') return { status: 'error', message: 'Invalid sharing key' };
    try {
      const payload = parseSharingKey(raw);
      const result = await pull(payload);
      const source: StoredSharedSource = {
        key: raw,
        label: result.label,
        fingerprint: result.fingerprint,
        host: result.host,
        port: payload.port,
        lastPulledAt: new Date().toISOString(),
        periods: result.periods,
      };
      saveSharedSource(ctx.configPath, source);
      return { status: 'ok', source: toInfo(source), filesDownloaded: result.filesDownloaded };
    } catch (err: unknown) {
      return { status: 'error', message: errorMessage(err) };
    }
  });

  ipcMain.handle('data-sharing:get-source', (): SharedSourceInfo | null => {
    const stored = loadSharedSource(ctx.configPath);
    return stored === null ? null : toInfo(stored);
  });

  ipcMain.handle('data-sharing:refresh-source', async (): Promise<PullSharedSourceResult> => {
    const stored = loadSharedSource(ctx.configPath);
    if (stored === null) return { status: 'error', message: 'No shared source configured' };
    try {
      const payload = parseSharingKey(stored.key);
      const result = await pull(payload);
      const updated: StoredSharedSource = {
        ...stored,
        label: result.label,
        fingerprint: result.fingerprint,
        host: result.host,
        lastPulledAt: new Date().toISOString(),
        periods: result.periods,
      };
      saveSharedSource(ctx.configPath, updated);
      return { status: 'ok', source: toInfo(updated), filesDownloaded: result.filesDownloaded };
    } catch (err: unknown) {
      return { status: 'error', message: errorMessage(err) };
    }
  });

  ipcMain.handle('data-sharing:remove-source', (): void => {
    clearSharedSource(ctx.configPath);
  });
}
