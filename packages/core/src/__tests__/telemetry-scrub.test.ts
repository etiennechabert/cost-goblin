import { describe, it, expect } from 'vitest';
import { redactSensitiveString, isSensitiveKey, redactValueDeep, redactNumeric } from '../telemetry/scrub.js';

describe('redactSensitiveString', () => {
  it('redacts email addresses', () => {
    expect(redactSensitiveString('contact jane.doe@example.com now')).toBe('contact [redacted-email] now');
  });

  it('redacts 12-digit AWS account IDs', () => {
    expect(redactSensitiveString('account 123456789012 failed')).toBe('account [redacted-account] failed');
  });

  it('does not touch shorter or longer digit runs', () => {
    expect(redactSensitiveString('order 1234567 and 1234567890123')).toBe('order 1234567 and 1234567890123');
  });

  it('redacts a 12-digit account ID glued to letters or underscores', () => {
    expect(redactSensitiveString('table acct123456789012 missing')).toBe('table acct[redacted-account] missing');
    expect(redactSensitiveString('id_123456789012')).toBe('id_[redacted-account]');
  });

  it('redacts s3 URIs and ARNs', () => {
    expect(redactSensitiveString('s3://acme-billing/cur/2026.parquet')).toBe('s3://[redacted]');
    expect(redactSensitiveString('arn:aws:iam::123456789012:role/Admin')).toBe('[redacted-arn]');
  });

  it('redacts dollar amounts', () => {
    expect(redactSensitiveString('spend was $1,234.56 last month')).toBe('spend was [redacted-amount] last month');
  });

  it('replaces the username segment of POSIX home paths but keeps shape', () => {
    expect(redactSensitiveString('/Users/jane/code/app.ts')).toBe('/Users/[user]/code/app.ts');
    expect(redactSensitiveString('/home/bob/.config/x')).toBe('/home/[user]/.config/x');
  });

  it('replaces the username segment of Windows home paths', () => {
    expect(redactSensitiveString('C:\\Users\\Jane\\app.ts')).toBe('C:\\Users\\[user]\\app.ts');
  });

  it('redacts every occurrence, not just the first', () => {
    expect(redactSensitiveString('123456789012 and 210987654321')).toBe('[redacted-account] and [redacted-account]');
  });

  it('leaves innocuous strings untouched', () => {
    expect(redactSensitiveString('TypeError: cannot read property of undefined')).toBe(
      'TypeError: cannot read property of undefined',
    );
  });
});

describe('isSensitiveKey', () => {
  it('flags secret-bearing keys case-insensitively', () => {
    for (const key of ['password', 'API_KEY', 'accessKey', 'Authorization', 'cookie', 'sessionToken', 'aws_secret', 'dsn', 'accountId', 'email', 'arn']) {
      expect(isSensitiveKey(key)).toBe(true);
    }
  });

  it('does not flag ordinary keys', () => {
    for (const key of ['service', 'region', 'level', 'timestamp', 'count']) {
      expect(isSensitiveKey(key)).toBe(false);
    }
  });
});

describe('redactValueDeep', () => {
  it('redacts strings inside nested objects and arrays', () => {
    const input = {
      note: 'paid $99.00',
      items: ['arn:aws:s3:::bucket', 'fine'],
      nested: { user: 'jane@x.io', ok: 1 },
    };
    expect(redactValueDeep(input)).toStrictEqual({
      note: 'paid [redacted-amount]',
      items: ['[redacted-arn]', 'fine'],
      // `user` isn't a secret-bearing key, but the email value is still caught
      // by pattern scrubbing.
      nested: { user: '[redacted-email]', ok: 1 },
    });
  });

  it('drops values under sensitive keys entirely', () => {
    expect(redactValueDeep({ token: 'abc', password: 'hunter2', keep: 'yes' })).toStrictEqual({
      token: '[redacted]',
      password: '[redacted]',
      keep: 'yes',
    });
  });

  it('preserves benign primitives and null/undefined', () => {
    expect(redactValueDeep(42)).toBe(42);
    expect(redactValueDeep(true)).toBe(true);
    expect(redactValueDeep(null)).toBeNull();
    expect(redactValueDeep(undefined)).toBeUndefined();
  });

  it('redacts a 12-digit account ID that arrives as a number', () => {
    expect(redactValueDeep(123456789012)).toBe('[redacted-account]');
    expect(redactValueDeep({ accountNum: 123456789012, count: 7 })).toStrictEqual({
      accountNum: '[redacted-account]',
      count: 7,
    });
  });

  it('fails closed past the depth limit', () => {
    // 8 levels deep — beyond MAX_DEPTH (6).
    let deep: unknown = 'leaf';
    for (let i = 0; i < 8; i++) deep = { next: deep };
    const result = redactValueDeep(deep);
    // Walk down and confirm the tail was replaced rather than forwarded.
    const json = JSON.stringify(result);
    expect(json).toContain('[redacted]');
    expect(json).not.toContain('leaf');
  });

  it('replaces exotic types (functions) rather than forwarding them', () => {
    expect(redactValueDeep({ fn: () => 1, ok: 'x' })).toStrictEqual({ fn: '[redacted]', ok: 'x' });
  });
});

describe('redactNumeric', () => {
  it('redacts account-ID-shaped numbers and keeps benign ones', () => {
    expect(redactNumeric(123456789012)).toBe('[redacted-account]');
    expect(redactNumeric(200)).toBe(200);
    expect(redactNumeric(0)).toBe(0);
    expect(redactNumeric(3.14)).toBe(3.14);
  });

  it('only redacts a clean 12-digit non-negative integer (no partial/float mangling)', () => {
    // A 12-digit integer part with a fraction must NOT be partially redacted.
    expect(redactNumeric(123456789012.5)).toBe(123456789012.5);
    // Negatives and other lengths are left alone.
    expect(redactNumeric(-123456789012)).toBe(-123456789012);
    expect(redactNumeric(12345678901)).toBe(12345678901); // 11 digits
    expect(redactNumeric(1234567890123)).toBe(1234567890123); // 13 digits
  });
});
