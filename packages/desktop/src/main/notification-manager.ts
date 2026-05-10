import { Notification } from 'electron';
import { logger } from '@costgoblin/core';

export interface NotificationOptions {
  readonly title: string;
  readonly body: string;
  readonly silent?: boolean;
}

/**
 * Show a system notification using Electron's Notification API.
 * Works across Windows, macOS, and Linux desktop environments (GNOME, KDE).
 * Notifications respect the user's OS-level notification settings.
 */
export function showNotification(options: NotificationOptions): void {
  try {
    if (!Notification.isSupported()) {
      logger.warn('System notifications not supported on this platform');
      return;
    }

    const notification = new Notification({
      title: options.title,
      body: options.body,
      silent: options.silent ?? false,
    });

    notification.show();
    logger.debug('Notification shown', { title: options.title });
  } catch (err) {
    logger.warn('Failed to show notification', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Show a notification when a sync operation completes successfully.
 */
export function notifySyncComplete(filesDownloaded: number): void {
  showNotification({
    title: 'Sync Complete',
    body: `Downloaded ${String(filesDownloaded)} file${filesDownloaded === 1 ? '' : 's'}`,
  });
}

/**
 * Show a notification when a sync operation fails.
 */
export function notifySyncError(error: string): void {
  showNotification({
    title: 'Sync Failed',
    body: error,
  });
}

/**
 * Show a notification when a new update is available.
 */
export function notifyUpdateAvailable(version: string): void {
  showNotification({
    title: 'Update Available',
    body: `CostGoblin ${version} is available for download`,
  });
}

/**
 * Show a notification when an update has been downloaded and is ready to install.
 */
export function notifyUpdateDownloaded(version: string): void {
  showNotification({
    title: 'Update Ready',
    body: `CostGoblin ${version} is ready to install. Restart to update.`,
  });
}
