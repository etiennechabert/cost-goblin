import { ipcMain } from 'electron';
import { parseJsonObject } from '@costgoblin/core';
import type { TagCoverageSnapshot } from '@costgoblin/core';
import type { AppContext } from './context.js';

async function tagCoverageHistoryPath(dataDir: string): Promise<string> {
  const path = await import('node:path');
  const baseDir = path.dirname(dataDir);
  return path.join(baseDir, 'state', 'tag-coverage-history.json');
}

async function ensureStateDir(dataDir: string): Promise<void> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const stateDir = path.join(path.dirname(dataDir), 'state');
  try {
    await fs.mkdir(stateDir, { recursive: true });
  } catch {
    // directory already exists
  }
}

function isTagCoverageSnapshot(value: unknown): value is TagCoverageSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj['timestamp'] === 'string' &&
    typeof obj['totalActionableCost'] === 'number' &&
    typeof obj['totalLikelyUntaggableCost'] === 'number' &&
    typeof obj['totalNonResourceCost'] === 'number' &&
    typeof obj['actionableCount'] === 'number' &&
    typeof obj['likelyUntaggableCount'] === 'number' &&
    typeof obj['coveragePercentage'] === 'number'
  );
}

function parseTagCoverageSnapshots(raw: string): readonly TagCoverageSnapshot[] {
  const parsed = parseJsonObject(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isTagCoverageSnapshot);
}

export function registerTagRemediationHandlers(app: AppContext): void {
  const { ctx } = app;

  ipcMain.handle('tag-remediation:get-history', async (): Promise<readonly TagCoverageSnapshot[]> => {
    const fs = await import('node:fs/promises');
    try {
      const raw = await fs.readFile(await tagCoverageHistoryPath(ctx.dataDir), 'utf-8');
      const snapshots = parseTagCoverageSnapshots(raw);
      // Return sorted by timestamp descending (newest first)
      return [...snapshots].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    } catch {
      // file doesn't exist yet
      return [];
    }
  });

  ipcMain.handle('tag-remediation:save-snapshot', async (_event, snapshot: TagCoverageSnapshot): Promise<void> => {
    const fs = await import('node:fs/promises');
    await ensureStateDir(ctx.dataDir);

    // Load existing snapshots
    let existing: TagCoverageSnapshot[] = [];
    try {
      const raw = await fs.readFile(await tagCoverageHistoryPath(ctx.dataDir), 'utf-8');
      existing = [...parseTagCoverageSnapshots(raw)];
    } catch {
      // file doesn't exist yet
    }

    // Extract date part from timestamp for deduplication
    const getDatePart = (timestamp: string): string => timestamp.split('T')[0] ?? timestamp;
    const newDatePart = getDatePart(snapshot.timestamp);

    // Remove any existing snapshot from the same day
    const filtered = existing.filter(s => getDatePart(s.timestamp) !== newDatePart);

    // Add new snapshot and sort descending
    const updated = [...filtered, snapshot].sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    await fs.writeFile(await tagCoverageHistoryPath(ctx.dataDir), JSON.stringify(updated, null, 2));
  });

  ipcMain.handle('tag-remediation:clear-history', async (): Promise<void> => {
    const fs = await import('node:fs/promises');
    try {
      await fs.unlink(await tagCoverageHistoryPath(ctx.dataDir));
    } catch {
      // file doesn't exist — idempotent
    }
  });
}
