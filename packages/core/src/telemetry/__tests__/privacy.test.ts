import { describe, it, expect } from 'vitest';
import {
  redactCostValue,
  redactAccountId,
  redactTagValue,
  redactDimensionValue,
  sanitizeString,
  sanitizeErrorMessage,
  sanitizeStackTrace,
  sanitizeTelemetryPayload,
  sanitizeError,
  createSanitizedPayload,
} from '../privacy.js';
import { asDollars, asTagValue } from '../../types/branded.js';

describe('redactCostValue', () => {
  it('redacts Dollars branded type', () => {
    const cost = asDollars(123.45);
    expect(redactCostValue(cost)).toBe('[REDACTED_COST]');
  });

  it('redacts numeric values', () => {
    expect(redactCostValue(999.99)).toBe('[REDACTED_COST]');
    expect(redactCostValue(0)).toBe('[REDACTED_COST]');
    expect(redactCostValue(-100.5)).toBe('[REDACTED_COST]');
  });
});

describe('redactAccountId', () => {
  it('redacts string account IDs', () => {
    expect(redactAccountId('123456789012')).toBe('[REDACTED_ACCOUNT]');
    expect(redactAccountId('aws-account-123')).toBe('[REDACTED_ACCOUNT]');
  });

  it('redacts numeric account IDs', () => {
    expect(redactAccountId(123456789012)).toBe('[REDACTED_ACCOUNT]');
  });
});

describe('redactTagValue', () => {
  it('redacts TagValue branded type', () => {
    const tag = asTagValue('my-team-name');
    expect(redactTagValue(tag)).toBe('[REDACTED_TAG]');
  });

  it('redacts string tag values', () => {
    expect(redactTagValue('production')).toBe('[REDACTED_TAG]');
    expect(redactTagValue('engineering-team')).toBe('[REDACTED_TAG]');
  });
});

describe('redactDimensionValue', () => {
  it('redacts dimension values', () => {
    expect(redactDimensionValue('us-east-1')).toBe('[REDACTED_DIMENSION]');
    expect(redactDimensionValue('EC2-Instances')).toBe('[REDACTED_DIMENSION]');
  });
});

describe('sanitizeString', () => {
  it('removes AWS account IDs', () => {
    const input = 'Error in account 123456789012';
    expect(sanitizeString(input)).toBe('Error in account [REDACTED_ACCOUNT]');
  });

  it('removes multiple account IDs', () => {
    const input = 'Accounts: 123456789012, 987654321098, 111111111111';
    const expected = 'Accounts: [REDACTED_ACCOUNT], [REDACTED_ACCOUNT], [REDACTED_ACCOUNT]';
    expect(sanitizeString(input)).toBe(expected);
  });

  it('removes Windows file paths', () => {
    const input = 'File not found: C:\\Users\\alice\\Documents\\config.yaml';
    expect(sanitizeString(input)).toBe('File not found: [REDACTED_PATH]');
  });

  it('removes Unix file paths', () => {
    const input = 'Config at /home/alice/.costgoblin/config.yaml';
    expect(sanitizeString(input)).toBe('Config at [REDACTED_PATH]');
  });

  it('removes macOS file paths', () => {
    const input = 'Loading from /Users/alice/Library/Application Support/CostGoblin';
    expect(sanitizeString(input)).toBe('Loading from [REDACTED_PATH]');
  });

  it('handles mixed sensitive data', () => {
    const input = 'Account 123456789012 config at C:\\Users\\bob\\config.yaml failed';
    const expected = 'Account [REDACTED_ACCOUNT] config at [REDACTED_PATH] failed';
    expect(sanitizeString(input)).toBe(expected);
  });

  it('preserves safe strings', () => {
    const input = 'Query executed successfully in 45ms';
    expect(sanitizeString(input)).toBe(input);
  });
});

describe('sanitizeErrorMessage', () => {
  it('sanitizes error messages with account IDs', () => {
    const message = 'Failed to sync account 123456789012';
    expect(sanitizeErrorMessage(message)).toBe('Failed to sync account [REDACTED_ACCOUNT]');
  });

  it('sanitizes error messages with file paths', () => {
    const message = 'Cannot read /home/user/.config/costgoblin.yaml';
    expect(sanitizeErrorMessage(message)).toBe('Cannot read [REDACTED_PATH]');
  });
});

describe('sanitizeStackTrace', () => {
  it('removes file paths from stack trace', () => {
    const stack = `Error: Failed to load
    at loadConfig (C:\\Users\\alice\\app\\config.js:42:10)
    at main (C:\\Users\\alice\\app\\main.js:15:5)`;

    const sanitized = sanitizeStackTrace(stack);
    expect(sanitized).not.toContain('C:\\Users\\alice');
    expect(sanitized).toContain('[REDACTED_PATH]');
  });

  it('removes account IDs from stack trace context', () => {
    const stack = `Error: Account 123456789012 not found
    at validateAccount (src/validate.js:10:15)`;

    const sanitized = sanitizeStackTrace(stack);
    expect(sanitized).not.toContain('123456789012');
    expect(sanitized).toContain('[REDACTED_ACCOUNT]');
  });
});

describe('sanitizeTelemetryPayload', () => {
  it('preserves safe primitive values', () => {
    expect(sanitizeTelemetryPayload('safe string')).toBe('safe string');
    expect(sanitizeTelemetryPayload(42)).toBe(42);
    expect(sanitizeTelemetryPayload(true)).toBe(true);
    expect(sanitizeTelemetryPayload(null)).toBe(null);
    expect(sanitizeTelemetryPayload(undefined)).toBe(undefined);
  });

  it('sanitizes strings with sensitive data', () => {
    const input = 'Account 123456789012 at C:\\Users\\alice\\config';
    const output = sanitizeTelemetryPayload(input);
    expect(output).toBe('Account [REDACTED_ACCOUNT] at [REDACTED_PATH]');
  });

  it('redacts cost fields in objects', () => {
    const payload = {
      count: 10,
      cost: 123.45,
      amount: 67.89,
      total: 999.99,
    };

    const sanitized = sanitizeTelemetryPayload(payload);
    expect(sanitized).toEqual({
      count: 10,
      cost: '[REDACTED_COST]',
      amount: '[REDACTED_COST]',
      total: '[REDACTED_COST]',
    });
  });

  it('redacts account fields in objects', () => {
    const payload = {
      viewName: 'dashboard',
      account: '123456789012',
      accountId: '987654321098',
    };

    const sanitized = sanitizeTelemetryPayload(payload);
    expect(sanitized).toEqual({
      viewName: 'dashboard',
      account: '[REDACTED_ACCOUNT]',
      accountId: '[REDACTED_ACCOUNT]',
    });
  });

  it('redacts tag fields in objects', () => {
    const payload = {
      filterCount: 2,
      tag: 'my-team',
      tagValue: 'engineering',
      tags: ['team-a', 'team-b'],
    };

    const sanitized = sanitizeTelemetryPayload(payload);
    expect(sanitized).toEqual({
      filterCount: 2,
      tag: '[REDACTED_TAG]',
      tagValue: '[REDACTED_TAG]',
      tags: '[REDACTED_TAG]',
    });
  });

  it('redacts dimension fields in objects', () => {
    const payload = {
      dimensionCount: 5,
      dimension: 'region',
      dimensionValue: 'us-east-1',
      entity: 'some-entity',
    };

    const sanitized = sanitizeTelemetryPayload(payload);
    expect(sanitized).toEqual({
      dimensionCount: 5,
      dimension: '[REDACTED_DIMENSION]',
      dimensionValue: '[REDACTED_DIMENSION]',
      entity: '[REDACTED_DIMENSION]',
    });
  });

  it('preserves safe field names', () => {
    const payload = {
      count: 42,
      rowCount: 100,
      dimensionCount: 5,
      filterCount: 3,
      duration: 1500,
      timestamp: '2026-04-30T12:00:00Z',
      status: 'success',
      enabled: true,
      viewName: 'cost-overview',
    };

    const sanitized = sanitizeTelemetryPayload(payload);
    expect(sanitized).toEqual(payload);
  });

  it('handles nested objects', () => {
    const payload = {
      event: 'query_executed',
      metadata: {
        count: 50,
        cost: 123.45,
        filters: {
          account: '123456789012',
          tag: 'my-team',
        },
      },
    };

    const sanitized = sanitizeTelemetryPayload(payload);
    expect(sanitized).toEqual({
      event: 'query_executed',
      metadata: {
        count: 50,
        cost: '[REDACTED_COST]',
        filters: {
          account: '[REDACTED_ACCOUNT]',
          tag: '[REDACTED_TAG]',
        },
      },
    });
  });

  it('handles arrays', () => {
    const payload = {
      counts: [10, 20, 30],
      costs: [100, 200, 300],
    };

    const sanitized = sanitizeTelemetryPayload(payload);
    expect(sanitized).toEqual({
      counts: [10, 20, 30],
      costs: '[REDACTED_COST]',
    });
  });

  it('handles arrays of objects', () => {
    const payload = [
      { name: 'view1', count: 10 },
      { name: 'view2', cost: 50.00 },
    ];

    const sanitized = sanitizeTelemetryPayload(payload);
    expect(sanitized).toEqual([
      { name: 'view1', count: 10 },
      { name: 'view2', cost: '[REDACTED_COST]' },
    ]);
  });

  it('prevents infinite recursion with maxDepth', () => {
    const payload = {
      level1: {
        level2: {
          level3: {
            level4: {
              level5: {
                level6: {
                  level7: {
                    level8: {
                      level9: {
                        level10: {
                          level11: 'too deep',
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    const sanitized = sanitizeTelemetryPayload(payload);
    expect(JSON.stringify(sanitized)).toContain('[MAX_DEPTH_EXCEEDED]');
  });

  it('skips __brand properties from branded types', () => {
    const payload = {
      name: 'test',
      __brand: 'TagValue',
    };

    const sanitized = sanitizeTelemetryPayload(payload);
    expect(sanitized).toEqual({ name: 'test' });
    expect((sanitized as Record<string, unknown>)['__brand']).toBeUndefined();
  });

  it('handles unsupported types', () => {
    const payload = {
      func: () => 'test',
      symbol: Symbol('test'),
    };

    const sanitized = sanitizeTelemetryPayload(payload);
    expect(sanitized).toEqual({
      func: '[UNSUPPORTED_TYPE]',
      symbol: '[UNSUPPORTED_TYPE]',
    });
  });
});

describe('sanitizeError', () => {
  it('sanitizes Error objects', () => {
    const error = new Error('Account 123456789012 sync failed at C:\\Users\\alice\\app');
    error.stack = `Error: Account 123456789012 sync failed at C:\\Users\\alice\\app
    at sync (C:\\Users\\alice\\app\\sync.js:10:5)`;

    const sanitized = sanitizeError(error);

    expect(sanitized.name).toBe('Error');
    expect(sanitized.message).toBe('Account [REDACTED_ACCOUNT] sync failed at [REDACTED_PATH]');
    expect(sanitized.stack).not.toContain('123456789012');
    expect(sanitized.stack).not.toContain('C:\\Users\\alice');
  });

  it('handles Error without stack trace', () => {
    const error = new Error('Test error');
    delete error.stack;

    const sanitized = sanitizeError(error);

    expect(sanitized.name).toBe('Error');
    expect(sanitized.message).toBe('Test error');
    expect(sanitized.stack).toBeUndefined();
  });

  it('preserves error type', () => {
    class CustomError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'CustomError';
      }
    }

    const error = new CustomError('Custom error occurred');
    const sanitized = sanitizeError(error);

    expect(sanitized.name).toBe('CustomError');
  });
});

describe('createSanitizedPayload', () => {
  it('creates sanitized payload from object', () => {
    const data = {
      event: 'query_executed',
      count: 42,
      cost: 123.45,
      account: '123456789012',
    };

    const sanitized = createSanitizedPayload(data);

    expect(sanitized).toEqual({
      event: 'query_executed',
      count: 42,
      cost: '[REDACTED_COST]',
      account: '[REDACTED_ACCOUNT]',
    });
  });

  it('handles empty objects', () => {
    const sanitized = createSanitizedPayload({});
    expect(sanitized).toEqual({});
  });

  it('ensures readonly return type', () => {
    const data = { count: 10 };
    const sanitized = createSanitizedPayload(data);

    // TypeScript should enforce readonly - this is compile-time check
    // At runtime, verify it's a plain object
    expect(typeof sanitized).toBe('object');
    expect(sanitized).not.toBeNull();
  });
});

describe('privacy filters integration', () => {
  it('prevents PII leakage in realistic analytics event', () => {
    const analyticsEvent = {
      eventType: 'query_executed',
      timestamp: '2026-04-30T12:00:00Z',
      view: 'cost-overview',
      filters: {
        account: '123456789012',
        tag: 'engineering-team',
        region: 'us-east-1',
      },
      results: {
        rowCount: 150,
        totalCost: 45678.90,
        dimensionCount: 5,
      },
      duration: 1250,
    };

    const sanitized = createSanitizedPayload(analyticsEvent);

    // Verify safe fields preserved
    expect(sanitized).toMatchObject({
      eventType: 'query_executed',
      timestamp: '2026-04-30T12:00:00Z',
      view: 'cost-overview',
      duration: 1250,
    });

    // Verify sensitive fields redacted
    const sanitizedObj = sanitized as Record<string, unknown>;
    const filters = sanitizedObj.filters as Record<string, unknown>;
    expect(filters.account).toBe('[REDACTED_ACCOUNT]');
    expect(filters.tag).toBe('[REDACTED_TAG]');
    expect(filters.region).toBe('[REDACTED_DIMENSION]');

    const results = sanitizedObj.results as Record<string, unknown>;
    expect(results.rowCount).toBe(150);
    expect(results.totalCost).toBe('[REDACTED_COST]');
    expect(results.dimensionCount).toBe(5);
  });

  it('prevents PII leakage in realistic crash report', () => {
    const error = new Error('Query failed for account 123456789012');
    error.stack = `Error: Query failed for account 123456789012
    at executeQuery (C:\\Users\\alice\\CostGoblin\\query.js:45:12)
    at handleRequest (/home/alice/.costgoblin/main.js:89:20)`;

    const crashReport = {
      eventType: 'error',
      error: sanitizeError(error),
      context: {
        view: 'cost-overview',
        account: '123456789012',
        filters: {
          tag: 'my-team',
          cost: 1000.50,
        },
      },
    };

    const sanitized = createSanitizedPayload(crashReport);
    const sanitizedObj = sanitized as Record<string, unknown>;

    // Verify error sanitized
    const errorObj = sanitizedObj.error as Record<string, unknown>;
    expect(errorObj.message).not.toContain('123456789012');
    expect(errorObj.stack).not.toContain('C:\\Users\\alice');
    expect(errorObj.stack).not.toContain('/home/alice');

    // Verify context sanitized
    const context = sanitizedObj.context as Record<string, unknown>;
    expect(context.view).toBe('cost-overview');
    expect(context.account).toBe('[REDACTED_ACCOUNT]');

    const filters = context.filters as Record<string, unknown>;
    expect(filters.tag).toBe('[REDACTED_TAG]');
    expect(filters.cost).toBe('[REDACTED_COST]');
  });
});
