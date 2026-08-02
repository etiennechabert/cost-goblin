import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProviderName } from '../types/branded.js';
import { providerMetaDir } from './provider-paths.js';

/** Per-tier "last successful sync" timestamps, persisted per provider in
 *  `{dataDir}/{providerName}/meta/` next to the etag files. The in-memory
 *  SyncStatus.lastSync resets to null on every app launch, so this file is
 *  the durable record the Sync view and the toolbar popover read to show
 *  "Synced <time>" across restarts. Map: tier → ISO 8601. */
const SYNC_TIMESTAMPS_FILE = 'sync-timestamps.json';

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function timestampsPath(dataDir: string, provider: ProviderName): string {
  return join(providerMetaDir(dataDir, provider), SYNC_TIMESTAMPS_FILE);
}

export async function readSyncTimestamps(dataDir: string, provider: ProviderName): Promise<Record<string, string>> {
  try {
    const raw = await readFile(timestampsPath(dataDir, provider), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!isStringRecord(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  } catch {
    // File missing or unreadable — no timestamps recorded yet.
    return {};
  }
}

export async function readTierLastSync(dataDir: string, provider: ProviderName, tier: string): Promise<string | null> {
  const all = await readSyncTimestamps(dataDir, provider);
  return all[tier] ?? null;
}

// Serialize writes through a single in-process chain so a manual sync and a
// background auto-sync finishing near-simultaneously (any provider, any tier)
// can't interleave their read-modify-write and drop each other's timestamp.
let writeChain: Promise<void> = Promise.resolve();

export function writeTierLastSync(dataDir: string, provider: ProviderName, tier: string, isoTimestamp: string): Promise<void> {
  const run = async (): Promise<void> => {
    const existing = await readSyncTimestamps(dataDir, provider);
    existing[tier] = isoTimestamp;
    await mkdir(providerMetaDir(dataDir, provider), { recursive: true });
    await writeFile(timestampsPath(dataDir, provider), JSON.stringify(existing, null, 2));
  };
  // Run regardless of whether the previous write settled or rejected; the
  // returned promise carries this write's own outcome to the caller.
  writeChain = writeChain.then(run, run);
  return writeChain;
}
