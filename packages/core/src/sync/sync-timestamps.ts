import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Per-tier "last successful sync" timestamps, persisted next to the etag files
 *  in the data dir. The in-memory SyncStatus.lastSync resets to null on every
 *  app launch, so this file is the durable record the Sync view and the toolbar
 *  popover read to show "Synced <time>" across restarts. Map: tier → ISO 8601. */
const SYNC_TIMESTAMPS_FILE = 'sync-timestamps.json';

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function readSyncTimestamps(dataDir: string): Promise<Record<string, string>> {
  try {
    const raw = await readFile(join(dataDir, SYNC_TIMESTAMPS_FILE), 'utf-8');
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

export async function readTierLastSync(dataDir: string, tier: string): Promise<string | null> {
  const all = await readSyncTimestamps(dataDir);
  return all[tier] ?? null;
}

// Serialize writes through a single in-process chain so a manual sync and a
// background auto-sync finishing near-simultaneously for different tiers can't
// interleave their read-modify-write and drop each other's timestamp.
let writeChain: Promise<void> = Promise.resolve();

export function writeTierLastSync(dataDir: string, tier: string, isoTimestamp: string): Promise<void> {
  const run = async (): Promise<void> => {
    const existing = await readSyncTimestamps(dataDir);
    existing[tier] = isoTimestamp;
    await writeFile(join(dataDir, SYNC_TIMESTAMPS_FILE), JSON.stringify(existing, null, 2));
  };
  // Run regardless of whether the previous write settled or rejected; the
  // returned promise carries this write's own outcome to the caller.
  writeChain = writeChain.then(run, run);
  return writeChain;
}
