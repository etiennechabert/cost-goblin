import { ipcMain } from 'electron';
import { isStringRecord, logger } from '@costgoblin/core';
import type {
  TelemetryConfig,
  TelemetryChannel,
  AnalyticsEventType,
} from '@costgoblin/core';
import type { AppContext } from './context.js';

export function registerTelemetryHandlers(app: AppContext): void {
  const { ctx, getConfig, invalidateConfig } = app;

  ipcMain.handle('telemetry:get-config', async (): Promise<TelemetryConfig | undefined> => {
    const config = await getConfig();
    return config.telemetry;
  });

  // Surgical update: update only the specified telemetry channel's enabled
  // state, leaving all other telemetry channels and config fields untouched.
  ipcMain.handle(
    'telemetry:update-channel',
    async (_event, channel: TelemetryChannel, enabled: boolean): Promise<void> => {
      const fs = await import('node:fs/promises');
      const { stringify, parse: parseYaml } = await import('yaml');
      const raw = await fs.readFile(ctx.configPath, 'utf-8');
      const parsed: unknown = parseYaml(raw);
      if (!isStringRecord(parsed)) throw new Error('Config file is not a YAML object');

      // Get existing telemetry config or create default structure
      const existingTelemetry: unknown = parsed['telemetry'];
      const telemetry = isStringRecord(existingTelemetry)
        ? existingTelemetry
        : {
            analytics: { enabled: false },
            crashReporting: { enabled: false },
            performance: { enabled: false },
          };

      // Update the specified channel's enabled state
      const channelConfig = isStringRecord(telemetry[channel])
        ? telemetry[channel]
        : { enabled: false };

      const updated = {
        ...parsed,
        telemetry: {
          ...telemetry,
          [channel]: { ...channelConfig, enabled },
        },
      };

      await fs.writeFile(ctx.configPath, stringify(updated), 'utf-8');
      invalidateConfig();
      logger.info(`Updated telemetry channel ${channel} to ${enabled ? 'enabled' : 'disabled'}`);
    },
  );

  // Full telemetry config update: replace the entire telemetry section.
  // Used when multiple channels need to be updated atomically or when
  // setting custom endpoints for self-hosted PostHog/Sentry instances.
  ipcMain.handle(
    'telemetry:update-config',
    async (_event, telemetryConfig: TelemetryConfig): Promise<void> => {
      const fs = await import('node:fs/promises');
      const { stringify, parse: parseYaml } = await import('yaml');
      const raw = await fs.readFile(ctx.configPath, 'utf-8');
      const parsed: unknown = parseYaml(raw);
      if (!isStringRecord(parsed)) throw new Error('Config file is not a YAML object');

      const updated = {
        ...parsed,
        telemetry: telemetryConfig,
      };

      await fs.writeFile(ctx.configPath, stringify(updated), 'utf-8');
      invalidateConfig();
      logger.info('Updated telemetry configuration');
    },
  );

  // Track analytics event. This is a pass-through handler that the renderer
  // process uses to send events to the main process telemetry clients.
  // The actual PostHog/Sentry clients are initialized in main.ts and handle
  // privacy filtering, audit logging, and transmission.
  ipcMain.handle(
    'telemetry:track-event',
    async (
      _event,
      eventType: AnalyticsEventType,
      properties?: Readonly<Record<string, unknown>>,
    ): Promise<void> => {
      // The main process telemetry manager will handle this event.
      // This handler exists primarily for type safety and to provide a clean
      // IPC interface. The actual implementation will be wired up when the
      // telemetry clients are initialized in main.ts.
      logger.debug('telemetry:track-event', { eventType, properties });
    },
  );
}
