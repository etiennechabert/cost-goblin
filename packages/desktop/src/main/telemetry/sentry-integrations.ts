/**
 * Which of @sentry/electron's default main-process integrations the app runs.
 * Kept free of the SDK import so it can be tested without Electron.
 */

/** Arms the native crash handler (Crashpad minidumps are raw, unscrubbed
 *  memory), so it runs only when the separate native-crash channel is on. */
const NATIVE_CRASH_INTEGRATION = 'SentryMinidump';

/** Registers the SDK's own preload on the session, where it runs in every
 *  frame — a foreign document included — and exposes `__SENTRY_IPC__` outside
 *  the app preload's bridge gate. The app preload already hooks the IPC up for
 *  its own document, so this one never runs. */
const PRELOAD_INJECTION_INTEGRATION = 'PreloadInjection';

/** The defaults to keep for this session. */
export function selectSentryIntegrations<T extends { readonly name: string }>(
  defaults: readonly T[],
  nativeCrashReports: boolean,
): T[] {
  return defaults.filter((i) =>
    i.name !== PRELOAD_INJECTION_INTEGRATION && (nativeCrashReports || i.name !== NATIVE_CRASH_INTEGRATION),
  );
}
