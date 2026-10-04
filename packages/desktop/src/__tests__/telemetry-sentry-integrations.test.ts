import { describe, it, expect } from 'vitest';
import { selectSentryIntegrations } from '../main/telemetry/sentry-integrations.js';

// The names @sentry/electron's main-process defaults carry; only the two the
// selection acts on matter, the rest stand in for everything else.
const DEFAULTS: readonly { readonly name: string }[] = [
  { name: 'SentryMinidump' },
  { name: 'PreloadInjection' },
  { name: 'OnUncaughtException' },
  { name: 'MainProcessSession' },
];

const names = (list: readonly { readonly name: string }[]): string[] => list.map((i) => i.name);

describe('selectSentryIntegrations', () => {
  // PreloadInjection registers the SDK's own preload on the session, so it
  // runs in EVERY frame and exposes __SENTRY_IPC__ outside the preload's
  // bridge gate. The app's preload already hooks IPC up for its own document.
  it.each([true, false])('never keeps PreloadInjection (native crash reports: %s)', (nativeCrashReports) => {
    expect(names(selectSentryIntegrations(DEFAULTS, nativeCrashReports))).not.toContain('PreloadInjection');
  });

  it('keeps SentryMinidump only when native crash reports are on', () => {
    expect(names(selectSentryIntegrations(DEFAULTS, true))).toStrictEqual(['SentryMinidump', 'OnUncaughtException', 'MainProcessSession']);
    expect(names(selectSentryIntegrations(DEFAULTS, false))).toStrictEqual(['OnUncaughtException', 'MainProcessSession']);
  });
});
