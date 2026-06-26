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
  /** Sentry crash + error reporting (native main-process crashes + JS errors). */
  readonly crashReports: boolean;
  /** Sentry performance tracing (transaction / span sampling). */
  readonly performance: boolean;
  /** Product-usage analytics (PostHog) — reserved; not wired yet. */
  readonly analytics: boolean;
}

export const TELEMETRY_DEFAULTS: TelemetryPreferences = {
  crashReports: false,
  performance: false,
  analytics: false,
};

/** True when at least one channel is on — i.e. the SDK should be initialised. */
export function isTelemetryEnabled(prefs: TelemetryPreferences): boolean {
  return prefs.crashReports || prefs.performance || prefs.analytics;
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
    crashReports: raw['crashReports'] === true,
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
  readonly preferences: TelemetryPreferences;
}

export type TelemetryEventKind = 'error' | 'transaction' | 'session' | 'other';

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
