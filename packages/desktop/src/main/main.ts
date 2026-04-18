import { app, BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import { logger } from '@costgoblin/core';
import type { LogEntry } from '@costgoblin/core';
import { createDuckDB } from './duckdb-loader.js';
import type { DuckDBInstance } from './duckdb-loader.js';
import { registerIpcHandlers } from './ipc.js';

logger.addHandler((entry: LogEntry) => {
  const line = `[${entry.timestamp}] ${entry.level.toUpperCase()} ${entry.message}\n`;
  process.stdout.write(line);
});

function resolveConfigPath(base: string, name: string): string {
  const envKey = `COSTGOBLIN_${name.toUpperCase()}_PATH`;
  const env = process.env[envKey];
  return typeof env === 'string' && env.length > 0 ? env : join(base, `${name}.yaml`);
}

async function createWindow(db: DuckDBInstance): Promise<void> {
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
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  logger.info('Window created');
}

async function main(): Promise<void> {
  await app.whenReady();

  const db = await createDuckDB();
  logger.info('DuckDB initialized');

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
