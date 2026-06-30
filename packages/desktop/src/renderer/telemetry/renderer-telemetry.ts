import type { TelemetryStatus } from '@costgoblin/core/browser';

let initialized = false;

/**
 * Lazily initialise the renderer-side Sentry SDK once the user has armed crash
 * reports or performance tracing and the main-process reporter is active.
 * Renderer events are forwarded over IPC to the main process, where the
 * `beforeSend` / `beforeSendTransaction` scrub and the channel gate apply — so
 * the renderer never holds a DSN and never sends anything on its own; turning a
 * channel back off makes the main process drop whatever the renderer forwards.
 *
 * Gating: `errorReports` applies live (its gate is re-checked per event in the
 * main process), so we key off the desired preference. Performance tracing arms
 * at boot, so we key off `armed.performance` — the channel state the main
 * process actually init'd with — to avoid emitting transactions the main gate
 * would only drop. The browser-tracing integration auto-creates pageload +
 * navigation transactions; the sample rate comes from `status.tracesSampleRate`
 * (resolved once in the main process) so both processes sample identically.
 *
 * Idempotent (one init per session) and fail-safe: a bundling/SDK failure is
 * swallowed so it can never break the UI. The sole caller runs once on mount, so
 * a transient failure leaves renderer capture off until the next launch — the
 * `initialized = false` reset only helps if a future caller retries.
 */
export async function syncRendererTelemetry(status: TelemetryStatus): Promise<void> {
  const wantErrors = status.preferences.errorReports;
  const wantTracing = status.armed.performance;
  if (initialized || !status.active || (!wantErrors && !wantTracing)) return;
  initialized = true;
  try {
    const Sentry = await import('@sentry/electron/renderer');
    Sentry.init({
      ...(wantTracing
        ? { tracesSampleRate: status.tracesSampleRate, integrations: [Sentry.browserTracingIntegration()] }
        : {}),
    });
  } catch {
    initialized = false;
  }
}
