import { describe, it, expect } from 'vitest';
import {
  DEFAULT_WORKSPACE_NAME,
  RESERVED_WORKSPACE_NAMES,
  WORKSPACE_NAME_PATTERN,
  WorkspaceNameError,
  isValidWorkspaceName,
  parseWorkspaceName,
} from '../config/workspace-name.js';

describe('isValidWorkspaceName', () => {
  it('accepts typical names', () => {
    for (const name of ['default', 'a', 'A', '0', 'my-workspace', 'work_space2', 'Acme-Prod_2026', '9lives']) {
      expect(isValidWorkspaceName(name), name).toBe(true);
    }
  });

  it('accepts a name of exactly 64 characters', () => {
    expect(isValidWorkspaceName('a'.repeat(64))).toBe(true);
  });

  it('rejects a name of 65 characters', () => {
    expect(isValidWorkspaceName('a'.repeat(65))).toBe(false);
  });

  it('rejects the empty string', () => {
    expect(isValidWorkspaceName('')).toBe(false);
  });

  it('rejects a leading hyphen or underscore', () => {
    expect(isValidWorkspaceName('-lead')).toBe(false);
    expect(isValidWorkspaceName('_lead')).toBe(false);
  });

  it('rejects dots and path traversal', () => {
    expect(isValidWorkspaceName('..')).toBe(false);
    expect(isValidWorkspaceName('.')).toBe(false);
    expect(isValidWorkspaceName('.hidden')).toBe(false);
    expect(isValidWorkspaceName('a.b')).toBe(false);
    expect(isValidWorkspaceName('..evil')).toBe(false);
  });

  it('rejects slashes and backslashes', () => {
    expect(isValidWorkspaceName('a/b')).toBe(false);
    expect(isValidWorkspaceName('/abs')).toBe(false);
    expect(isValidWorkspaceName('a\\b')).toBe(false);
  });

  it('rejects whitespace and control characters', () => {
    expect(isValidWorkspaceName('a b')).toBe(false);
    expect(isValidWorkspaceName('a\tb')).toBe(false);
    expect(isValidWorkspaceName('a\nb')).toBe(false);
    expect(isValidWorkspaceName('a\u00a0b')).toBe(false); // non-breaking space
    expect(isValidWorkspaceName(' lead')).toBe(false);
  });

  it('rejects reserved Windows device names case-insensitively', () => {
    for (const name of ['CON', 'con', 'Con', 'PRN', 'prn', 'AUX', 'aux', 'NUL', 'nul', 'COM1', 'com9', 'LPT1', 'lpt9']) {
      expect(isValidWorkspaceName(name), name).toBe(false);
    }
  });

  it('accepts near-reserved names that are not actually reserved', () => {
    for (const name of ['CON2', 'COM0', 'COM10', 'LPT0', 'console', 'auxiliary', 'nullable']) {
      expect(isValidWorkspaceName(name), name).toBe(true);
    }
  });
});

describe('parseWorkspaceName', () => {
  it('returns the input for valid names', () => {
    expect(parseWorkspaceName('default')).toBe('default');
    expect(parseWorkspaceName('My_Workspace-1')).toBe('My_Workspace-1');
  });

  it('throws WorkspaceNameError for the empty string', () => {
    expect(() => parseWorkspaceName('')).toThrow(WorkspaceNameError);
    expect(() => parseWorkspaceName('')).toThrow(/cannot be empty/i);
  });

  it('throws WorkspaceNameError for over-long names', () => {
    expect(() => parseWorkspaceName('a'.repeat(65))).toThrow(WorkspaceNameError);
    expect(() => parseWorkspaceName('a'.repeat(65))).toThrow(/64 characters/);
  });

  it('throws WorkspaceNameError for reserved names, naming the offender', () => {
    expect(() => parseWorkspaceName('con')).toThrow(WorkspaceNameError);
    expect(() => parseWorkspaceName('con')).toThrow(/reserved/i);
    expect(() => parseWorkspaceName('LPT5')).toThrow(/reserved/i);
  });

  it('throws WorkspaceNameError for names with invalid characters', () => {
    for (const name of ['-lead', 'a/b', 'a\\b', 'a b', '..', 'a.b', 'é']) {
      expect(() => parseWorkspaceName(name), name).toThrow(WorkspaceNameError);
    }
    expect(() => parseWorkspaceName('a b')).toThrow(/letters, numbers, hyphens, and underscores/);
  });
});

describe('constants', () => {
  it('DEFAULT_WORKSPACE_NAME is a valid workspace name', () => {
    expect(DEFAULT_WORKSPACE_NAME).toBe('default');
    expect(isValidWorkspaceName(DEFAULT_WORKSPACE_NAME)).toBe(true);
  });

  it('WORKSPACE_NAME_PATTERN and RESERVED_WORKSPACE_NAMES are exported for reuse', () => {
    expect(WORKSPACE_NAME_PATTERN.test('ok-name')).toBe(true);
    expect(RESERVED_WORKSPACE_NAMES).toContain('CON');
    expect(RESERVED_WORKSPACE_NAMES).toHaveLength(22);
    // Reserved entries are stored uppercase — the case-insensitive check depends on it.
    for (const reserved of RESERVED_WORKSPACE_NAMES) {
      expect(reserved).toBe(reserved.toUpperCase());
    }
  });
});
