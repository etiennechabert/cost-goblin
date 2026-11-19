import { AsyncLocalStorage } from 'node:async_hooks';
import { vi, type Mock } from 'vitest';
import type {
  MessageBoxOptions,
  MessageBoxReturnValue,
  OpenDialogOptions,
  OpenDialogReturnValue,
  RelaunchOptions,
  SaveDialogOptions,
  SaveDialogReturnValue,
} from 'electron';

/**
 * Stand-ins for the slice of `electron` (and `@sentry/electron/main`) the main
 * process's IPC handlers touch, so a node-project test can register a
 * handler module and invoke its channels directly.
 *
 * Wire them up from the test file — `vi.mock` is hoisted above the imports,
 * and the async factory loads this module through the same module graph, so
 * the test and the handlers share one registry:
 *
 *   vi.mock('electron', async () => (await import('./helpers/electron-fake.js')).fakeElectronModule);
 *   vi.mock('@sentry/electron/main', async () => (await import('./helpers/electron-fake.js')).fakeSentryModule);
 *
 * This module must stay free of production imports: the handlers import
 * `electron` while the test file is still loading, and a production import
 * here would re-enter that chain half-initialised.
 */

type IpcListener = (event: unknown, ...args: unknown[]) => unknown;

/** What a handler receives as its `IpcMainInvokeEvent`. None of the handlers
 *  under test read it, so it carries only the identifying fields. */
export const FAKE_INVOKE_EVENT = Object.freeze({ sender: null, frameId: 0, processId: 0 });

/** One app's channel registry. Handler modules register synchronously, so
 *  making a scope current, then calling `register…Handlers(app)`, files that
 *  app's channels here — two apps (a sharing publisher and its consumer) can
 *  live side by side in one test. Mirrors Electron's refusal of a second
 *  handler for one channel, so a double registration fails loudly. */
export class IpcScope {
  private readonly listeners = new Map<string, IpcListener>();

  handle(channel: string, listener: IpcListener): void {
    if (this.listeners.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`);
    this.listeners.set(channel, listener);
  }

  removeHandler(channel: string): void {
    this.listeners.delete(channel);
  }

  /** Call a channel the way `ipcRenderer.invoke` would: resolve to the
   *  handler's (awaited) return value, or reject with what it threw. */
  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const listener = this.listeners.get(channel);
    if (listener === undefined) throw new Error(`No IPC handler registered for '${channel}'`);
    return await listener(FAKE_INVOKE_EVENT, ...args);
  }

  channels(): string[] {
    return [...this.listeners.keys()].sort((a, b) => a.localeCompare(b));
  }
}

let currentScope = new IpcScope();

/** The `ipcMain` the handlers register on — routed to the current scope. */
export const ipcMain = {
  handle(channel: string, listener: IpcListener): void {
    currentScope.handle(channel, listener);
  },
  removeHandler(channel: string): void {
    currentScope.removeHandler(channel);
  },
};

/** Start a fresh registry and make it current; later registrations land in it. */
export function newIpcScope(): IpcScope {
  currentScope = new IpcScope();
  return currentScope;
}

/** `invoke` on the current scope. */
export function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  return currentScope.invoke(channel, ...args);
}

export const dialog = {
  showSaveDialog: vi.fn<(options: SaveDialogOptions) => Promise<SaveDialogReturnValue>>(
    () => Promise.resolve({ canceled: true, filePath: '' }),
  ),
  showOpenDialog: vi.fn<(options: OpenDialogOptions) => Promise<OpenDialogReturnValue>>(
    () => Promise.resolve({ canceled: true, filePaths: [] }),
  ),
  showMessageBox: vi.fn<(options: MessageBoxOptions) => Promise<MessageBoxReturnValue>>(
    () => Promise.resolve({ response: 1, checkboxChecked: false }),
  ),
};

export const shell = {
  openPath: vi.fn<(path: string) => Promise<string>>(() => Promise.resolve('')),
  openExternal: vi.fn<(url: string) => Promise<void>>(() => Promise.resolve()),
  showItemInFolder: vi.fn<(fullPath: string) => void>(),
};

/** Mutable flags behind the fake `app`'s getters. */
export const electronAppState = { isPackaged: false, version: '9.9.9-test', appPath: process.cwd() };

export const app = {
  get isPackaged(): boolean { return electronAppState.isPackaged; },
  getVersion: (): string => electronAppState.version,
  getAppPath: (): string => electronAppState.appPath,
  relaunch: vi.fn<(options?: RelaunchOptions) => void>(),
  quit: vi.fn<() => void>(),
  /** The app's child processes, as far as the handlers read them: none
   *  unless a test names some. Memory is in KB, as Electron reports it. */
  getAppMetrics: vi.fn<() => readonly FakeProcessMetric[]>(() => []),
};

/** One entry of `app.getAppMetrics()`. */
export interface FakeProcessMetric {
  readonly name?: string;
  readonly memory: { readonly workingSetSize: number };
}

/** A renderer window as the broadcast helpers see it: only `webContents.send`. */
export interface FakeWindow {
  readonly webContents: { readonly send: Mock<(channel: string, ...args: unknown[]) => void> };
}

const openWindows: FakeWindow[] = [];

/** Open a fake window that main-process broadcasts will reach. */
export function openFakeWindow(): FakeWindow {
  const win: FakeWindow = { webContents: { send: vi.fn<(channel: string, ...args: unknown[]) => void>() } };
  openWindows.push(win);
  return win;
}

export const BrowserWindow = {
  getAllWindows: (): readonly FakeWindow[] => [...openWindows],
};

/** Reset every fake's calls and queued behaviour, and the `app` flags. */
export function resetElectronFakes(): void {
  openWindows.length = 0;
  dialog.showSaveDialog.mockReset();
  dialog.showOpenDialog.mockReset();
  dialog.showMessageBox.mockReset();
  shell.openPath.mockReset();
  shell.openExternal.mockReset();
  shell.showItemInFolder.mockReset();
  app.relaunch.mockReset();
  app.quit.mockReset();
  app.getAppMetrics.mockReset();
  electronAppState.isPackaged = false;
  electronAppState.version = '9.9.9-test';
  electronAppState.appPath = process.cwd();
}

export const fakeElectronModule = { ipcMain, dialog, shell, app, BrowserWindow };

/** A span the fake Sentry SDK started. */
export interface FakeSpan {
  readonly name: string;
  readonly op: string | undefined;
  /** The span that was active where this one started. `null`: it started as
   *  a root span, which Sentry sends as a transaction of its own. */
  readonly parent: FakeSpan | null;
  /** Those it started with, then those set on it. */
  readonly attributes: Record<string, unknown>;
  setAttribute(key: string, value: unknown): FakeSpan;
}

/** What the fake reads of the `startSpan` options. */
interface FakeSpanOptions {
  readonly name: string;
  readonly op?: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

function fakeSpan(options: FakeSpanOptions, parent: FakeSpan | null): FakeSpan {
  const span: FakeSpan = {
    name: options.name,
    op: options.op,
    parent,
    attributes: { ...options.attributes },
    setAttribute(key, value) { span.attributes[key] = value; return span; },
  };
  return span;
}

/** Stands for whatever span the real SDK may have active where the code runs
 *  (an instrumented request, a caller's own span): a span the code starts
 *  nests under it unless the code clears the active span first. */
export const AMBIENT_SPAN = fakeSpan({ name: 'ambient' }, null);

/** The active span follows the async flow, as the SDK's OpenTelemetry context
 *  does: a span started after an `await` inside another span's callback is
 *  still its child. `undefined` (outside any `run`) reads as the ambient span. */
const activeSpan = new AsyncLocalStorage<FakeSpan | null>();

/** Every span started while tracing was armed, in start order. */
export const startedSpans: FakeSpan[] = [];

/** `@sentry/electron/main` cannot load outside Electron (it imports `app`
 *  from the real package), and the handlers reach it through the tracing
 *  helper. The span helpers only reach the SDK once a test arms tracing
 *  (`telemetry.isTracingActive`); the lifecycle calls are inert. */
export const fakeSentryModule = {
  startSpan: <T>(options: FakeSpanOptions, fn: (span: FakeSpan) => T): T => {
    const store = activeSpan.getStore();
    const span = fakeSpan(options, store === undefined ? AMBIENT_SPAN : store);
    startedSpans.push(span);
    return activeSpan.run(span, () => fn(span));
  },
  withActiveSpan: <T>(span: FakeSpan | null, fn: () => T): T => activeSpan.run(span, fn),
  init: vi.fn<(options: unknown) => void>(),
  flush: vi.fn<(timeout?: number) => Promise<boolean>>(() => Promise.resolve(true)),
  close: vi.fn<(timeout?: number) => Promise<boolean>>(() => Promise.resolve(true)),
};
