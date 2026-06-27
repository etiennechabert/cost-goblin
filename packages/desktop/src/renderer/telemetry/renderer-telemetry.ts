import type { TelemetryStatus } from '@costgoblin/core/browser';

let initialized = false;

/**
 * Lazily initialise the renderer-side Sentry SDK once the user has opted into
 * crash reports and the main-process reporter is active. Renderer events are
 * forwarded over IPC to the main process, where the `beforeSend` scrub and the
 * channel gate apply — so the renderer never holds a DSN and never sends
 * anything on its own; turning the channel back off makes the main process drop
 * whatever the renderer forwards.
 *
 * Idempotent (one init per session) and fail-safe: a bundling or SDK failure
 * must never break the UI, so it is swallowed and a retry is allowed next sync.
 */
export async function syncRendererTelemetry(status: TelemetryStatus): Promise<void> {
  if (initialized || !status.active || !status.preferences.errorReports) return;
  initialized = true;
  try {
    const Sentry = await import('@sentry/electron/renderer');
    Sentry.init({});
  } catch {
    initialized = false;
  }
}
