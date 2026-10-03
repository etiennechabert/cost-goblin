import { describe, it, expect } from 'vitest';
import { isValidGcpProjectId } from '../config/gcp-project-id.js';

describe('isValidGcpProjectId', () => {
  it('accepts typical project IDs', () => {
    for (const id of ['acme-prod', 'billing-504501', 'my-project-123', 'abcdef', 'a1b2c3d4']) {
      expect(isValidGcpProjectId(id), id).toBe(true);
    }
  });

  it('accepts exactly 6 and exactly 30 characters', () => {
    expect(isValidGcpProjectId('abcdef')).toBe(true);
    expect(isValidGcpProjectId(`a${'b'.repeat(29)}`)).toBe(true);
  });

  it('rejects fewer than 6 or more than 30 characters', () => {
    expect(isValidGcpProjectId('abcde')).toBe(false);
    expect(isValidGcpProjectId(`a${'b'.repeat(30)}`)).toBe(false);
    expect(isValidGcpProjectId('')).toBe(false);
  });

  it('requires a leading lowercase letter', () => {
    expect(isValidGcpProjectId('1acme-prod')).toBe(false);
    expect(isValidGcpProjectId('-acme-prod')).toBe(false);
  });

  it('rejects a trailing hyphen', () => {
    expect(isValidGcpProjectId('acme-prod-')).toBe(false);
  });

  it('rejects uppercase, underscores, dots, spaces and other characters', () => {
    for (const id of ['Acme-prod', 'acme_prod', 'acme.prod', 'acme prod', 'acme/prod', 'acme-prod;rm']) {
      expect(isValidGcpProjectId(id), JSON.stringify(id)).toBe(false);
    }
  });

  it('is anchored at both ends, so surrounding whitespace is not accepted', () => {
    // JS `$` without the m flag does not match before a trailing newline.
    expect(isValidGcpProjectId('acme-prod\n')).toBe(false);
    expect(isValidGcpProjectId(' acme-prod')).toBe(false);
  });
});
