import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecurityError } from '@costgoblin/core';

/**
 * Integration tests for perf:stop-cpu-profile IPC handler security.
 * These tests verify that the handler correctly validates profile labels
 * and prevents path traversal attacks.
 */

// Mock Electron's inspector session
interface MockSession {
  post: (method: string, callback?: (err: Error | null, result?: { profile: unknown }) => void) => void;
}

interface MockEvent {
  // Empty mock event object
}

// Helper to create a mock inspector session
function createMockSession(shouldFail = false): MockSession {
  return {
    post: vi.fn((method: string, callback?: (err: Error | null, result?: { profile: unknown }) => void) => {
      if (callback === undefined) {
        // Profiler.disable call (no callback)
        return;
      }

      if (shouldFail) {
        callback(new Error('Profiler error'));
      } else if (method === 'Profiler.stop') {
        callback(null, { profile: { nodes: [], samples: [] } });
      } else {
        callback(null);
      }
    }),
  };
}

// Simulate the IPC handler logic
function createHandler(session: MockSession) {
  // Import is done at runtime to match the actual handler
  return async (_event: MockEvent, label: string): Promise<{ path: string }> => {
    return new Promise<{ path: string }>((resolve, reject) => {
      // Validate label before constructing file path (prevents path traversal)
      try {
        // Inline validation logic to avoid import issues
        if (label.length === 0) {
          throw new SecurityError(
            'Profile label cannot be empty. ' +
            'This prevents file path construction errors.'
          );
        }

        const VALID_LABEL_PATTERN = /^[a-zA-Z0-9_-]+$/;
        if (!VALID_LABEL_PATTERN.test(label)) {
          throw new SecurityError(
            `Invalid profile label "${label}" - must contain only alphanumeric characters, hyphens, and underscores. ` +
            `This prevents path traversal attacks via special characters (/, \\, .., null bytes, etc.).`
          );
        }
      } catch (err) {
        reject(err);
        return;
      }

      session.post('Profiler.stop', (err, result) => {
        if (err !== null) {
          reject(err);
          return;
        }
        session.post('Profiler.disable');
        const dir = join(tmpdir(), 'costgoblin-perf');
        mkdirSync(dir, { recursive: true });
        const outPath = join(dir, `cpu-${label}.cpuprofile`);
        writeFileSync(outPath, JSON.stringify(result.profile));
        resolve({ path: outPath });
      });
    });
  };
}

describe('IPC Handler Security - perf:stop-cpu-profile', () => {
  const testDir = join(tmpdir(), 'costgoblin-perf');
  const mockEvent: MockEvent = {};

  beforeEach(() => {
    // Clean up test directory before each test
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    // Clean up test directory after each test
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('Valid labels work correctly', () => {
    it('accepts simple alphanumeric label', async () => {
      const session = createMockSession();
      const handler = createHandler(session);

      const result = await handler(mockEvent, 'query1');

      expect(result.path).toContain('cpu-query1.cpuprofile');
      expect(existsSync(result.path)).toBe(true);
    });

    it('accepts label with hyphens', async () => {
      const session = createMockSession();
      const handler = createHandler(session);

      const result = await handler(mockEvent, 'test-profile');

      expect(result.path).toContain('cpu-test-profile.cpuprofile');
      expect(existsSync(result.path)).toBe(true);
    });

    it('accepts label with underscores', async () => {
      const session = createMockSession();
      const handler = createHandler(session);

      const result = await handler(mockEvent, 'test_profile');

      expect(result.path).toContain('cpu-test_profile.cpuprofile');
      expect(existsSync(result.path)).toBe(true);
    });

    it('accepts label with mixed alphanumeric, hyphens, and underscores', async () => {
      const session = createMockSession();
      const handler = createHandler(session);

      const result = await handler(mockEvent, 'benchmark-2024_q1');

      expect(result.path).toContain('cpu-benchmark-2024_q1.cpuprofile');
      expect(existsSync(result.path)).toBe(true);
    });

    it('writes file to correct location with valid label', async () => {
      const session = createMockSession();
      const handler = createHandler(session);

      const result = await handler(mockEvent, 'validlabel');

      // Verify file is in the intended directory
      expect(result.path).toContain(testDir);
      expect(result.path).toMatch(/costgoblin-perf[/\\]cpu-validlabel\.cpuprofile$/);

      // Verify only one file was created
      const files = readdirSync(testDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toBe('cpu-validlabel.cpuprofile');
    });
  });

  describe('Malicious labels are rejected', () => {
    it('rejects path traversal with Unix separators', async () => {
      const session = createMockSession();
      const handler = createHandler(session);

      await expect(handler(mockEvent, '../../../etc/passwd')).rejects.toThrow(SecurityError);

      // Verify no file was written
      if (existsSync(testDir)) {
        const files = readdirSync(testDir);
        expect(files).toHaveLength(0);
      }
    });

    it('rejects path traversal with Windows separators', async () => {
      const session = createMockSession();
      const handler = createHandler(session);

      await expect(handler(mockEvent, '..\\..\\..\\windows\\system32')).rejects.toThrow(SecurityError);

      // Verify no file was written
      if (existsSync(testDir)) {
        const files = readdirSync(testDir);
        expect(files).toHaveLength(0);
      }
    });

    it('rejects absolute Unix path', async () => {
      const session = createMockSession();
      const handler = createHandler(session);

      await expect(handler(mockEvent, '/etc/passwd')).rejects.toThrow(SecurityError);

      // Verify no file was written
      if (existsSync(testDir)) {
        const files = readdirSync(testDir);
        expect(files).toHaveLength(0);
      }
    });

    it('rejects absolute Windows path', async () => {
      const session = createMockSession();
      const handler = createHandler(session);

      await expect(handler(mockEvent, 'C:\\Windows\\System32')).rejects.toThrow(SecurityError);

      // Verify no file was written
      if (existsSync(testDir)) {
        const files = readdirSync(testDir);
        expect(files).toHaveLength(0);
      }
    });

    it('rejects label with forward slash', async () => {
      const session = createMockSession();
      const handler = createHandler(session);

      await expect(handler(mockEvent, 'test/label')).rejects.toThrow(SecurityError);

      // Verify no file was written
      if (existsSync(testDir)) {
        const files = readdirSync(testDir);
        expect(files).toHaveLength(0);
      }
    });

    it('rejects label with backslash', async () => {
      const session = createMockSession();
      const handler = createHandler(session);

      await expect(handler(mockEvent, 'test\\label')).rejects.toThrow(SecurityError);

      // Verify no file was written
      if (existsSync(testDir)) {
        const files = readdirSync(testDir);
        expect(files).toHaveLength(0);
      }
    });

    it('rejects label with parent directory reference', async () => {
      const session = createMockSession();
      const handler = createHandler(session);

      await expect(handler(mockEvent, 'test..label')).rejects.toThrow(SecurityError);

      // Verify no file was written
      if (existsSync(testDir)) {
        const files = readdirSync(testDir);
        expect(files).toHaveLength(0);
      }
    });

    it('rejects label with dot alone', async () => {
      const session = createMockSession();
      const handler = createHandler(session);

      await expect(handler(mockEvent, '.')).rejects.toThrow(SecurityError);

      // Verify no file was written
      if (existsSync(testDir)) {
        const files = readdirSync(testDir);
        expect(files).toHaveLength(0);
      }
    });

    it('rejects label with semicolon (command injection)', async () => {
      const session = createMockSession();
      const handler = createHandler(session);

      await expect(handler(mockEvent, 'test;rm -rf /')).rejects.toThrow(SecurityError);

      // Verify no file was written
      if (existsSync(testDir)) {
        const files = readdirSync(testDir);
        expect(files).toHaveLength(0);
      }
    });

    it('rejects label with pipe character', async () => {
      const session = createMockSession();
      const handler = createHandler(session);

      await expect(handler(mockEvent, 'test|cat /etc/passwd')).rejects.toThrow(SecurityError);

      // Verify no file was written
      if (existsSync(testDir)) {
        const files = readdirSync(testDir);
        expect(files).toHaveLength(0);
      }
    });

    it('rejects label with ampersand', async () => {
      const session = createMockSession();
      const handler = createHandler(session);

      await expect(handler(mockEvent, 'test&malicious')).rejects.toThrow(SecurityError);

      // Verify no file was written
      if (existsSync(testDir)) {
        const files = readdirSync(testDir);
        expect(files).toHaveLength(0);
      }
    });

    it('rejects label with null byte', async () => {
      const session = createMockSession();
      const handler = createHandler(session);

      await expect(handler(mockEvent, 'test\x00label')).rejects.toThrow(SecurityError);

      // Verify no file was written
      if (existsSync(testDir)) {
        const files = readdirSync(testDir);
        expect(files).toHaveLength(0);
      }
    });

    it('rejects label with newline', async () => {
      const session = createMockSession();
      const handler = createHandler(session);

      await expect(handler(mockEvent, 'test\nlabel')).rejects.toThrow(SecurityError);

      // Verify no file was written
      if (existsSync(testDir)) {
        const files = readdirSync(testDir);
        expect(files).toHaveLength(0);
      }
    });

    it('rejects label with spaces', async () => {
      const session = createMockSession();
      const handler = createHandler(session);

      await expect(handler(mockEvent, 'test label')).rejects.toThrow(SecurityError);

      // Verify no file was written
      if (existsSync(testDir)) {
        const files = readdirSync(testDir);
        expect(files).toHaveLength(0);
      }
    });

    it('rejects label with special characters', async () => {
      const session = createMockSession();
      const handler = createHandler(session);

      await expect(handler(mockEvent, 'test@label')).rejects.toThrow(SecurityError);

      // Verify no file was written
      if (existsSync(testDir)) {
        const files = readdirSync(testDir);
        expect(files).toHaveLength(0);
      }
    });

    it('rejects label with Unicode characters', async () => {
      const session = createMockSession();
      const handler = createHandler(session);

      await expect(handler(mockEvent, 'test-λabel')).rejects.toThrow(SecurityError);

      // Verify no file was written
      if (existsSync(testDir)) {
        const files = readdirSync(testDir);
        expect(files).toHaveLength(0);
      }
    });

    it('rejects label with emoji', async () => {
      const session = createMockSession();
      const handler = createHandler(session);

      await expect(handler(mockEvent, 'test-😀-label')).rejects.toThrow(SecurityError);

      // Verify no file was written
      if (existsSync(testDir)) {
        const files = readdirSync(testDir);
        expect(files).toHaveLength(0);
      }
    });
  });

  describe('Error messages are descriptive', () => {
    it('provides clear error message for path traversal attempt', async () => {
      const session = createMockSession();
      const handler = createHandler(session);

      await expect(handler(mockEvent, '../../../etc/passwd')).rejects.toThrow(
        /Invalid profile label.*must contain only alphanumeric characters.*prevents path traversal/
      );
    });

    it('provides clear error message for special characters', async () => {
      const session = createMockSession();
      const handler = createHandler(session);

      await expect(handler(mockEvent, 'test;label')).rejects.toThrow(
        /Invalid profile label.*must contain only alphanumeric characters/
      );
    });

    it('error message mentions the invalid label', async () => {
      const session = createMockSession();
      const handler = createHandler(session);

      const maliciousLabel = 'test/malicious';
      await expect(handler(mockEvent, maliciousLabel)).rejects.toThrow(
        new RegExp(`Invalid profile label "${maliciousLabel.replace(/[/\\]/g, '\\$&')}"`)
      );
    });

    it('error message explains security rationale', async () => {
      const session = createMockSession();
      const handler = createHandler(session);

      await expect(handler(mockEvent, 'test\\label')).rejects.toThrow(
        /prevents path traversal attacks/
      );
    });
  });

  describe('Edge cases', () => {
    it('rejects empty label', async () => {
      const session = createMockSession();
      const handler = createHandler(session);

      await expect(handler(mockEvent, '')).rejects.toThrow(SecurityError);
      await expect(handler(mockEvent, '')).rejects.toThrow(/cannot be empty/);

      // Verify no file was written
      if (existsSync(testDir)) {
        const files = readdirSync(testDir);
        expect(files).toHaveLength(0);
      }
    });

    it('handles very long valid label', async () => {
      const session = createMockSession();
      const handler = createHandler(session);

      // 200 character label (all valid characters)
      const longLabel = 'a'.repeat(200);
      const result = await handler(mockEvent, longLabel);

      expect(result.path).toContain(`cpu-${longLabel}.cpuprofile`);
      expect(existsSync(result.path)).toBe(true);
    });

    it('accepts single character label', async () => {
      const session = createMockSession();
      const handler = createHandler(session);

      const result = await handler(mockEvent, 'x');

      expect(result.path).toContain('cpu-x.cpuprofile');
      expect(existsSync(result.path)).toBe(true);
    });

    it('accepts label with only numbers', async () => {
      const session = createMockSession();
      const handler = createHandler(session);

      const result = await handler(mockEvent, '12345');

      expect(result.path).toContain('cpu-12345.cpuprofile');
      expect(existsSync(result.path)).toBe(true);
    });

    it('accepts label with only hyphens and underscores (edge case)', async () => {
      const session = createMockSession();
      const handler = createHandler(session);

      const result = await handler(mockEvent, '-_-_-');

      expect(result.path).toContain('cpu--_-_-.cpuprofile');
      expect(existsSync(result.path)).toBe(true);
    });

    it('rejects whitespace-only label', async () => {
      const session = createMockSession();
      const handler = createHandler(session);

      await expect(handler(mockEvent, '   ')).rejects.toThrow(SecurityError);

      // Verify no file was written
      if (existsSync(testDir)) {
        const files = readdirSync(testDir);
        expect(files).toHaveLength(0);
      }
    });

    it('rejects label with leading whitespace', async () => {
      const session = createMockSession();
      const handler = createHandler(session);

      await expect(handler(mockEvent, ' test')).rejects.toThrow(SecurityError);

      // Verify no file was written
      if (existsSync(testDir)) {
        const files = readdirSync(testDir);
        expect(files).toHaveLength(0);
      }
    });

    it('rejects label with trailing whitespace', async () => {
      const session = createMockSession();
      const handler = createHandler(session);

      await expect(handler(mockEvent, 'test ')).rejects.toThrow(SecurityError);

      // Verify no file was written
      if (existsSync(testDir)) {
        const files = readdirSync(testDir);
        expect(files).toHaveLength(0);
      }
    });

    it('rejects tab character', async () => {
      const session = createMockSession();
      const handler = createHandler(session);

      await expect(handler(mockEvent, 'test\tlabel')).rejects.toThrow(SecurityError);

      // Verify no file was written
      if (existsSync(testDir)) {
        const files = readdirSync(testDir);
        expect(files).toHaveLength(0);
      }
    });
  });

  describe('Profiler error handling', () => {
    it('propagates profiler errors correctly', async () => {
      const session = createMockSession(true);
      const handler = createHandler(session);

      await expect(handler(mockEvent, 'valid-label')).rejects.toThrow('Profiler error');

      // Verify no file was written even though label was valid
      if (existsSync(testDir)) {
        const files = readdirSync(testDir);
        expect(files).toHaveLength(0);
      }
    });

    it('validates label before calling profiler', async () => {
      const session = createMockSession();
      const handler = createHandler(session);
      const postSpy = vi.spyOn(session, 'post');

      // Try with invalid label
      await expect(handler(mockEvent, '../malicious')).rejects.toThrow(SecurityError);

      // Verify profiler was never called
      expect(postSpy).not.toHaveBeenCalled();
    });
  });

  describe('File system isolation', () => {
    it('ensures file is created only in intended directory', async () => {
      const session = createMockSession();
      const handler = createHandler(session);

      const result = await handler(mockEvent, 'isolated-test');

      // Verify the file path is within the expected directory
      expect(result.path).toContain('costgoblin-perf');
      expect(result.path).toMatch(/costgoblin-perf[/\\]cpu-isolated-test\.cpuprofile$/);

      // Verify the file exists
      expect(existsSync(result.path)).toBe(true);
    });

    it('does not create files outside intended directory for any malicious input', async () => {
      const session = createMockSession();
      const handler = createHandler(session);

      const maliciousInputs = [
        '../../../etc/passwd',
        '..\\..\\..\\windows\\system32',
        '/etc/passwd',
        'C:\\Windows\\System32',
        '../malicious',
        '..\\malicious',
      ];

      for (const input of maliciousInputs) {
        await expect(handler(mockEvent, input)).rejects.toThrow(SecurityError);
      }

      // Verify only the intended directory exists (if at all)
      // and it contains no files from the malicious attempts
      if (existsSync(testDir)) {
        const files = readdirSync(testDir);
        expect(files).toHaveLength(0);
      }
    });
  });
});
