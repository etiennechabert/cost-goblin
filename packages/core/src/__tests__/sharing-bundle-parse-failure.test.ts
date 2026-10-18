import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { parseConfigBundle } from '../config/sharing-bundle.js';
import { ConfigValidationError } from '../config/validator.js';

// The yaml parser only throws Error subclasses, so the import path's
// fallback for anything else is reachable only through a stub. `parse` stays
// the real parser unless a test queues a failure with `...Once`.
vi.mock('yaml', async (importOriginal) => {
  const actual = await importOriginal<typeof import('yaml')>();
  return { ...actual, parse: vi.fn(actual.parse) };
});

/** The message of the ConfigValidationError `fn` throws; anything else fails the test. */
function configError(fn: () => unknown): string {
  try {
    fn();
  } catch (err: unknown) {
    if (err instanceof ConfigValidationError) return err.message;
    throw err;
  }
  throw new Error('expected a ConfigValidationError, but nothing was thrown');
}

/** What the real parser says about `content`. */
function parserMessage(content: string): string {
  try {
    parse(content);
  } catch (err: unknown) {
    if (err instanceof Error) return err.message;
    throw err;
  }
  throw new Error('expected the YAML parser to reject the content');
}

describe('parseConfigBundle: unparseable content', () => {
  it('passes the parser\'s own message through for a syntax error', () => {
    const content = '{not: yaml: at: all:';
    expect(configError(() => parseConfigBundle(content))).toBe(`Not valid YAML: ${parserMessage(content)}`);
  });

  it('reports a parser failure that is not an Error by its string form', () => {
    vi.mocked(parse).mockImplementationOnce(() => {
      const reason: unknown = 'parser ran out of memory';
      throw reason;
    });
    expect(configError(() => parseConfigBundle('kind: costgoblin-config-bundle\n'))).toBe('Not valid YAML: parser ran out of memory');
  });
});
