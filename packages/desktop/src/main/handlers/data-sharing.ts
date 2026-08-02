import { ipcMain } from 'electron';
import type { Dirent } from 'node:fs';
import { networkInterfaces } from 'node:os';
import {
  classifyPackPath,
  encodeSharingKey,
  fetchFile,
  fetchManifest,
  isSafePackPath,
  logger,
  parseConfigBundle,
  parseSharingKey,
  parseSignedManifest,
  providerRawDir,
  publicKeyFingerprint,
  readFileWithinRoot,
  serializeConfigBundle,
  serializeSignedManifest,
  sha256Hex,
  signManifest,
  startSharingServer,
  summarizeConfigBundle,
  verifyManifestSignature,
  PACK_MANIFEST_VERSION,
  SHARING_KEY_VERSION,
} from '@costgoblin/core';
import type {
  ConfigBundleSummary,
  DataSharingResult,
  DataSharingStatus,
  IdentityKeyPair,
  PackEnrichment,
  PackFileEntry,
  PackManifest,
  PeerEndpoint,
  PreviewSharedSourceResult,
  ProviderName,
  PullSharedSourceResult,
  SharedDataTier,
  SharedPullProgress,
  SharedPullSelection,
  SharedSourceInfo,
  SharedSourcePreview,
  SharedSourceTierAvailability,
  SharingKeyPayload,
  SharingServer,
  SignedPackManifest,
} from '@costgoblin/core';
import type { AppContext } from './context.js';
import { applyBundleSectionsToDisk, buildCurrentBundle } from './bundle-io.js';
import {
  clearSharedSource,
  loadOrCreateIdentity,
  loadOrCreateSharingSecret,
  loadSharedSource,
  parseSharedPullSelection,
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
  return classifyPackPath(path)?.period ?? null;
}

/** Rewrite a pack path's leading provider segment — the publisher's provider
 *  name in a v2 pack, or the fixed `aws` of a legacy v1 pack — onto THIS
 *  machine's first configured provider, so imported data lands in the local
 *  `{dataDir}/{provider}/raw/…` tree whatever the publisher called theirs.
 *  Paths are isSafePackPath-validated at manifest parse (anchored grammar, no
 *  `..`), so slicing at the first `/` cannot escape the data tree. With no
 *  local provider yet (fresh no-AWS install) the incoming segment is kept:
 *  the config bundle imported alongside names that same provider. */
function remapPackPath(packPath: string, localProvider: ProviderName | null): string {
  if (localProvider === null) return packPath;
  return `${String(localProvider)}${packPath.slice(packPath.indexOf('/'))}`;
}

/** Trailing window over which serving throughput is averaged for the banner. */
const THROUGHPUT_WINDOW_MS = 5000;
/** A peer counts as "connected" if it fetched within this trailing window.
 *  The client opens a fresh socket per request (keep-alive off), so a raw
 *  open-socket count flaps 0↔1 during a pull; a short activity window keyed by
 *  address is a stable, meaningful "currently pulling" gauge. */
const ACTIVE_PEER_WINDOW_MS = 8000;

/** Reach a host from the sharing key, fetch its manifest, and verify both
 *  the signature and that the publisher matches the pinned key. Shared by
 *  preview (no download) and pull (download). */
async function connect(payload: SharingKeyPayload): Promise<{ endpoint: PeerEndpoint; signed: SignedPackManifest }> {
  const psk = Buffer.from(payload.psk, 'base64url');
  let endpoint: PeerEndpoint | null = null;
  let signed: SignedPackManifest | null = null;
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
  return { endpoint, signed };
}

function toInfo(source: StoredSharedSource): SharedSourceInfo {
  return {
    label: source.label,
    fingerprint: source.fingerprint,
    host: source.host,
    port: source.port,
    lastPulledAt: source.lastPulledAt,
    periods: source.periods,
    ...(source.selection === undefined ? {} : { selection: source.selection }),
  };
}

export function registerDataSharingHandlers(app: AppContext): void {
  const { ctx, clearAllCaches } = app;
  let server: SharingServer | null = null;

  // Publisher-side activity, reset each time sharing is enabled.
  let lastServedAt: string | null = null;
  let filesServed = 0;
  let lastPeer: string | null = null;
  let bytesServed = 0;
  // Distinct peers (by address) that fetched within ACTIVE_PEER_WINDOW_MS.
  let peerActivity = new Map<string, number>();
  // Rolling (timestamp, bytes) samples, pruned to THROUGHPUT_WINDOW_MS, used to
  // estimate live serving throughput for the banner.
  let byteSamples: { t: number; bytes: number }[] = [];

  function recordServed(bytes: number, remoteAddress: string | null): void {
    const now = Date.now();
    bytesServed += bytes;
    byteSamples.push({ t: now, bytes });
    byteSamples = byteSamples.filter(s => s.t >= now - THROUGHPUT_WINDOW_MS);
    if (remoteAddress !== null) peerActivity.set(remoteAddress, now);
  }

  function bytesPerSecond(): number {
    const now = Date.now();
    const live = byteSamples.filter(s => s.t >= now - THROUGHPUT_WINDOW_MS);
    if (live.length === 0) return 0;
    const sum = live.reduce((n, s) => n + s.bytes, 0);
    const oldest = live.reduce((min, s) => Math.min(min, s.t), now);
    const spanSec = Math.max((now - oldest) / 1000, 0.5);
    return Math.round(sum / spanSec);
  }

  function activePeerCount(): number {
    const cutoff = Date.now() - ACTIVE_PEER_WINDOW_MS;
    for (const [addr, t] of peerActivity) {
      if (t < cutoff) peerActivity.delete(addr);
    }
    return peerActivity.size;
  }

  // Consumer-side pull progress, polled by the UI while a pull is running.
  let pullProgress: SharedPullProgress = { active: false, phase: 'idle', filesDone: 0, filesTotal: 0, currentPeriod: null, bytesDone: 0, bytesTotal: 0, error: null };

  async function readEnrichment(): Promise<PackEnrichment> {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const base = ctx.stateDir;
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
    const base = ctx.stateDir;
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
    // Single-provider semantics (#516 phase 2): the export root is the FIRST
    // configured provider's raw tree, and its (real) name is the leading
    // segment of every v2 pack path. No provider yet → nothing to serve.
    const provider = await app.getFirstProviderName();
    const files: PackFileEntry[] = [];
    if (provider !== null) {
      const rawDir = providerRawDir(ctx.dataDir, provider);
      let dirs: Dirent[] = [];
      try {
        dirs = await fs.readdir(rawDir, { withFileTypes: true });
      } catch {
        dirs = [];
      }
      for (const dir of dirs) {
        // isDirectory() is false for a symlink entry, so symlinked period dirs
        // are skipped — we never serve through a link out of the data tree.
        if (!dir.isDirectory()) continue;
        let entries: Dirent[] = [];
        try {
          entries = await fs.readdir(path.join(rawDir, dir.name), { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith('.parquet')) continue;
          const rel = `${String(provider)}/raw/${dir.name}/${entry.name}`;
          if (!isSafePackPath(rel)) continue;
          const buf = await fs.readFile(path.join(rawDir, dir.name, entry.name));
          files.push({ path: rel, size: buf.length, sha256: sha256Hex(buf) });
        }
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
      return { enabled: false, sharingKey: null, label: secret.label, port: null, hosts: [], fingerprint, lastServedAt: null, filesServed: 0, lastPeer: null, bytesServed: 0, connectedClients: 0, bytesPerSecond: 0 };
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
    return { enabled: true, sharingKey, label: secret.label, port: server.port, hosts, fingerprint, lastServedAt, filesServed, lastPeer, bytesServed, connectedClients: activePeerCount(), bytesPerSecond: bytesPerSecond() };
  }

  async function enable(): Promise<DataSharingStatus> {
    if (server !== null) return currentStatus();
    const identity = loadOrCreateIdentity(ctx.configPath);
    const secret = loadOrCreateSharingSecret(ctx.configPath);
    lastServedAt = null;
    filesServed = 0;
    lastPeer = null;
    bytesServed = 0;
    peerActivity = new Map();
    byteSamples = [];
    server = await startSharingServer(
      {
        psk: Buffer.from(secret.psk, 'base64url'),
        port: SHARING_PORT,
        onAccess: (event) => {
          lastServedAt = new Date().toISOString();
          lastPeer = event.remoteAddress;
          if (event.kind === 'file') filesServed++;
          recordServed(event.bytes, event.remoteAddress);
        },
      },
      {
        getManifest: async () =>
          serializeSignedManifest(signManifest(await buildLocalManifest(identity, secret.label), identity.privateKey)),
        readFile: async (p) => {
          const path = await import('node:path');
          // `p` is already string-validated by isSafePackPath, but a symlink in
          // the data tree could still redirect the read off-tree — confine the
          // resolved path to the first provider's raw tree (the only root the
          // manifest advertises; a `p` under any other segment fails here).
          const provider = await app.getFirstProviderName();
          if (provider === null) throw new Error('No provider configured');
          const rawRoot = providerRawDir(ctx.dataDir, provider);
          return readFileWithinRoot(rawRoot, path.join(ctx.dataDir, p));
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

  /** Summarize what a verified manifest offers — per-tier months/counts/bytes
   *  plus the config digest — so the UI can show a month picker before pulling. */
  function buildPreview(signed: SignedPackManifest): SharedSourcePreview {
    const byTier = new Map<SharedDataTier, { periods: Set<string>; fileCount: number; bytes: number }>();
    for (const f of signed.manifest.files) {
      const c = classifyPackPath(f.path);
      if (c === null) continue;
      const entry = byTier.get(c.tier) ?? { periods: new Set<string>(), fileCount: 0, bytes: 0 };
      entry.periods.add(c.period);
      entry.fileCount++;
      entry.bytes += f.size;
      byTier.set(c.tier, entry);
    }
    const tierOrder: readonly SharedDataTier[] = ['daily', 'hourly', 'cost-optimization'];
    const tiers: SharedSourceTierAvailability[] = [];
    for (const tier of tierOrder) {
      const e = byTier.get(tier);
      if (e === undefined) continue;
      tiers.push({ tier, periods: [...e.periods].sort((a, b) => a.localeCompare(b)), fileCount: e.fileCount, bytes: e.bytes });
    }
    let configSummary: ConfigBundleSummary | null = null;
    if (signed.manifest.configBundle !== null) {
      try { configSummary = summarizeConfigBundle(parseConfigBundle(signed.manifest.configBundle)); }
      catch { configSummary = null; }
    }
    return {
      label: signed.manifest.label,
      fingerprint: publicKeyFingerprint(signed.manifest.publisher),
      hasConfig: signed.manifest.configBundle !== null,
      configSummary,
      tiers,
    };
  }

  /** Profile to stamp onto an imported config. The bundle never carries one,
   *  so reuse this machine's configured profile; fall back to 'default' on a
   *  fresh install where no config exists yet (the no-AWS peer-import case). */
  async function resolveImportProfile(): Promise<string> {
    try {
      const config = await app.getConfig();
      const profile = config.providers[0]?.credentialsProfile;
      if (typeof profile === 'string' && profile.length > 0) return profile;
    } catch {
      // No config on disk yet — fall through to the default.
    }
    return 'default';
  }

  async function pull(payload: SharingKeyPayload, selection?: SharedPullSelection): Promise<{
    filesDownloaded: number;
    periods: string[];
    label: string;
    fingerprint: string;
    host: string;
  }> {
    pullProgress = { active: true, phase: 'connecting', filesDone: 0, filesTotal: 0, currentPeriod: null, bytesDone: 0, bytesTotal: 0, error: null };
    try {
      const { endpoint, signed } = await connect(payload);
      const wantConfig = selection === undefined || selection.sources.includes('config');
      const periodSet = selection?.periods === undefined ? null : new Set(selection.periods);
      // Filter the (already-signed) file list to the chosen tiers + months.
      // No protocol change: the manifest signature covers the whole set; we
      // simply choose which signed entries to download.
      const files = signed.manifest.files.filter(entry => {
        const c = classifyPackPath(entry.path);
        if (c === null) return false;
        if (selection !== undefined && !selection.sources.includes(c.tier)) return false;
        if (periodSet !== null && !periodSet.has(c.period)) return false;
        return true;
      });

      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      // Every incoming provider segment (v2 real names, v1 'aws') maps onto
      // the first LOCAL provider's directory — single-provider semantics.
      const localProvider = await app.getFirstProviderName();
      const total = files.length;
      const bytesTotal = files.reduce((n, f) => n + f.size, 0);
      pullProgress = { active: true, phase: 'downloading', filesDone: 0, filesTotal: total, currentPeriod: null, bytesDone: 0, bytesTotal, error: null };
      let downloaded = 0;
      let done = 0;
      let bytesDone = 0;
      for (const entry of files) {
        pullProgress = { active: true, phase: 'downloading', filesDone: done, filesTotal: total, currentPeriod: extractPeriodFromPath(entry.path), bytesDone, bytesTotal, error: null };
        const dest = path.join(ctx.dataDir, remapPackPath(entry.path, localProvider));
        try {
          const existing = await fs.readFile(dest);
          if (existing.length === entry.size && sha256Hex(existing) === entry.sha256) {
            done++;
            bytesDone += entry.size;
            continue;
          }
        } catch {
          // not present locally — fetch it
        }
        const buf = await fetchFile(endpoint, entry.path, entry.size);
        if (sha256Hex(buf) !== entry.sha256) {
          throw new Error(`Checksum mismatch for ${entry.path} — refusing to import.`);
        }
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, buf);
        downloaded++;
        done++;
        bytesDone += entry.size;
      }

      pullProgress = { active: true, phase: 'importing', filesDone: done, filesTotal: total, currentPeriod: null, bytesDone, bytesTotal, error: null };
      if (wantConfig && signed.manifest.configBundle !== null) {
        await applyBundleSectionsToDisk(ctx, signed.manifest.configBundle, await resolveImportProfile());
      }
      // Enrichment (account/region names) is reference data that makes the
      // pulled rows readable, so it always lands regardless of the config toggle.
      await writeEnrichment(signed.manifest.enrichment);
      await clearAllCaches();

      const periods = [...new Set(
        files.map(f => extractPeriodFromPath(f.path)).filter((p): p is string => p !== null),
      )].sort((a, b) => a.localeCompare(b));
      logger.info('Pulled shared snapshot', { from: endpoint.host, files: downloaded, periods: periods.length });
      pullProgress = { active: false, phase: 'done', filesDone: done, filesTotal: total, currentPeriod: null, bytesDone, bytesTotal, error: null };
      return {
        filesDownloaded: downloaded,
        periods,
        label: signed.manifest.label,
        fingerprint: publicKeyFingerprint(signed.manifest.publisher),
        host: endpoint.host,
      };
    } catch (err: unknown) {
      pullProgress = { ...pullProgress, active: false, phase: 'error', error: errorMessage(err) };
      throw err;
    }
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

  ipcMain.handle('data-sharing:preview-source', async (_event, raw: unknown): Promise<PreviewSharedSourceResult> => {
    if (typeof raw !== 'string') return { status: 'error', message: 'Invalid sharing key' };
    try {
      const { signed } = await connect(parseSharingKey(raw));
      return { status: 'ok', preview: buildPreview(signed) };
    } catch (err: unknown) {
      return { status: 'error', message: errorMessage(err) };
    }
  });

  ipcMain.handle('data-sharing:preview-stored-source', async (): Promise<PreviewSharedSourceResult> => {
    const stored = loadSharedSource(ctx.configPath);
    if (stored === null) return { status: 'error', message: 'No shared source configured' };
    try {
      const { signed } = await connect(parseSharingKey(stored.key));
      return { status: 'ok', preview: buildPreview(signed) };
    } catch (err: unknown) {
      return { status: 'error', message: errorMessage(err) };
    }
  });

  ipcMain.handle('data-sharing:add-source', async (_event, raw: unknown, rawSelection: unknown): Promise<PullSharedSourceResult> => {
    if (typeof raw !== 'string') return { status: 'error', message: 'Invalid sharing key' };
    try {
      const payload = parseSharingKey(raw);
      const selection = parseSharedPullSelection(rawSelection);
      const result = await pull(payload, selection);
      const source: StoredSharedSource = {
        key: raw,
        label: result.label,
        fingerprint: result.fingerprint,
        host: result.host,
        port: payload.port,
        lastPulledAt: new Date().toISOString(),
        periods: result.periods,
        ...(selection === undefined ? {} : { selection }),
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

  ipcMain.handle('data-sharing:pull-progress', (): SharedPullProgress => pullProgress);

  ipcMain.handle('data-sharing:refresh-source', async (_event, rawSelection: unknown): Promise<PullSharedSourceResult> => {
    const stored = loadSharedSource(ctx.configPath);
    if (stored === null) return { status: 'error', message: 'No shared source configured' };
    try {
      const selection = parseSharedPullSelection(rawSelection) ?? stored.selection;
      const result = await pull(parseSharingKey(stored.key), selection);
      const updated: StoredSharedSource = {
        ...stored,
        label: result.label,
        fingerprint: result.fingerprint,
        host: result.host,
        lastPulledAt: new Date().toISOString(),
        periods: result.periods,
        ...(selection === undefined ? {} : { selection }),
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
