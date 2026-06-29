import { app, BrowserWindow, ipcMain, session, shell } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger, parseJsonObject, isStringRecord, parseTelemetryPreferences } from '@costgoblin/core';
import { telemetry } from './telemetry/controller.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import type { LogEntry } from '@costgoblin/core';
import { createDuckDBClient } from './duckdb-client.js';
import type { DuckDBClient } from './duckdb-client.js';
import { resolveMemoryGB, resolveRollupConcurrency, resolveThreads } from './duckdb-tuning.js';
import { createSyncClient } from './sync-client.js';
import type { SyncClient } from './sync-client.js';
import { registerIpcHandlers } from './ipc.js';
import { startMcpServer, stopMcpServer } from './mcp.js';
import { initAutoUpdater, checkForUpdates } from './update-manager.js';
import { registerUpdateHandlers } from './handlers/update.js';
import { validateUrl, SecurityError } from './url-validator.js';
import { validateProfileLabel } from './validators/path-validator.js';

// Log level: debug in dev (NODE_ENV=development or electron-vite serving
// the renderer), or when COSTGOBLIN_LOG_LEVEL=debug. Otherwise info.
const isDev = process.env['NODE_ENV'] === 'development'
  || process.env['ELECTRON_RENDERER_URL'] !== undefined;
const envLevel = process.env['COSTGOBLIN_LOG_LEVEL'];
if (envLevel === 'debug' || envLevel === 'info' || envLevel === 'warn' || envLevel === 'error') {
  logger.setLevel(envLevel);
} else if (isDev) {
  logger.setLevel('debug');
}

/**
 * Format a LogEntry for stdout. Short fields go on the header line
 * (`key=value  key=value`). Multi-line string fields (SQL, stack traces)
 * drop to indented blocks below so the header stays scannable and the
 * multi-line content keeps its shape instead of showing as escaped `\n`.
 */
function formatEntry(entry: LogEntry): string {
  const header = `[${entry.timestamp}] ${entry.level.toUpperCase()} ${entry.message}`;
  if (entry.context === undefined) return `${header}\n`;

  const inline: string[] = [];
  const blocks: { key: string; value: string }[] = [];

  for (const [key, value] of Object.entries(entry.context)) {
    if (typeof value === 'string' && value.includes('\n')) {
      blocks.push({ key, value });
    } else if (typeof value === 'string') {
      inline.push(`${key}=${value}`);
    } else {
      inline.push(`${key}=${JSON.stringify(value)}`);
    }
  }

  let out = header + (inline.length > 0 ? `  ${inline.join('  ')}` : '');
  for (const { key, value } of blocks) {
    const indented = value.split('\n').map(l => `    ${l}`).join('\n');
    out += `\n  ${key}:\n${indented}`;
  }
  return `${out}\n`;
}

logger.addHandler((entry: LogEntry) => {
  process.stdout.write(formatEntry(entry));
});

// ---------------------------------------------------------------------------
// CPU profiling — active only when COSTGOBLIN_PERF_MODE=1
// ---------------------------------------------------------------------------
const perfMode = process.env['COSTGOBLIN_PERF_MODE'] === '1';

if (perfMode) {
  const session = new Session();
  session.connect();

  ipcMain.handle('perf:start-cpu-profile', () => {
    return new Promise<void>((resolve, reject) => {
      session.post('Profiler.enable', (err) => {
        if (err !== null) { reject(err); return; }
        session.post('Profiler.start', (err2) => {
          if (err2 !== null) { reject(err2); return; }
          resolve();
        });
      });
    });
  });

  ipcMain.handle('perf:stop-cpu-profile', (_event: unknown, label: string) => {
    return new Promise<{ path: string }>((resolve, reject) => {
      try {
        validateProfileLabel(label);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      session.post('Profiler.stop', (err, result) => {
        if (err !== null) { reject(err); return; }
        session.post('Profiler.disable');
        const dir = join(tmpdir(), 'costgoblin-perf');
        mkdirSync(dir, { recursive: true });
        const outPath = join(dir, `cpu-${label}.cpuprofile`);
        writeFileSync(outPath, JSON.stringify(result.profile));
        resolve({ path: outPath });
      });
    });
  });

  logger.info('Perf mode enabled — CPU profiling handlers registered');
}

function resolveConfigPath(base: string, name: string): string {
  const envKey = `COSTGOBLIN_${name.toUpperCase()}_PATH`;
  const env = process.env[envKey];
  return typeof env === 'string' && env.length > 0 ? env : join(base, `${name}.yaml`);
}

function installCSP(): void {
  const csp = isDev
    ? [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self' ws:",
      ].join('; ')
    : [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self'",
      ].join('; ');

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });
}

/** Read the user's DuckDB performance overrides from ui-preferences.json (the
 *  same file the UI writes). Returns nulls ("auto") when absent/unreadable so
 *  the worker falls back to the computed defaults. */
function readPerformanceOverrides(userDataPath: string): { memoryLimitGB: number | null; threads: number | null; rollupConcurrency: number | null } {
  try {
    const dataDir = process.env['COSTGOBLIN_DATA_DIR'] ?? join(userDataPath, 'data');
    const prefsFile = join(dirname(dataDir), 'ui-preferences.json');
    const parsed = parseJsonObject(readFileSync(prefsFile, 'utf-8'));
    const perf = parsed?.['performance'];
    if (isStringRecord(perf)) {
      return {
        memoryLimitGB: typeof perf['memoryLimitGB'] === 'number' ? perf['memoryLimitGB'] : null,
        threads: typeof perf['threads'] === 'number' ? perf['threads'] : null,
        rollupConcurrency: typeof perf['rollupConcurrency'] === 'number' ? perf['rollupConcurrency'] : null,
      };
    }
  } catch {
    // no prefs file yet, or unreadable — use computed defaults
  }
  return { memoryLimitGB: null, threads: null, rollupConcurrency: null };
}

async function createWindow(db: DuckDBClient, syncClient: SyncClient): Promise<void> {
  const userDataPath = app.getPath('userData');
  const dataDir = process.env['COSTGOBLIN_DATA_DIR'] ?? join(userDataPath, 'data');
  const configBase = process.env['COSTGOBLIN_CONFIG_DIR'] ?? join(userDataPath, 'config');

  const appContext = registerIpcHandlers({
    db,
    syncClient,
    configPath: resolveConfigPath(configBase, 'costgoblin'),
    dimensionsPath: resolveConfigPath(configBase, 'dimensions'),
    orgTreePath: resolveConfigPath(configBase, 'org-tree'),
    viewsPath: resolveConfigPath(configBase, 'views'),
    costScopePath: resolveConfigPath(configBase, 'cost-scope'),
    dataDir,
  });

  // Apply the persisted rollup-build-parallelism override (perf:set updates it
  // live thereafter). The store is constructed at the default (2); this honours
  // a saved override before the first warmup builds anything.
  appContext.rollupStore.setBuildConcurrency(
    resolveRollupConcurrency(readPerformanceOverrides(userDataPath).rollupConcurrency),
  );

  startMcpServer(appContext).catch((err: unknown) => {
    logger.warn(`mcp: failed to start — ${err instanceof Error ? err.message : String(err)}`);
  });

  const headless = process.env['COSTGOBLIN_HEADLESS'] === '1';

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: !headless,
    backgroundColor: '#0a0a0a',
    titleBarStyle: 'hiddenInset',
    icon: join(__dirname, '..', '..', 'resources', 'icon.png'),
    webPreferences: {
      // Preload script built as CJS (preload.cjs) using esbuild (build:preload)
      // instead of electron-vite because sandbox: true requires CommonJS format.
      preload: join(__dirname, '..', 'worker', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox: true is defense-in-depth on top of contextIsolation and
      // nodeIntegration: false. Prevents a compromised renderer from accessing
      // Node.js APIs even if contextBridge is bypassed. Critical for handling
      // sensitive billing data in a local-first app.
      sandbox: true,
    },
  });

  if (process.env['NODE_ENV'] === 'development' || process.env['ELECTRON_RENDERER_URL'] !== undefined) {
    const rendererUrl = process.env['ELECTRON_RENDERER_URL'];
    if (typeof rendererUrl === 'string') {
      await win.loadURL(rendererUrl);
    } else {
      await win.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
    }
    // DevTools available via Cmd+Option+I when needed
  } else {
    await win.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      validateUrl(url);
      shell.openExternal(url).catch(() => undefined);
    } catch (err) {
      if (err instanceof SecurityError) {
        logger.warn('Blocked dangerous URL in window.open', { url, error: err.message });
      }
    }
    return { action: 'deny' };
  });

  logger.info('Window created');
}

async function main(): Promise<void> {
  // Telemetry is set up BEFORE app.whenReady(): @sentry/electron can only arm the
  // native crash handler before the 'ready' event, so the opt-in is decided here
  // from the saved preference. Toggling the channel in Settings saves the choice
  // and restarts the app to re-arm with the new state.
  const userDataPath = app.getPath('userData');
  const telemetryDataDir = process.env['COSTGOBLIN_DATA_DIR'] ?? join(userDataPath, 'data');
  const telemetryDir = dirname(telemetryDataDir);
  telemetry.initialize(telemetryDir);
  let telemetryPrefs = parseTelemetryPreferences(undefined);
  try {
    const parsed = parseJsonObject(readFileSync(join(telemetryDir, 'ui-preferences.json'), 'utf-8'));
    telemetryPrefs = parseTelemetryPreferences(parsed?.['telemetry']);
  } catch {
    /* no or invalid prefs file → telemetry stays dark */
  }
  // Synchronous + before whenReady: Sentry must init before `ready` to arm
  // native crash capture, so this must not yield to the event loop first.
  telemetry.start(telemetryPrefs);

  await app.whenReady();

  // Worker bundles are built by `npm run build:worker` (esbuild) into out/worker/
  // — sibling to out/main/ where this file lives. We resolve up one level then
  // into out/worker/ to find them.
  const duckdbWorkerPath = join(__dirname, '..', 'worker', 'duckdb-worker.cjs');
  const db = await createDuckDBClient(duckdbWorkerPath);
  const tempDir = join(userDataPath, 'temp');
  mkdirSync(tempDir, { recursive: true });
  const perf = readPerformanceOverrides(userDataPath);
  db.configure({
    tempDir,
    memoryGB: resolveMemoryGB(perf.memoryLimitGB),
    threads: resolveThreads(perf.threads),
  });

  logger.info('DuckDB worker ready');

  const syncWorkerPath = join(__dirname, '..', 'worker', 'sync-worker.cjs');
  const syncClient = await createSyncClient(syncWorkerPath);
  logger.info('Sync worker ready');

  installCSP();
  if (app.isPackaged) {
    try {
      initAutoUpdater();
      checkForUpdates().catch(() => undefined);
    } catch {
      logger.warn('Auto-updater unavailable');
    }
  }
  registerUpdateHandlers();

  await createWindow(db, syncClient);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(db, syncClient).catch(() => undefined);
    }
  });
}

app.on('window-all-closed', () => {
  app.quit();
});

app.on('will-quit', () => {
  void stopMcpServer();
});

// Electron's ESM main entry does not support top-level await at launch, so the
// bootstrap runs as a fire-and-forget async function instead of top-level await.
async function bootstrap(): Promise<void> {
  try {
    await main();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Fatal error: ${message}\n`);
    process.exit(1);
  }
}
void bootstrap();
