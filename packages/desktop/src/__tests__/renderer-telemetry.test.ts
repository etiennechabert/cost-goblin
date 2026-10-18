import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserOptions } from '@sentry/electron/renderer';
import type { TelemetryStatus } from '@costgoblin/core/browser';

/** The renderer's Sentry client collects before it forwards to main, so it
 *  must get the same privacy settings as the main-process client. */

const fake = vi.hoisted(() => ({
  init: vi.fn<(options: BrowserOptions) => void>(),
  browserTracingIntegration: vi.fn(() => ({ name: 'BrowserTracing' })),
}));

vi.mock('@sentry/electron/renderer', () => ({ init: fake.init, browserTracingIntegration: fake.browserTracingIntegration }));

function status(performance: boolean): TelemetryStatus {
  const preferences = { errorReports: true, nativeCrashReports: false, performance, analytics: false };
  return { dsnConfigured: true, active: true, preferences, armed: preferences, tracesSampleRate: 0.25 };
}

async function sync(s: TelemetryStatus): Promise<BrowserOptions> {
  vi.resetModules();
  const { syncRendererTelemetry } = await import('../renderer/telemetry/renderer-telemetry.js');
  await syncRendererTelemetry(s);
  expect(fake.init).toHaveBeenCalledTimes(1);
  const options = fake.init.mock.calls[0]?.[0];
  if (options === undefined) throw new Error('Sentry.init was not called');
  return options;
}

afterEach(() => {
  fake.init.mockReset();
});

describe('renderer telemetry', () => {
  it('turns off every data-collection category and keeps traces static', async () => {
    const options = await sync(status(false));

    expect(options.dataCollection).toEqual({
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
    });
    expect(options.traceLifecycle).toBe('static');
    expect('tracesSampleRate' in options).toBe(false);
  });

  it('adds browser tracing at the main process sample rate when performance is armed', async () => {
    const options = await sync(status(true));

    expect(options).toMatchObject({ traceLifecycle: 'static', tracesSampleRate: 0.25 });
    expect(options.integrations).toEqual([{ name: 'BrowserTracing' }]);
  });
});
