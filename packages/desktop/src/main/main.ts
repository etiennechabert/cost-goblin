import { app, BrowserWindow, ipcMain, session, shell } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '@costgoblin/core';
import type { LogEntry } from '@costgoblin/core';
import { createDuckDBClient } from './duckdb-client.js';
import type { DuckDBClient } from './duckdb-client.js';
import { createSyncClient } from './sync-client.js';
import type { SyncClient } from './sync-client.js';
import { registerIpcHandlers } from './ipc.js';
import { initAutoUpdater } from './update-manager.js';
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

async function createWindow(db: DuckDBClient, syncClient: SyncClient): Promise<void> {
  const userDataPath = app.getPath('userData');
  const dataDir = process.env['COSTGOBLIN_DATA_DIR'] ?? join(userDataPath, 'data');
  const configBase = process.env['COSTGOBLIN_CONFIG_DIR'] ?? join(userDataPath, 'config');

  registerIpcHandlers({
    db,
    syncClient,
    configPath: resolveConfigPath(configBase, 'costgoblin'),
    dimensionsPath: resolveConfigPath(configBase, 'dimensions'),
    orgTreePath: resolveConfigPath(configBase, 'org-tree'),
    viewsPath: resolveConfigPath(configBase, 'views'),
    costScopePath: resolveConfigPath(configBase, 'cost-scope'),
    dataDir,
  });

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
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
    win.webContents.openDevTools({ mode: 'detach' });
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
  await app.whenReady();

  // Worker bundles are built by `npm run build:worker` (esbuild) into out/worker/
  // — sibling to out/main/ where this file lives. We resolve up one level then
  // into out/worker/ to find them.
  const duckdbWorkerPath = join(__dirname, '..', 'worker', 'duckdb-worker.cjs');
  const db = await createDuckDBClient(duckdbWorkerPath);
  logger.info('DuckDB worker ready');

  const syncWorkerPath = join(__dirname, '..', 'worker', 'sync-worker.cjs');
  const syncClient = await createSyncClient(syncWorkerPath);
  logger.info('Sync worker ready');

  installCSP();
  initAutoUpdater();
  registerUpdateHandlers();
  await createWindow(db, syncClient);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(db, syncClient).catch(() => undefined);
    }
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

void (async () => {
  try {
    await main();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Fatal error: ${message}\n`);
    process.exit(1);
  }
})();
