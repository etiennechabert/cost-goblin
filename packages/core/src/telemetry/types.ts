/**
 * Telemetry configuration types for opt-in usage analytics, crash reporting,
 * and performance monitoring.
 *
 * Privacy guarantee: No cost data, tag values, account IDs, team names, or
 * business data is ever transmitted. All telemetry channels are opt-in and
 * defaulted off. Telemetry payloads are logged locally for user inspection.
 */

/**
 * Configuration for a single telemetry channel (analytics, crash reporting,
 * or performance monitoring).
 */
export interface TelemetryChannelConfig {
  /** Whether this telemetry channel is enabled. Defaults to false. */
  readonly enabled: boolean;
  /** Optional custom endpoint for self-hosted PostHog/Sentry instances.
   *  When undefined, uses the default public endpoints. */
  readonly endpoint?: string | undefined;
}

/**
 * Telemetry configuration with three independent opt-in channels.
 */
export interface TelemetryConfig {
  /** Usage analytics via PostHog (feature usage, view navigation, query patterns). */
  readonly analytics: TelemetryChannelConfig;
  /** Crash reporting via Sentry (unhandled errors, React error boundary). */
  readonly crashReporting: TelemetryChannelConfig;
  /** Performance monitoring via Sentry Performance (query duration, sync latency). */
  readonly performance: TelemetryChannelConfig;
}

/**
 * Telemetry channel identifier.
 */
export type TelemetryChannel = 'analytics' | 'crashReporting' | 'performance';

/**
 * Event types tracked by the analytics channel (PostHog).
 */
export type AnalyticsEventType =
  | 'view_opened'
  | 'query_executed'
  | 'sync_completed'
  | 'dimension_configured'
  | 'filter_applied';

/**
 * Event types tracked by the crash reporting channel (Sentry).
 */
export type CrashEventType = 'error' | 'unhandled_rejection';

/**
 * Event types tracked by the performance monitoring channel (Sentry Performance).
 */
export type PerformanceEventType = 'query_duration' | 'sync_duration' | 'render_duration';

/**
 * Union of all telemetry event types across all channels.
 */
export type TelemetryEventType = AnalyticsEventType | CrashEventType | PerformanceEventType;

/**
 * A single entry in the local telemetry audit log.
 * Written to userData/telemetry-audit.jsonl in newline-delimited JSON format.
 */
export interface AuditLogEntry {
  /** ISO 8601 timestamp when the event was captured. */
  readonly timestamp: string;
  /** Which telemetry channel this event belongs to. */
  readonly channel: TelemetryChannel;
  /** Type of event being logged. */
  readonly eventType: TelemetryEventType;
  /** The telemetry payload being sent (after privacy filters have been applied).
   *  Serializable to JSON. May include properties like view name, dimension count,
   *  error message (redacted), but NEVER includes cost values, tag values, account
   *  IDs, or other business data. */
  readonly payload: Readonly<Record<string, unknown>>;
}
