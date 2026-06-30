import { parentPort } from 'node:worker_threads';
import { syncSelectedFiles, logger } from '@costgoblin/core';
import type { SelectiveSyncOptions, ManifestFileEntry, SyncProgress, SyncLogLevel } from '@costgoblin/core';

if (parentPort === null) {
  throw new Error('sync-worker.ts must be run as a Node.js Worker thread');
}
const port = parentPort;

// ---------------------------------------------------------------------------
// Message protocol types
// ---------------------------------------------------------------------------

interface SyncRequest {
  readonly kind: 'sync';
  readonly id: number;
  readonly bucketPath: string;
  readonly profile: string;
  readonly dataDir: string;
  readonly tier: string;
  readonly files: readonly ManifestFileEntry[];
}

interface CancelRequest {
  readonly kind: 'cancel';
  readonly id: number;
}

interface ReadyResponse {
  readonly kind: 'ready';
}

interface ProgressResponse {
  readonly kind: 'progress';
  readonly id: number;
  readonly phase: 'downloading' | 'repartitioning' | 'done';
  readonly filesDone: number;
  readonly filesTotal: number;
  readonly bytesDone?: number;
  readonly bytesTotal?: number;
  readonly message?: string;
}

interface CompleteResponse {
  readonly kind: 'complete';
  readonly id: number;
  readonly filesDownloaded: number;
  readonly rowsProcessed: number;
}

interface ErrorResponse {
  readonly kind: 'error';
  readonly id: number;
  readonly message: string;
}

// Worker logs go to a logger with no handlers in this thread (the stdout handler
// is installed only in main), so they'd otherwise be discarded. Forward every
// entry to main — the worker runs nothing but the sync, so all of it is
// sync/S3 activity for the Data & Sync log panel.
interface LogResponse {
  readonly kind: 'log';
  readonly level: SyncLogLevel;
  readonly message: string;
  readonly ts: number;
}

type WorkerResponse = ReadyResponse | ProgressResponse | CompleteResponse | ErrorResponse | LogResponse;

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function hasProps(msg: unknown): msg is Record<string, unknown> {
  return typeof msg === 'object' && msg !== null;
}

function isSyncRequest(msg: unknown): msg is SyncRequest {
  if (!hasProps(msg)) return false;
  return (
    msg['kind'] === 'sync' &&
    typeof msg['id'] === 'number' &&
    typeof msg['bucketPath'] === 'string' &&
    typeof msg['profile'] === 'string' &&
    typeof msg['dataDir'] === 'string' &&
    typeof msg['tier'] === 'string' &&
    Array.isArray(msg['files'])
  );
}

function isCancelRequest(msg: unknown): msg is CancelRequest {
  if (!hasProps(msg)) return false;
  return msg['kind'] === 'cancel' && typeof msg['id'] === 'number';
}

// ---------------------------------------------------------------------------
// Sync state tracking
// ---------------------------------------------------------------------------

const activeControllers = new Map<number, AbortController>();
const cancelledIds = new Set<number>();

// ---------------------------------------------------------------------------
// Message sending
// ---------------------------------------------------------------------------

function send(msg: WorkerResponse): void {
  port.postMessage(msg);
}

// Forward this thread's logs (the `[aws] …` transfer lines, "Processing
// period", "Sync complete", prune warnings) to main so the Data & Sync panel
// can tail them. minLevel is 'info' by default, so debug noise is dropped.
logger.addHandler((entry) => {
  send({ kind: 'log', level: entry.level, message: entry.message, ts: Date.parse(entry.timestamp) });
});

// ---------------------------------------------------------------------------
// Sync request handler
// ---------------------------------------------------------------------------

async function handleSyncRequest(req: SyncRequest): Promise<void> {
  // Check if already cancelled before starting
  if (cancelledIds.has(req.id)) {
    cancelledIds.delete(req.id);
    send({ kind: 'error', id: req.id, message: 'Download cancelled' });
    return;
  }

  const controller = new AbortController();
  activeControllers.set(req.id, controller);

  try {
    const options: SelectiveSyncOptions = {
      bucketPath: req.bucketPath,
      profile: req.profile,
      dataDir: req.dataDir,
      expectedDataType: req.tier as 'daily' | 'hourly' | 'cost-optimization' | undefined,
      files: req.files,
      signal: controller.signal,
      onProgress: (progress: SyncProgress) => {
        // Skip sending progress if cancelled
        if (cancelledIds.has(req.id)) return;

        // Only include optional fields when set (exactOptionalPropertyTypes)
        send({
          kind: 'progress',
          id: req.id,
          phase: progress.phase,
          filesDone: progress.filesDone,
          filesTotal: progress.filesTotal,
          ...(progress.bytesDone === undefined ? {} : { bytesDone: progress.bytesDone }),
          ...(progress.bytesTotal === undefined ? {} : { bytesTotal: progress.bytesTotal }),
          ...(progress.message === undefined ? {} : { message: progress.message }),
        });
      },
    };

    const result = await syncSelectedFiles(options);

    // Skip sending result if cancelled during execution
    if (cancelledIds.has(req.id)) {
      cancelledIds.delete(req.id);
      send({ kind: 'error', id: req.id, message: 'Download cancelled' });
    } else {
      send({
        kind: 'complete',
        id: req.id,
        filesDownloaded: result.filesDownloaded,
        rowsProcessed: result.rowsProcessed,
      });
    }
  } catch (err: unknown) {
    // Check if this was a cancellation
    if (cancelledIds.has(req.id)) {
      cancelledIds.delete(req.id);
      send({ kind: 'error', id: req.id, message: 'Download cancelled' });
    } else {
      const message = err instanceof Error ? err.message : String(err);
      send({ kind: 'error', id: req.id, message });
    }
  } finally {
    activeControllers.delete(req.id);
  }
}

function handleCancelRequest(req: CancelRequest): void {
  cancelledIds.add(req.id);
  const controller = activeControllers.get(req.id);
  if (controller !== undefined) {
    controller.abort();
  }
}

// ---------------------------------------------------------------------------
// Worker initialization
// ---------------------------------------------------------------------------

// Send ready signal immediately (no async initialization needed)
send({ kind: 'ready' });

// Handle incoming messages
port.on('message', (msg: unknown) => {
  if (isSyncRequest(msg)) {
    void handleSyncRequest(msg);
  } else if (isCancelRequest(msg)) {
    handleCancelRequest(msg);
  }
});
