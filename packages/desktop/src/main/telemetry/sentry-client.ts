import * as Sentry from '@sentry/electron/main';
import type { Event, Exception, StackFrame, Breadcrumb } from '@sentry/electron/main';
import { logger, sanitizeError, sanitizeTelemetryPayload } from '@costgoblin/core';
import type { TelemetryChannelConfig, CrashEventType } from '@costgoblin/core';

/**
 * Sentry client for crash reporting and performance monitoring.
 *
 * Captures unhandled errors and performance metrics with sanitized context.
 * No cost data, tag values, account IDs, or business data is ever transmitted.
 */
export interface SentryClient {
  /**
   * Capture an error manually with sanitized context.
   * Errors are only sent if crash reporting telemetry is enabled.
   */
  captureError(
    error: Error,
    eventType: CrashEventType,
    context?: Readonly<Record<string, unknown>>,
  ): void;

  /**
   * Flush pending events and close the client.
   */
  close(): Promise<void>;
}

/**
 * Default Sentry DSN (set to empty - should be configured).
 */
const DEFAULT_SENTRY_DSN = '';

/**
 * Creates a Sentry client for crash reporting and performance monitoring.
 *
 * @param crashConfig - Crash reporting telemetry channel configuration
 * @param performanceConfig - Performance monitoring telemetry channel configuration
 * @param dsn - Sentry DSN (Data Source Name)
 * @param release - Application release version
 * @param environment - Environment name (development, production, etc.)
 * @param onAuditLog - Callback for audit logging (called before sending events)
 * @returns Sentry client instance
 */
export function createSentryClient(
  crashConfig: TelemetryChannelConfig,
  performanceConfig: TelemetryChannelConfig,
  dsn: string = DEFAULT_SENTRY_DSN,
  release?: string,
  environment?: string,
  onAuditLog?: (
    eventType: CrashEventType,
    sanitizedEvent: Readonly<Record<string, unknown>>,
  ) => void,
): SentryClient {
  // Initialize Sentry
  const options = {
    dsn: crashConfig.endpoint ?? dsn, // Use custom endpoint if provided
    release,
    environment,
    // Enable performance monitoring only if enabled
    tracesSampleRate: performanceConfig.enabled ? 1.0 : 0.0,
    // Disable sending default PII (IP addresses, user agent)
    sendDefaultPii: false,
    // beforeSend hook to strip PII and filter disabled telemetry
    beforeSend(event: Event): Event | null {
      // Skip if crash reporting is disabled
      if (!crashConfig.enabled) {
        logger.debug('sentry:beforeSend-skipped', {
          reason: 'crash reporting telemetry disabled',
        });
        return null;
      }

      try {
        // Sanitize exception data
        if (event.exception?.values !== undefined) {
          event.exception.values = event.exception.values.map((exception: Exception): Exception => {
            if (exception.value !== undefined) {
              exception.value = String(
                sanitizeTelemetryPayload(exception.value),
              );
            }
            if (exception.stacktrace?.frames !== undefined) {
              exception.stacktrace.frames =
                exception.stacktrace.frames.map((frame: StackFrame): StackFrame => {
                  // Preserve function names and line numbers, but redact file paths
                  const sanitizedFrame: StackFrame = { ...frame };
                  if (frame.filename !== undefined) {
                    sanitizedFrame.filename = '[REDACTED_PATH]';
                  }
                  if (frame.abs_path !== undefined) {
                    sanitizedFrame.abs_path = '[REDACTED_PATH]';
                  }
                  return sanitizedFrame;
                });
            }
            return exception;
          });
        }

        // Sanitize message
        if (event.message !== undefined) {
          event.message = String(sanitizeTelemetryPayload(event.message));
        }

        // Sanitize request data
        if (event.request !== undefined) {
          const sanitized = sanitizeTelemetryPayload(event.request);
          if (
            typeof sanitized === 'object' &&
            sanitized !== null &&
            !Array.isArray(sanitized)
          ) {
            event.request = sanitized;
          }
        }

        // Sanitize user context (remove any PII)
        delete event.user;

        // Sanitize extra context
        if (event.extra !== undefined) {
          const rawSanitized = sanitizeTelemetryPayload(event.extra);
          event.extra =
            typeof rawSanitized === 'object' &&
            rawSanitized !== null &&
            !Array.isArray(rawSanitized)
              ? (rawSanitized as Record<string, unknown>)
              : {};
        }

        // Remove contexts entirely to avoid PII leakage
        // Contexts may contain user data, environment variables, etc.
        delete event.contexts;

        // Sanitize breadcrumbs
        if (event.breadcrumbs !== undefined) {
          event.breadcrumbs = event.breadcrumbs.map((breadcrumb: Breadcrumb): Breadcrumb => {
            const sanitizedBreadcrumb: Breadcrumb = { ...breadcrumb };
            if (breadcrumb.message !== undefined) {
              sanitizedBreadcrumb.message = String(
                sanitizeTelemetryPayload(breadcrumb.message),
              );
            }
            if (breadcrumb.data !== undefined) {
              const sanitizedData = sanitizeTelemetryPayload(breadcrumb.data);
              if (
                typeof sanitizedData === 'object' &&
                sanitizedData !== null &&
                !Array.isArray(sanitizedData)
              ) {
                sanitizedBreadcrumb.data = sanitizedData;
              }
            }
            return sanitizedBreadcrumb;
          });
        }

        // Call audit log callback before sending
        if (onAuditLog !== undefined) {
          const sanitizedEvent: Record<string, unknown> = {
            level: event.level,
            message: event.message,
            exception: event.exception,
            timestamp: event.timestamp,
            platform: event.platform,
          };
          onAuditLog('error', sanitizedEvent);
        }

        return event;
      } catch (error) {
        // Log errors but don't throw - telemetry failures should not break the app
        logger.error('sentry:beforeSend-error', {
          error: error instanceof Error ? error.message : String(error),
        });
        // Return null to prevent sending malformed events
        return null;
      }
    },
  };
  Sentry.init(options);

  return {
    captureError(
      error: Error,
      eventType: CrashEventType,
      context: Readonly<Record<string, unknown>> = {},
    ): void {
      // Skip if crash reporting is disabled
      if (!crashConfig.enabled) {
        logger.debug('sentry:capture-skipped', {
          eventType,
          reason: 'crash reporting telemetry disabled',
        });
        return;
      }

      try {
        // Sanitize the error before capturing
        const sanitizedError = sanitizeError(error);

        // Sanitize context
        const rawSanitizedContext = sanitizeTelemetryPayload(context);
        const sanitizedContext: Readonly<Record<string, unknown>> =
          typeof rawSanitizedContext === 'object' &&
          rawSanitizedContext !== null &&
          !Array.isArray(rawSanitizedContext)
            ? (rawSanitizedContext as Readonly<Record<string, unknown>>)
            : {};

        // Capture error with Sentry
        Sentry.captureException(error, {
          level: 'error',
          tags: {
            eventType,
          },
          extra: {
            ...sanitizedContext,
            sanitizedError,
          },
        });

        logger.debug('sentry:capture', {
          eventType,
          errorName: sanitizedError.name,
        });
      } catch (captureError) {
        // Log errors but don't throw - telemetry failures should not break the app
        logger.error('sentry:capture-error', {
          eventType,
          error:
            captureError instanceof Error
              ? captureError.message
              : String(captureError),
        });
      }
    },

    async close(): Promise<void> {
      try {
        await Sentry.close(2000); // 2 second timeout
        logger.debug('sentry:close', {});
      } catch (error) {
        logger.error('sentry:close-error', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
