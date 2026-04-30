import { PostHog } from 'posthog-node';
import { logger, sanitizeTelemetryPayload } from '@costgoblin/core';
import type { AnalyticsEventType, TelemetryChannelConfig } from '@costgoblin/core';

/**
 * PostHog client for privacy-safe analytics tracking.
 *
 * Tracks usage events (view_opened, query_executed, sync_completed, etc.)
 * with sanitized properties. No cost data, tag values, account IDs, or
 * business data is ever transmitted.
 */
export interface PostHogClient {
  /**
   * Track an analytics event with sanitized properties.
   * Events are only sent if analytics telemetry is enabled.
   */
  track(
    eventType: AnalyticsEventType,
    properties?: Readonly<Record<string, unknown>>,
  ): Promise<void>;

  /**
   * Flush pending events and shutdown the client.
   */
  shutdown(): Promise<void>;
}

/**
 * Default PostHog API endpoint.
 */
const DEFAULT_POSTHOG_ENDPOINT = 'https://app.posthog.com';

/**
 * Default PostHog project API key (set to empty - should be configured).
 */
const DEFAULT_POSTHOG_API_KEY = 'phc_placeholder';

/**
 * Anonymous distinct ID for privacy - no user identification.
 */
const ANONYMOUS_DISTINCT_ID = 'anonymous';

/**
 * Creates a PostHog client for analytics tracking.
 *
 * @param config - Telemetry channel configuration (enabled state, optional endpoint)
 * @param apiKey - PostHog project API key (optional, defaults to placeholder)
 * @param onAuditLog - Callback for audit logging (called before sending events)
 * @returns PostHog client instance
 */
export function createPostHogClient(
  config: TelemetryChannelConfig,
  apiKey: string = DEFAULT_POSTHOG_API_KEY,
  onAuditLog?: (eventType: AnalyticsEventType, sanitizedProperties: Readonly<Record<string, unknown>>) => void,
): PostHogClient {
  const endpoint = config.endpoint ?? DEFAULT_POSTHOG_ENDPOINT;

  // Initialize PostHog client
  const client = new PostHog(apiKey, {
    host: endpoint,
    flushAt: 1, // Flush immediately for real-time tracking
    flushInterval: 0, // Disable automatic flushing
  });

  let isShutdown = false;

  return {
    async track(
      eventType: AnalyticsEventType,
      properties: Readonly<Record<string, unknown>> = {},
    ): Promise<void> {
      // Skip if telemetry is disabled
      if (!config.enabled) {
        logger.debug('posthog:track-skipped', {
          eventType,
          reason: 'analytics telemetry disabled',
        });
        return;
      }

      // Skip if client is shutdown
      if (isShutdown) {
        logger.debug('posthog:track-skipped', {
          eventType,
          reason: 'client shutdown',
        });
        return;
      }

      try {
        // Sanitize properties to remove PII
        const rawSanitized = sanitizeTelemetryPayload(properties);

        // Type guard: ensure sanitized result is an object
        const sanitizedProperties: Readonly<Record<string, unknown>> =
          typeof rawSanitized === 'object' && rawSanitized !== null && !Array.isArray(rawSanitized)
            ? (rawSanitized as Readonly<Record<string, unknown>>)
            : {};

        // Add telemetry metadata
        const fullProperties: Record<string, unknown> = {
          ...sanitizedProperties,
          timestamp: new Date().toISOString(),
          channel: 'analytics',
        };

        // Call audit log callback before sending
        if (onAuditLog !== undefined) {
          onAuditLog(eventType, fullProperties);
        }

        // Track event with PostHog
        client.capture({
          distinctId: ANONYMOUS_DISTINCT_ID,
          event: eventType,
          properties: fullProperties,
        });

        // Flush immediately to ensure event is sent
        await client.flush();

        logger.debug('posthog:track', {
          eventType,
          propertyCount: Object.keys(sanitizedProperties).length,
        });
      } catch (error) {
        // Log errors but don't throw - telemetry failures should not break the app
        logger.error('posthog:track-error', {
          eventType,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },

    async shutdown(): Promise<void> {
      if (isShutdown) {
        return;
      }

      isShutdown = true;

      try {
        await client.shutdown();
        logger.debug('posthog:shutdown', {});
      } catch (error) {
        logger.error('posthog:shutdown-error', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
