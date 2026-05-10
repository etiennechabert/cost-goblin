/**
 * XDG Base Directory Specification support for Linux.
 *
 * On Linux, follows XDG conventions:
 * - Config: $XDG_CONFIG_HOME (default: ~/.config)
 * - Data: $XDG_DATA_HOME (default: ~/.local/share)
 *
 * On other platforms, returns the provided default paths from Electron's
 * app.getPath('userData').
 *
 * @see https://specifications.freedesktop.org/basedir-spec/basedir-spec-latest.html
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '@costgoblin/core';

/**
 * Checks if the current platform is Linux.
 */
function isLinux(): boolean {
  return process.platform === 'linux';
}

/**
 * Resolves XDG config directory for Linux, or returns the provided default
 * path for other platforms.
 *
 * On Linux:
 * 1. Uses $XDG_CONFIG_HOME if set
 * 2. Falls back to ~/.config
 *
 * On macOS/Windows:
 * Returns the provided defaultPath unchanged.
 *
 * @param defaultPath - The default path from app.getPath('userData')
 * @param appName - Application name to append to the XDG path (default: 'CostGoblin')
 * @returns Resolved config directory path
 */
export function resolveConfigDir(defaultPath: string, appName = 'CostGoblin'): string {
  if (!isLinux()) {
    return defaultPath;
  }

  const xdgConfigHome = process.env['XDG_CONFIG_HOME'];
  const configBase = typeof xdgConfigHome === 'string' && xdgConfigHome.length > 0
    ? xdgConfigHome
    : join(homedir(), '.config');

  const resolvedPath = join(configBase, appName);

  logger.debug('Resolved XDG config directory', {
    platform: process.platform,
    xdgConfigHome,
    configBase,
    resolvedPath,
  });

  return resolvedPath;
}

/**
 * Resolves XDG data directory for Linux, or returns the provided default
 * path for other platforms.
 *
 * On Linux:
 * 1. Uses $XDG_DATA_HOME if set
 * 2. Falls back to ~/.local/share
 *
 * On macOS/Windows:
 * Returns the provided defaultPath unchanged.
 *
 * @param defaultPath - The default path from app.getPath('userData')
 * @param appName - Application name to append to the XDG path (default: 'CostGoblin')
 * @returns Resolved data directory path
 */
export function resolveDataDir(defaultPath: string, appName = 'CostGoblin'): string {
  if (!isLinux()) {
    return defaultPath;
  }

  const xdgDataHome = process.env['XDG_DATA_HOME'];
  const dataBase = typeof xdgDataHome === 'string' && xdgDataHome.length > 0
    ? xdgDataHome
    : join(homedir(), '.local', 'share');

  const resolvedPath = join(dataBase, appName);

  logger.debug('Resolved XDG data directory', {
    platform: process.platform,
    xdgDataHome,
    dataBase,
    resolvedPath,
  });

  return resolvedPath;
}
