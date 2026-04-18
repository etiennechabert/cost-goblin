import { app, BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import { logger } from '@costgoblin/core';
import type { LogEntry } from '@costgoblin/core';
import { createDuckDBClient } from './duckdb-client.js';
import type { DuckDBClient } from './duckdb-client.js';
import { registerIpcHandlers } from './ipc.js';

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

function resolveConfigPath(base: string, name: string): string {
  const envKey = `COSTGOBLIN_${name.toUpperCase()}_PATH`;
  const env = process.env[envKey];
  return typeof env === 'string' && env.length > 0 ? env : join(base, `${name}.yaml`);
}

async function createWindow(db: DuckDBClient): Promise<void> {
  const userDataPath = app.getPath('userData');
  const dataDir = process.env['COSTGOBLIN_DATA_DIR'] ?? join(userDataPath, 'data');
  const configBase = process.env['COSTGOBLIN_CONFIG_DIR'] ?? join(userDataPath, 'config');

  registerIpcHandlers({
    db,
    configPath: resolveConfigPath(configBase, 'costgoblin'),
    dimensionsPath: resolveConfigPath(configBase, 'dimensions'),
    orgTreePath: resolveConfigPath(configBase, 'org-tree'),
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
      preload: join(__dirname, '..', 'preload', 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox: true is the v1 target but breaks ESM preloads (electron-vite
      // emits .mjs and the sandboxed loader is CJS-only). contextIsolation +
      // nodeIntegration: false already prevent the main attack vectors;
      // sandboxing remains a future hardening task.
      sandbox: false,
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
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  logger.info('Window created');
}

async function main(): Promise<void> {
  await app.whenReady();

  // Worker bundle is built by `npm run build:worker` (esbuild) into out/worker/
  // — sibling to out/main/ where this file lives. We resolve up one level then
  // into out/worker/ to find it.
  const workerPath = join(__dirname, '..', 'worker', 'duckdb-worker.cjs');
  const db = await createDuckDBClient(workerPath);
  logger.info('DuckDB worker ready');

  await createWindow(db);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow(db);
    }
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Fatal error: ${message}\n`);
  process.exit(1);
});
