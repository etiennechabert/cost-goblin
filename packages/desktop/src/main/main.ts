import { app, BrowserWindow, dialog, ipcMain, session } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { clockFromEnv, logger, parseFixedNow, parseJsonObject, isStringRecord, parseTelemetryPreferences, parseUpdatePreferences, sqlEscapeString } from '@costgoblin/core';
import { telemetry } from './telemetry/controller.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Worker bundles are built by `npm run build:worker` (esbuild) into out/worker/
// — sibling to out/main/ where this file lives. We resolve up one level then
// into out/worker/ to find them. The shared app instance and the MCP server's
// dedicated sandboxed instance are both spawned from this bundle.
const DUCKDB_WORKER_PATH = join(__dirname, '..', 'worker', 'duckdb-worker.cjs');
import type { LogEntry } from '@costgoblin/core';
import { createDuckDBClient } from './duckdb-client.js';
import type { DuckDBClient } from './duckdb-client.js';
import { resolveMemoryGB, resolveRollupConcurrency, resolveThreads } from './duckdb-tuning.js';
import { createSyncClient } from './sync-client.js';
import type { SyncClient } from './sync-client.js';
import { recordSyncLog } from './sync-log.js';
import { registerIpcHandlers } from './ipc.js';
import type { AppContext } from './handlers/context.js';
import { isMcpServerRunning, startMcpServer, stopMcpServer } from './mcp.js';
import { readMcpEnabledSync } from './mcp-prefs.js';
import { initAutoUpdater, checkForUpdates } from './update-manager.js';
import { DISABLE_UPDATE_CHECK_ENV, shouldCheckOnStartup } from './update-prefs.js';
import { registerUpdateHandlers } from './handlers/update.js';
import { validateProfileLabel } from './validators/path-validator.js';
import { resolveWorkspaceEnv } from './workspace-env.js';
import type { WorkspaceEnv } from './workspace-env.js';
import { migrateProviderLayoutSync } from './provider-layout-migration.js';
import { clearPreFocusData, findPreFocusProviders } from './cur-detection.js';
import { installPermissionHandlers, installWebContentsGuards, markTrustedRenderer } from './window-guards.js';
import { buildCsp, RENDERER_ARG_PREFIX } from './window-security.js';

// Dev mode: NODE_ENV=development or electron-vite serving the renderer — and
// never in a packaged build, where either variable in the user's environment
// would otherwise select the 'unsafe-inline' dev CSP and a remote renderer URL.
// Drives the log level (debug, unless COSTGOBLIN_LOG_LEVEL says otherwise),
// the CSP, and which renderer createWindow loads.
const isDev = !app.isPackaged && (
  process.env['NODE_ENV'] === 'development'
  || process.env['ELECTRON_RENDERER_URL'] !== undefined
);
const envLevel = process.env['COSTGOBLIN_LOG_LEVEL'];
if (envLevel === 'debug' || envLevel === 'info' || envLevel === 'warn' || envLevel === 'error') {
  logger.setLevel(envLevel);
} else if (isDev) {
  logger.setLevel('debug');
}

// COSTGOBLIN_NOW (e2e, the homepage screenshot script) pins "today" for every
// calendar window the IPC handlers compute: default query ranges, previews,
// baselines, retention. The preload pins the renderer's Date from the same
// variable with the same parser, so both processes see one date. Parsed once.
const appClock = clockFromEnv(process.env['COSTGOBLIN_NOW']);
const pinnedNowMs = parseFixedNow(process.env['COSTGOBLIN_NOW']);
if (pinnedNowMs !== null) logger.info(`COSTGOBLIN_NOW pins the app clock to ${new Date(pinnedNowMs).toISOString()}`);

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
  const csp = buildCsp(isDev);

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
function readPerformanceOverrides(stateDir: string): { memoryLimitGB: number | null; threads: number | null; rollupConcurrency: number | null } {
  try {
    const prefsFile = join(stateDir, 'ui-preferences.json');
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

async function createWindow(db: DuckDBClient, syncClient: SyncClient, rollupConcurrency: number, wsEnv: WorkspaceEnv): Promise<AppContext> {
  const appContext = registerIpcHandlers({
    db,
    syncClient,
    configPath: resolveConfigPath(wsEnv.configBase, 'costgoblin'),
    dimensionsPath: resolveConfigPath(wsEnv.configBase, 'dimensions'),
    orgTreePath: resolveConfigPath(wsEnv.configBase, 'org-tree'),
    viewsPath: resolveConfigPath(wsEnv.configBase, 'views'),
    costScopePath: resolveConfigPath(wsEnv.configBase, 'cost-scope'),
    dataDir: wsEnv.dataDir,
    stateDir: wsEnv.stateDir,
    workspaceEnv: wsEnv,
    duckdbWorkerPath: DUCKDB_WORKER_PATH,
    now: appClock,
  });

  // Apply the persisted rollup-build-parallelism override (perf:set updates it
  // live thereafter). The store is constructed at the default (2); this honours
  // a saved override before the first warmup builds anything. The value is read
  // once in main() alongside the memory/threads overrides and passed in.
  appContext.rollupStore.setBuildConcurrency(rollupConcurrency);

  const headless = process.env['COSTGOBLIN_HEADLESS'] === '1';

  // The one document this window may show. The preload receives it through
  // additionalArguments and withholds every bridge from any other document.
  const indexPath = join(__dirname, '..', 'renderer', 'index.html');
  const devRendererUrl = isDev ? process.env['ELECTRON_RENDERER_URL'] : undefined;
  const rendererArg = devRendererUrl ?? pathToFileURL(indexPath).href;

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
      additionalArguments: [`${RENDERER_ARG_PREFIX}${rendererArg}`],
    },
  });

  if (devRendererUrl === undefined) {
    await win.loadFile(indexPath);
  } else {
    await win.loadURL(devRendererUrl);
    // DevTools available via Cmd+Option+I when needed
  }
  // Trust what actually loaded; navigation and permission guards
  // (window-guards.ts, installed in main()) key off it from here on.
  markTrustedRenderer(win.webContents, devRendererUrl);

  logger.info('Window created');
  return appContext;
}

async function main(): Promise<void> {
  // Before anything can create a WebContents: web-contents-created fires
  // inside `new BrowserWindow`, and its guards must exist before the load.
  installWebContentsGuards();

  // Single-instance lock (packaged builds only): a second instance can switch to
  // a different workspace and then delete or rename the one THIS instance has
  // DuckDB handles and a sync worker pointed at — the first in-app destructive
  // directory operations (workspaces:delete/rename) assume one instance. Gated
  // on isPackaged so dev runs and the e2e suite (which launch multiple instances
  // sharing a userData dir) are unaffected. Focus the existing window instead.
  if (app.isPackaged) {
    if (!app.requestSingleInstanceLock()) {
      app.quit();
      return;
    }
    app.on('second-instance', () => {
      const [win] = BrowserWindow.getAllWindows();
      if (win !== undefined) {
        if (win.isMinimized()) win.restore();
        win.focus();
      }
    });
  }

  // Redirect the whole userData tree first (e2e/workspace-mode tests) — must
  // precede every app.getPath('userData') read, including the MCP token path.
  const userDataOverride = process.env['COSTGOBLIN_USER_DATA_DIR'];
  if (typeof userDataOverride === 'string' && userDataOverride.length > 0) {
    app.setPath('userData', userDataOverride);
  }
  // Resolve the active workspace (or pinned env-override paths) once —
  // everything downstream (telemetry, DuckDB temp, the IPC context) consumes
  // this single resolution. Runs migration of a pre-workspace layout on first
  // launch after upgrade.
  const wsEnv = resolveWorkspaceEnv(app.getPath('userData'), process.env);

  // Telemetry is set up BEFORE app.whenReady(): @sentry/electron can only arm the
  // native crash handler before the 'ready' event, so the opt-in is decided here
  // from the saved preference. Toggling the channel in Settings saves the choice
  // and restarts the app to re-arm with the new state.
  telemetry.initialize(wsEnv.stateDir);
  // One read of the workspace's ui-preferences.json feeds the launch-time
  // telemetry and update-check decisions. Each slice parser fails to its own
  // default: telemetry stays dark, the update check stays on.
  let launchPrefs: Readonly<Record<string, unknown>> | null = null;
  try {
    launchPrefs = parseJsonObject(readFileSync(join(wsEnv.stateDir, 'ui-preferences.json'), 'utf-8'));
  } catch {
    /* no or invalid prefs file → every slice takes its default */
  }
  const telemetryPrefs = parseTelemetryPreferences(launchPrefs?.['telemetry']);
  const updatePrefs = parseUpdatePreferences(launchPrefs?.['updates']);
  // Synchronous + before whenReady: Sentry must init before `ready` to arm
  // native crash capture, so this must not yield to the event loop first.
  telemetry.start(telemetryPrefs);

  await app.whenReady();

  // Migrate a pre-#516 data layout ({dataDir}/aws + root sidecars) to the
  // provider-keyed one. MUST run before the DuckDB and sync workers start so
  // no open handles can break the renames (Windows EPERM — same constraint
  // as the workspace migration above).
  try {
    migrateProviderLayoutSync(wsEnv.dataDir, resolveConfigPath(wsEnv.configBase, 'costgoblin'));
  } catch (err: unknown) {
    logger.warn(`provider-layout migration failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const db = await createDuckDBClient(DUCKDB_WORKER_PATH);
  const tempDir = wsEnv.tempDir;
  mkdirSync(tempDir, { recursive: true });
  const perf = readPerformanceOverrides(wsEnv.stateDir);
  db.configure({
    tempDir,
    memoryGB: resolveMemoryGB(perf.memoryLimitGB),
    threads: resolveThreads(perf.threads),
  });

  logger.info('DuckDB worker ready');

  // Upgrade guard: a v0.6.x install has AWS CUR 2.0 parquet in raw/, which the
  // FOCUS 1.2 query layer can't read (every dashboard would binder-error and
  // the CUR bucket syncs nothing). Detect it before opening the window and,
  // on the user's confirm, wipe the old data + config so the app restarts into
  // the setup wizard pointed at a FOCUS 1.2 export. No-op on a FOCUS install or
  // a fresh one, so the common path pays only one schema-only DESCRIBE.
  try {
    const preFocusProviders = await findPreFocusProviders(wsEnv.dataDir, async (glob) => {
      const rows = await db.runQuery(`DESCRIBE SELECT * FROM read_parquet('${sqlEscapeString(glob)}')`);
      return rows.map(r => String(r['column_name']));
    });
    if (preFocusProviders.length > 0) {
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        title: 'CostGoblin now reads FOCUS 1.2',
        message: 'Your local data is in the old AWS CUR 2.0 format',
        detail:
          'CostGoblin 0.7 reads the FOCUS 1.2 billing schema. Your existing local data '
          + '(and your current CUR 2.0 export) can no longer be read.\n\n'
          + 'Clearing it and restarting setup lets you point CostGoblin at a FOCUS 1.2 '
          + 'Data Export. In the AWS console: Billing and Cost Management → Data Exports → '
          + 'Create export → FOCUS 1.2, as Parquet.',
        buttons: ['Clear data and restart setup', 'Quit'],
        defaultId: 0,
        cancelId: 1,
      });
      if (response !== 0) {
        app.quit();
        return;
      }
      await clearPreFocusData(wsEnv.dataDir, resolveConfigPath(wsEnv.configBase, 'costgoblin'), preFocusProviders);
      logger.info(`Cleared pre-FOCUS (CUR 2.0) data for ${String(preFocusProviders.length)} provider(s); restarting setup`);
    }
  } catch (err: unknown) {
    // A detection failure must never block launch — fall through to the normal
    // boot (the user hits the same binder errors, but the app still opens).
    logger.warn(`pre-FOCUS data check failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const syncWorkerPath = join(__dirname, '..', 'worker', 'sync-worker.cjs');
  const syncClient = await createSyncClient(syncWorkerPath, recordSyncLog);
  logger.info('Sync worker ready');

  installCSP();
  installPermissionHandlers();
  if (app.isPackaged) {
    try {
      // Always wired up in a release build, so a manual "Check for updates"
      // works even when the launch-time check is off.
      initAutoUpdater();
      if (shouldCheckOnStartup({ isPackaged: app.isPackaged, prefs: updatePrefs, env: process.env })) {
        checkForUpdates().catch(() => undefined);
      } else {
        logger.info(`Startup update check skipped (Settings → General, or ${DISABLE_UPDATE_CHECK_ENV}=1); manual checks still work`);
      }
    } catch {
      logger.warn('Auto-updater unavailable');
    }
  }
  registerUpdateHandlers(wsEnv.stateDir);

  const startupRollupConcurrency = resolveRollupConcurrency(perf.rollupConcurrency);
  const appContext = await createWindow(db, syncClient, startupRollupConcurrency, wsEnv);

  // The MCP server is opt-in (Settings → AI Assistant), so nothing listens on
  // its port unless this workspace saved `mcp.enabled: true`. This is the only
  // launch-time start; the Enable/Disable IPC handler covers the rest.
  if (readMcpEnabledSync(join(wsEnv.stateDir, 'ui-preferences.json')) && !isMcpServerRunning()) {
    startMcpServer(appContext).catch((err: unknown) => {
      logger.warn(`mcp: failed to start — ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(db, syncClient, startupRollupConcurrency, wsEnv).catch(() => undefined);
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
    // A GUI launch discards stderr, so a boot failure (e.g. the legacy-layout
    // migration hitting Windows EPERM while an antivirus/indexer holds a file)
    // otherwise looked like the app silently not starting. showErrorBox is safe
    // before 'ready' and gives the user the actual reason. Best-effort: if even
    // the dialog fails, still exit non-zero.
    try {
      dialog.showErrorBox(
        'CostGoblin could not start',
        `${message}\n\nIf this persists after a restart, the app's data folder may be locked by `
        + 'another program (antivirus, backup, or file indexer). Close it and try again.',
      );
    } catch { /* headless / no display — stderr above is the fallback */ }
    process.exit(1);
  }
}
void bootstrap();
