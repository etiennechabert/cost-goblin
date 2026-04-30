import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { logger } from '@costgoblin/core';
import type {
  AuditLogEntry,
  TelemetryChannel,
  TelemetryEventType,
} from '@costgoblin/core';

/**
 * Writes telemetry events to a local audit log file for user inspection.
 *
 * The audit log is written in newline-delimited JSON (JSONL) format to
 * userData/telemetry-audit.jsonl. Each line is a complete JSON object
 * representing a single telemetry event.
 *
 * Privacy guarantee: The audit log contains only sanitized payloads that
 * have already passed through privacy filters. No cost data, tag values,
 * account IDs, or business data is ever written to the audit log.
 */
export interface AuditLogWriter {
  /**
   * Write a telemetry event to the audit log.
   *
   * @param channel - Which telemetry channel this event belongs to
   * @param eventType - Type of event being logged
   * @param payload - The sanitized telemetry payload (after privacy filters)
   */
  write(
    channel: TelemetryChannel,
    eventType: TelemetryEventType,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void>;
}

/**
 * Creates an audit log writer that appends telemetry events to a JSONL file.
 *
 * @param auditLogPath - Absolute path to the audit log file (typically userData/telemetry-audit.jsonl)
 * @returns Audit log writer instance
 */
export function createAuditLogWriter(auditLogPath: string): AuditLogWriter {
  return {
    async write(
      channel: TelemetryChannel,
      eventType: TelemetryEventType,
      payload: Readonly<Record<string, unknown>>,
    ): Promise<void> {
      try {
        // Create audit log entry
        const entry: AuditLogEntry = {
          timestamp: new Date().toISOString(),
          channel,
          eventType,
          payload,
        };

        // Serialize to JSON (single line)
        const line = JSON.stringify(entry) + '\n';

        // Ensure directory exists
        const dir = dirname(auditLogPath);
        await mkdir(dir, { recursive: true });

        // Append to audit log file
        await appendFile(auditLogPath, line, 'utf-8');

        logger.debug('audit-log:write', {
          channel,
          eventType,
          payloadKeys: Object.keys(payload).length,
        });
      } catch (error) {
        // Log errors but don't throw - telemetry failures should not break the app
        logger.error('audit-log:write-error', {
          channel,
          eventType,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
