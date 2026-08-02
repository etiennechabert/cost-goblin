import { asWorkspaceName } from '../types/branded.js';
import type { WorkspaceName } from '../types/branded.js';

/** A workspace name must start with a letter or digit, then letters, digits,
 *  hyphens, or underscores — 64 characters max. Doubles as the on-disk
 *  directory name under `{userData}/workspaces/`, so no separators, dots, or
 *  control characters are ever allowed. #516 reuses these rules for provider
 *  names — keep the pattern and reserved list as named exports. */
export const WORKSPACE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Windows reserved device names — rejected case-insensitively because the
 *  workspace name becomes a directory name. */
export const RESERVED_WORKSPACE_NAMES: readonly string[] = [
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM0',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT0',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
];

export const DEFAULT_WORKSPACE_NAME: WorkspaceName = asWorkspaceName('default');

export class WorkspaceNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceNameError';
  }
}

export function isValidWorkspaceName(raw: string): boolean {
  return WORKSPACE_NAME_PATTERN.test(raw) && !RESERVED_WORKSPACE_NAMES.includes(raw.toUpperCase());
}

/** Parses a raw string into a `WorkspaceName`, or throws a `WorkspaceNameError`
 *  whose message is friendly enough to surface directly in the UI. */
export function parseWorkspaceName(raw: string): WorkspaceName {
  if (raw.length === 0) {
    throw new WorkspaceNameError('Workspace name cannot be empty.');
  }
  if (raw.length > 64) {
    throw new WorkspaceNameError('Workspace name must be 64 characters or fewer.');
  }
  if (RESERVED_WORKSPACE_NAMES.includes(raw.toUpperCase())) {
    throw new WorkspaceNameError(`"${raw}" is a reserved name — please pick a different one.`);
  }
  if (!WORKSPACE_NAME_PATTERN.test(raw)) {
    throw new WorkspaceNameError(
      'Workspace names must start with a letter or number and may only contain letters, numbers, hyphens, and underscores.',
    );
  }
  return asWorkspaceName(raw);
}
