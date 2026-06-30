import { isStringRecord } from '../utils/json.js';

/**
 * Opt-in telemetry channels. Every channel defaults OFF — CostGoblin collects
 * nothing until the user explicitly enables it in Settings.
 *
 * See SPEC.md "Telemetry — Opt-in": no cost data, tag values, account IDs, team
 * names or business data ever leaves the machine, every payload is mirrored to a
 * local audit log, and all endpoints are configurable for self-hosted collectors.
 */
export interface TelemetryPreferences {
  /** Scrubbed JS error/exception reporting (main + renderer), via Sentry. Every
   *  event passes the PII scrub before transport — low data-leak risk. */
  readonly errorReports: boolean;
  /** Native crash reports (Crashpad minidumps): a RAW, unscrubbed snapshot of
   *  process memory. High data-leak risk, so it's a separate opt-in with its own
   *  explicit consent, independent of {@link errorReports}. */
  readonly nativeCrashReports: boolean;
  /** Sentry performance tracing (transaction / span sampling). */
  readonly performance: boolean;
  /** Product-usage analytics (PostHog) — reserved; not wired yet. */
  readonly analytics: boolean;
}

export const TELEMETRY_DEFAULTS: TelemetryPreferences = {
  errorReports: false,
  nativeCrashReports: false,
  performance: false,
  analytics: false,
};

/**
 * Sentry `tracesSampleRate` when the performance channel is on. Production
 * samples a fraction — enough volume for p95/p99 latency trends across releases
 * while staying well under Sentry's quota; local dev (only ever emits when a DSN
 * is set) samples everything so a developer sees every trace they generate. The
 * main process resolves this ONCE (from `app.isPackaged`) and surfaces it on
 * {@link TelemetryStatus.tracesSampleRate}, so the renderer samples at the same
 * rate — one decision, no cross-process drift.
 */
export const TELEMETRY_TRACES_SAMPLE_RATE_DEV = 1.0;
export const TELEMETRY_TRACES_SAMPLE_RATE_PROD = 0.1;

export function resolveTracesSampleRate(isDev: boolean): number {
  return isDev ? TELEMETRY_TRACES_SAMPLE_RATE_DEV : TELEMETRY_TRACES_SAMPLE_RATE_PROD;
}

/** True when at least one channel is on — i.e. the SDK should be initialised. */
export function isTelemetryEnabled(prefs: TelemetryPreferences): boolean {
  return prefs.errorReports || prefs.nativeCrashReports || prefs.performance || prefs.analytics;
}

/**
 * Parse an untrusted blob (read back from ui-preferences.json) into a fully
 * defaulted TelemetryPreferences. Missing/unknown fields fall back to OFF — we
 * fail closed so a corrupt or hand-edited prefs file can never silently turn
 * telemetry on.
 */
export function parseTelemetryPreferences(raw: unknown): TelemetryPreferences {
  if (!isStringRecord(raw)) return TELEMETRY_DEFAULTS;
  return {
    errorReports: raw['errorReports'] === true,
    nativeCrashReports: raw['nativeCrashReports'] === true,
    performance: raw['performance'] === true,
    analytics: raw['analytics'] === true,
  };
}

/** Reported to the settings UI so it can explain why nothing is being sent. */
export interface TelemetryStatus {
  /** A Sentry DSN is configured (via env). Without it no channel can send. */
  readonly dsnConfigured: boolean;
  /** The Sentry SDK has been loaded and initialised this session. */
  readonly active: boolean;
  /** The desired (post-restart) channel state, as saved. */
  readonly preferences: TelemetryPreferences;
  /** Which channels are actually capturing *right now*. Native crash capture and
   *  performance tracing can only arm at boot, so a mid-session opt-in reads false
   *  here until the app restarts — distinct from {@link preferences}, the desired
   *  state. The settings "● Active" badge keys off this, not the saved pref. */
  readonly armed: TelemetryPreferences;
  /** The Sentry `tracesSampleRate` this build uses for performance tracing,
   *  resolved once in the main process (dev samples more than prod). Surfaced so
   *  the renderer samples at the SAME rate as the main process — one decision, no
   *  cross-process drift. See {@link resolveTracesSampleRate}. */
  readonly tracesSampleRate: number;
}

export type TelemetryEventKind = 'error' | 'transaction' | 'session' | 'crash' | 'other';

/**
 * A single line of the local telemetry audit log ("outbox"). One entry is
 * appended for every event handed to the transport, so the user can open
 * Settings → Telemetry and see exactly what left the machine.
 */
export interface TelemetryOutboxEntry {
  readonly timestamp: string;
  readonly eventId: string | null;
  readonly level: string | null;
  readonly kind: TelemetryEventKind;
  /** A short, already-scrubbed human label (exception type/value or message). */
  readonly title: string;
}
