import { app, BrowserWindow, ipcMain, session, shell } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger, loadConfig } from '@costgoblin/core';
import type { LogEntry, AnalyticsEventType } from '@costgoblin/core';
import { createDuckDBClient } from './duckdb-client.js';
import type { DuckDBClient } from './duckdb-client.js';
import { createSyncClient } from './sync-client.js';
import type { SyncClient } from './sync-client.js';
import { registerIpcHandlers } from './ipc.js';
import { validateUrl, SecurityError } from './url-validator.js';
import { validateProfileLabel } from './validators/path-validator.js';
import { createSentryClient } from './telemetry/sentry-client.js';
import type { SentryClient } from './telemetry/sentry-client.js';
import { createPostHogClient } from './telemetry/posthog-client.js';
import type { PostHogClient } from './telemetry/posthog-client.js';
import { createAuditLogWriter } from './telemetry/audit-log.js';
import type { AuditLogWriter } from './telemetry/audit-log.js';

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
// Telemetry clients (PostHog, Sentry, audit log) — initialized after config load
// ---------------------------------------------------------------------------
let telemetryClients: {
  posthog: PostHogClient | null;
  sentry: SentryClient | null;
  auditLog: AuditLogWriter | null;
} = {
  posthog: null,
  sentry: null,
  auditLog: null,
};

/**
 * Initialize telemetry clients based on config.
 * All telemetry is opt-in and defaulted off. Clients are only created if
 * their respective channels are enabled in costgoblin.yaml.
 */
async function initializeTelemetry(configPath: string, userDataPath: string): Promise<void> {
  try {
    const config = await loadConfig(configPath);
    const telemetryConfig = config.telemetry;

    // Skip if no telemetry config
    if (telemetryConfig === undefined) {
      logger.debug('telemetry:init-skipped', { reason: 'no telemetry config' });
      return;
    }

    // Create audit log writer for local event inspection
    const auditLogPath = join(userDataPath, 'telemetry-audit.jsonl');
    const auditLog = createAuditLogWriter(auditLogPath);
    telemetryClients.auditLog = auditLog;

    // Initialize PostHog client for analytics
    const analyticsConfig = telemetryConfig.analytics;
    const posthogApiKey = process.env['POSTHOG_API_KEY'];
    if (typeof posthogApiKey === 'string' && posthogApiKey.length > 0) {
      const posthog = createPostHogClient(
        analyticsConfig,
        posthogApiKey,
        (eventType, sanitizedProperties) => {
          void auditLog.write('analytics', eventType, sanitizedProperties);
        },
      );
      telemetryClients.posthog = posthog;
      logger.info('telemetry:posthog-initialized', { enabled: analyticsConfig.enabled });
    }

    // Initialize Sentry client for crash reporting and performance monitoring
    const crashConfig = telemetryConfig.crashReporting;
    const performanceConfig = telemetryConfig.performance;
    const sentryDsn = process.env['SENTRY_DSN'];
    if (typeof sentryDsn === 'string' && sentryDsn.length > 0) {
      const sentry = createSentryClient(
        crashConfig,
        performanceConfig,
        sentryDsn,
        app.getVersion(),
        isDev ? 'development' : 'production',
        (eventType, sanitizedEvent) => {
          void auditLog.write('crashReporting', eventType, sanitizedEvent);
        },
      );
      telemetryClients.sentry = sentry;
      logger.info('telemetry:sentry-initialized', {
        crashReporting: crashConfig.enabled,
        performance: performanceConfig.enabled,
      });
    }

    logger.debug('telemetry:init-complete', { auditLogPath });
  } catch (error) {
    // Log errors but don't throw - telemetry failures should not break the app
    logger.error('telemetry:init-error', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Install global error handlers to send unhandled errors to Sentry if enabled.
 * Errors are sanitized via Sentry's beforeSend hook before transmission.
 */
function installGlobalErrorHandlers(): void {
  process.on('uncaughtException', (error: Error) => {
    logger.error('uncaught-exception', {
      error: error.message,
      stack: error.stack,
    });

    // Send to Sentry if crash reporting is enabled
    if (telemetryClients.sentry !== null) {
      telemetryClients.sentry.captureError(error, 'error', {
        errorType: 'uncaughtException',
      });
    }

    // Exit gracefully after logging
    process.exit(1);
  });

  process.on('unhandledRejection', (reason: unknown) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    logger.error('unhandled-rejection', {
      error: error.message,
      stack: error.stack,
    });

    // Send to Sentry if crash reporting is enabled
    if (telemetryClients.sentry !== null) {
      telemetryClients.sentry.captureError(error, 'error', {
        errorType: 'unhandledRejection',
      });
    }
  });

  logger.debug('telemetry:global-error-handlers-installed');
}

/**
 * Register telemetry IPC handler for tracking events.
 * This handler is registered separately from the config handlers because it
 * needs access to the PostHog client initialized in main.ts.
 */
function registerTelemetryTrackHandler(): void {
  ipcMain.handle(
    'telemetry:track-event',
    async (
      _event,
      eventType: AnalyticsEventType,
      properties?: Readonly<Record<string, unknown>>,
    ): Promise<void> => {
      // Track event with PostHog if analytics telemetry is enabled
      if (telemetryClients.posthog !== null) {
        await telemetryClients.posthog.track(eventType, properties ?? {});
      } else {
        logger.debug('telemetry:track-event-skipped', {
          eventType,
          reason: 'PostHog client not initialized',
        });
      }
    },
  );

  logger.debug('telemetry:track-handler-registered');
}

/**
 * Register telemetry IPC handler for capturing errors from renderer process.
 * This handler is registered separately because it needs access to the Sentry
 * client initialized in main.ts.
 */
function registerTelemetryCaptureErrorHandler(): void {
  ipcMain.handle(
    'telemetry:capture-error',
    (
      _event,
      error: { message: string; stack?: string },
      context?: Readonly<Record<string, unknown>>,
    ): Promise<void> => {
      // Send to Sentry if crash reporting is enabled
      if (telemetryClients.sentry !== null) {
        // Reconstruct Error object from serialized error
        const errorObj = new Error(error.message);
        if (error.stack !== undefined) {
          errorObj.stack = error.stack;
        }

        telemetryClients.sentry.captureError(errorObj, 'error', {
          errorType: 'react-error-boundary',
          ...context,
        });
      } else {
        logger.debug('telemetry:capture-error-skipped', {
          message: error.message,
          reason: 'Sentry client not initialized',
        });
      }
      return Promise.resolve();
    },
  );

  logger.debug('telemetry:capture-error-handler-registered');
}

/**
 * Cleanup telemetry clients on app quit.
 * Flush pending events and close connections.
 */
async function shutdownTelemetry(): Promise<void> {
  try {
    if (telemetryClients.posthog !== null) {
      await telemetryClients.posthog.shutdown();
      logger.debug('telemetry:posthog-shutdown');
    }

    if (telemetryClients.sentry !== null) {
      await telemetryClients.sentry.close();
      logger.debug('telemetry:sentry-shutdown');
    }

    telemetryClients = { posthog: null, sentry: null, auditLog: null };
  } catch (error) {
    // Log errors but don't throw - telemetry failures should not break shutdown
    logger.error('telemetry:shutdown-error', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

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

  const userDataPath = app.getPath('userData');
  const configBase = process.env['COSTGOBLIN_CONFIG_DIR'] ?? join(userDataPath, 'config');
  const configPath = resolveConfigPath(configBase, 'costgoblin');

  // Install global error handlers before anything else
  installGlobalErrorHandlers();

  // Initialize telemetry clients based on config
  await initializeTelemetry(configPath, userDataPath);

  // Register telemetry track handler (must be after initializeTelemetry)
  registerTelemetryTrackHandler();
  registerTelemetryCaptureErrorHandler();

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

app.on('will-quit', (event) => {
  event.preventDefault();
  void shutdownTelemetry().then(() => {
    app.exit(0);
  });
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
