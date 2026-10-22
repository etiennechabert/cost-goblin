import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ElectronMainOptions, ErrorEvent } from '@sentry/electron/main';
import { TELEMETRY_DEFAULTS } from '@costgoblin/core';
import type { TelemetryPreferences } from '@costgoblin/core';

/** The opt-in Sentry lifecycle in the main process, against a stubbed SDK and
 *  Electron `app`: when it inits (and with what), what each channel gate lets
 *  through, and how a mid-session opt-out stops the SDK. */

const fake = vi.hoisted(() => {
  const devTags: Record<string, string> = {};
  return {
    isPackaged: false,
    devTags,
    init: vi.fn<(options: ElectronMainOptions) => void>(),
    flush: vi.fn<(timeout: number) => Promise<boolean>>(),
    close: vi.fn<(timeout: number) => Promise<boolean>>(),
    readDevTagsSync: vi.fn<(isPackaged: boolean, repoDir: string) => Record<string, string>>(),
  };
});

vi.mock('electron', () => ({
  app: {
    get isPackaged(): boolean { return fake.isPackaged; },
    getAppPath: (): string => '/apps/costgoblin',
    getVersion: (): string => '1.2.3',
  },
}));

vi.mock('@sentry/electron/main', () => ({ init: fake.init, flush: fake.flush, close: fake.close }));

vi.mock('../main/telemetry/dev-tags.js', () => ({ readDevTagsSync: fake.readDevTagsSync }));

type TransactionEvent = Parameters<NonNullable<ElectronMainOptions['beforeSendTransaction']>>[0];
type IntegrationsFn = Extract<NonNullable<ElectronMainOptions['integrations']>, (defaults: never) => unknown>;
type Integration = Parameters<IntegrationsFn>[0][number];

const DSN = 'https://public@sentry.example.test/42';
const OFF: TelemetryPreferences = TELEMETRY_DEFAULTS;
const ERRORS_ONLY: TelemetryPreferences = { ...OFF, errorReports: true };
const EVERYTHING: TelemetryPreferences = { errorReports: true, nativeCrashReports: true, performance: true, analytics: false };
/** Every Sentry 11 data-collection category off; frameContextLines at its default. */
const COLLECT_NOTHING = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
  frameContextLines: 5,
};

async function loadController(): Promise<typeof import('../main/telemetry/controller.js')['telemetry']> {
  vi.resetModules();
  return (await import('../main/telemetry/controller.js')).telemetry;
}

/** The options of the one Sentry.init call this test made. */
function initOptions(): ElectronMainOptions {
  expect(fake.init).toHaveBeenCalledTimes(1);
  const options = fake.init.mock.calls[0]?.[0];
  if (options === undefined) throw new Error('Sentry.init was not called');
  return options;
}

async function sendError(options: ElectronMainOptions, event: ErrorEvent): Promise<ErrorEvent | null> {
  if (options.beforeSend === undefined) throw new Error('no beforeSend hook');
  return options.beforeSend(event, {});
}

/** The transaction hook the controller keeps under the static trace lifecycle.
 *  Sentry 11 deprecates the option because span streaming ignores it; the
 *  controller opts out of streaming, so the hook is read through this shape. */
interface StaticTraceHooks {
  readonly beforeSendTransaction?: ElectronMainOptions['beforeSendTransaction'];
}

async function sendTransaction(options: StaticTraceHooks, event: TransactionEvent): Promise<TransactionEvent | null> {
  if (options.beforeSendTransaction === undefined) throw new Error('no beforeSendTransaction hook');
  return options.beforeSendTransaction(event, {});
}

function integrationNames(options: ElectronMainOptions, defaults: Integration[]): string[] {
  const { integrations } = options;
  if (typeof integrations !== 'function') throw new Error('expected an integrations callback');
  return integrations(defaults).map(i => i.name);
}

let outboxDir = '';

beforeEach(async () => {
  fake.isPackaged = false;
  for (const key of Object.keys(fake.devTags)) Reflect.deleteProperty(fake.devTags, key);
  fake.init.mockReset();
  fake.flush.mockReset();
  fake.flush.mockResolvedValue(true);
  fake.close.mockReset();
  fake.close.mockResolvedValue(true);
  fake.readDevTagsSync.mockReset();
  fake.readDevTagsSync.mockImplementation(() => ({ ...fake.devTags }));
  vi.stubEnv('COSTGOBLIN_SENTRY_DSN', '');
  vi.stubEnv('COSTGOBLIN_SENTRY_TUNNEL', '');
  vi.stubEnv('MAIN_VITE_SENTRY_DSN', '');
  outboxDir = await mkdtemp(join(tmpdir(), 'cg-telemetry-'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(outboxDir, { recursive: true, force: true });
});

describe('telemetry status', () => {
  it('stays dark with no DSN configured, whatever the user opted into', async () => {
    const telemetry = await loadController();

    telemetry.start(EVERYTHING);

    expect(fake.init).not.toHaveBeenCalled();
    expect(telemetry.getStatus()).toEqual({
      dsnConfigured: false,
      active: false,
      preferences: EVERYTHING,
      armed: OFF,
      tracesSampleRate: 1,
    });
    expect(telemetry.isTracingActive()).toBe(false);
  });

  it('reads the DSN baked in at build time when no runtime DSN is set', async () => {
    vi.stubEnv('MAIN_VITE_SENTRY_DSN', DSN);
    const telemetry = await loadController();

    expect(telemetry.getStatus().dsnConfigured).toBe(true);
    telemetry.start(ERRORS_ONLY);
    expect(initOptions().dsn).toBe(DSN);
  });

  it('prefers the runtime DSN over the baked one', async () => {
    vi.stubEnv('MAIN_VITE_SENTRY_DSN', 'https://baked@sentry.example.test/1');
    vi.stubEnv('COSTGOBLIN_SENTRY_DSN', DSN);
    const telemetry = await loadController();

    telemetry.start(ERRORS_ONLY);

    expect(initOptions().dsn).toBe(DSN);
  });

  it('samples a fraction of traces in a packaged release', async () => {
    fake.isPackaged = true;
    const telemetry = await loadController();

    expect(telemetry.getStatus().tracesSampleRate).toBe(0.1);
  });
});

describe('telemetry start', () => {
  beforeEach(() => {
    vi.stubEnv('COSTGOBLIN_SENTRY_DSN', DSN);
  });

  it('does not init the SDK while every channel is off', async () => {
    const telemetry = await loadController();

    telemetry.start(OFF);

    expect(fake.init).not.toHaveBeenCalled();
    expect(telemetry.getStatus().active).toBe(false);
  });

  it('inits a dev build for scrubbed error reports only, tagged with its branch and commit', async () => {
    fake.devTags['branch'] = 'feature/x';
    fake.devTags['commit'] = 'abc1234';
    const telemetry = await loadController();

    telemetry.start(ERRORS_ONLY);

    const options = initOptions();
    expect(fake.readDevTagsSync).toHaveBeenCalledWith(false, '/apps/costgoblin');
    expect(options.dsn).toBe(DSN);
    expect(options.environment).toBe('development');
    expect(options.release).toBe('costgoblin@1.2.3');
    expect(options.initialScope).toEqual({ tags: { branch: 'feature/x', commit: 'abc1234' } });
    // Never let the SDK collect user info, headers, cookies, bodies or local
    // variables on its own (Sentry 11 defaults every category on), and keep
    // traces as transactions, which beforeSendTransaction gates and scrubs.
    expect(options).toMatchObject({ dataCollection: COLLECT_NOTHING, traceLifecycle: 'static', tracesSampleRate: 0 });
    expect('tunnel' in options).toBe(false);
    expect(telemetry.getStatus()).toMatchObject({
      dsnConfigured: true,
      active: true,
      armed: { errorReports: true, nativeCrashReports: false, performance: false, analytics: false },
    });
    expect(telemetry.isTracingActive()).toBe(false);
  });

  it('ignores exactly the query-cancelled control-flow error, not errors that merely mention it', async () => {
    const telemetry = await loadController();
    telemetry.start(ERRORS_ONLY);

    const patterns = initOptions().ignoreErrors ?? [];
    const ignored = (message: string): boolean => patterns.some(p => (typeof p === 'string' ? p === message : p.test(message)));
    expect(ignored('Query cancelled')).toBe(true);
    expect(ignored('Query cancelled while loading the explorer')).toBe(false);
    expect(ignored('Something else failed')).toBe(false);
  });

  it('inits a packaged release untagged, tracing at the production rate, through a self-hosted tunnel', async () => {
    fake.isPackaged = true;
    vi.stubEnv('COSTGOBLIN_SENTRY_TUNNEL', 'https://relay.example.test/tunnel');
    const telemetry = await loadController();

    telemetry.start(EVERYTHING);

    const options = initOptions();
    expect(options.environment).toBe('production');
    expect(options.tunnel).toBe('https://relay.example.test/tunnel');
    expect(options.tracesSampleRate).toBe(0.1);
    expect('initialScope' in options).toBe(false);
    expect(telemetry.getStatus().armed).toEqual(EVERYTHING);
    expect(telemetry.isTracingActive()).toBe(true);
  });

  it('drops the native crash handler unless the native channel is on', async () => {
    const defaults: Integration[] = [{ name: 'SentryMinidump' }, { name: 'OnUncaughtException' }];

    const errorsOnly = await loadController();
    errorsOnly.start(ERRORS_ONLY);
    expect(integrationNames(initOptions(), defaults)).toEqual(['OnUncaughtException']);

    fake.init.mockReset();
    const native = await loadController();
    native.start({ ...OFF, nativeCrashReports: true });
    expect(integrationNames(initOptions(), defaults)).toEqual(['SentryMinidump', 'OnUncaughtException']);
  });

  it('stays inactive when the SDK fails to initialise', async () => {
    fake.init.mockImplementationOnce(() => { throw new Error('bad DSN'); });
    const first = await loadController();
    first.start(ERRORS_ONLY);
    expect(first.getStatus().active).toBe(false);

    const notAnError: unknown = 'native module missing';
    fake.init.mockImplementationOnce(() => { throw notAnError; });
    const second = await loadController();
    second.start(ERRORS_ONLY);
    expect(second.getStatus().active).toBe(false);
    expect(second.getStatus().armed).toEqual(OFF);
  });
});

describe('telemetry preference changes', () => {
  beforeEach(() => {
    vi.stubEnv('COSTGOBLIN_SENTRY_DSN', DSN);
  });

  it('stops the running SDK at once when the user opts out', async () => {
    const telemetry = await loadController();
    telemetry.start(EVERYTHING);

    await telemetry.applyPreferences(OFF);

    expect(fake.flush).toHaveBeenCalledWith(2000);
    expect(fake.close).toHaveBeenCalledWith(2000);
    expect(telemetry.getStatus()).toMatchObject({ active: false, preferences: OFF, armed: OFF });
    expect(telemetry.isTracingActive()).toBe(false);

    // Already stopped: a second opt-out has nothing left to shut down.
    await telemetry.applyPreferences(OFF);
    expect(fake.flush).toHaveBeenCalledTimes(1);
  });

  it('keeps the SDK running for a change that leaves a channel on, arming only what booted', async () => {
    const telemetry = await loadController();
    telemetry.start(ERRORS_ONLY);

    await telemetry.applyPreferences(EVERYTHING);

    expect(fake.flush).not.toHaveBeenCalled();
    // Native capture and tracing only arm at boot: wanted now, live after a restart.
    expect(telemetry.getStatus()).toMatchObject({
      active: true,
      preferences: EVERYTHING,
      armed: { errorReports: true, nativeCrashReports: false, performance: false, analytics: false },
    });
    expect(telemetry.isTracingActive()).toBe(false);
  });

  it('stops tracing for the rest of the session once performance is turned off', async () => {
    const telemetry = await loadController();
    telemetry.start(EVERYTHING);
    expect(telemetry.isTracingActive()).toBe(true);

    await telemetry.applyPreferences({ ...EVERYTHING, performance: false });

    expect(telemetry.isTracingActive()).toBe(false);
    expect(telemetry.getStatus().armed.performance).toBe(false);
    expect(telemetry.getStatus().active).toBe(true);
  });

  it('records a shutdown failure but still goes inactive', async () => {
    fake.flush.mockRejectedValueOnce(new Error('transport stuck'));
    const first = await loadController();
    first.start(ERRORS_ONLY);
    await first.applyPreferences(OFF);
    expect(first.getStatus().active).toBe(false);
    expect(fake.close).not.toHaveBeenCalled();

    fake.close.mockRejectedValueOnce('closed twice');
    const second = await loadController();
    second.start(ERRORS_ONLY);
    await second.applyPreferences(OFF);
    expect(second.getStatus().active).toBe(false);
  });
});

describe('telemetry beforeSend gate', () => {
  beforeEach(() => {
    vi.stubEnv('COSTGOBLIN_SENTRY_DSN', DSN);
  });

  it('scrubs an error report and mirrors it to the audit outbox', async () => {
    const telemetry = await loadController();
    telemetry.initialize(outboxDir);
    telemetry.start(ERRORS_ONLY);

    const sent = await sendError(initOptions(), { type: undefined, message: 'sync failed for jane@acme.test', user: { email: 'jane@acme.test' } });

    expect(sent?.message).toBe('sync failed for [redacted-email]');
    expect(sent?.user).toBeUndefined();
    await vi.waitFor(async () => {
      expect(await telemetry.getOutbox()).toEqual([
        expect.objectContaining({ kind: 'other', title: 'sync failed for [redacted-email]' }),
      ]);
    });
  });

  it('drops each kind of event whose channel is off', async () => {
    const telemetry = await loadController();
    telemetry.start({ ...OFF, nativeCrashReports: true });
    const options = initOptions();

    await expect(sendError(options, { type: undefined, message: 'js error' })).resolves.toBeNull();
    await expect(sendTransaction(options, { type: 'transaction', transaction: 'query' })).resolves.toBeNull();
    const crash = await sendError(options, { type: undefined, platform: 'native', message: 'minidump' });
    expect(crash?.platform).toBe('native');
  });

  it('drops a native crash once the native channel is turned off mid-session', async () => {
    const telemetry = await loadController();
    telemetry.start(EVERYTHING);
    const options = initOptions();

    await telemetry.applyPreferences({ ...EVERYTHING, nativeCrashReports: false });

    await expect(sendError(options, { type: undefined, platform: 'native', message: 'minidump' })).resolves.toBeNull();
    const error = await sendError(options, { type: undefined, message: 'still reported' });
    expect(error?.message).toBe('still reported');
  });

  it('passes a scrubbed transaction through when performance is on, with no outbox configured', async () => {
    const telemetry = await loadController();
    telemetry.start({ ...OFF, performance: true });

    const sent = await sendTransaction(initOptions(), { type: 'transaction', transaction: 'GET /Users/jane/report' });

    expect(sent?.transaction).toBe('GET /Users/[user]/report');
    await expect(telemetry.getOutbox()).resolves.toEqual([]);
  });
});
