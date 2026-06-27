import { describe, it, expect } from 'vitest';
import type { Event } from '@sentry/electron/main';
import { redactEventInPlace } from '../main/telemetry/scrub-event.js';

/** A maximal event touching every field redactEventInPlace handles, seeded with
 *  values that MUST be scrubbed (paths, account IDs, ARNs, S3 URIs, emails,
 *  dollar amounts, secret-keyed data). */
function sampleEvent(): Event {
  return {
    message: 'failed for s3://acme-billing/cur and account 123456789012',
    transaction: 'op /Users/jane/x',
    logentry: { message: 'user jane@x.io', params: ['arn:aws:iam::123456789012:role/Admin', 7] },
    fingerprint: ['jane@x.io', 'grp'],
    user: { id: '1', email: 'jane@x.io' },
    request: { url: 'https://x/y' },
    server_name: 'janes-macbook',
    extra: { leaked: 'secret' },
    exception: {
      values: [
        {
          type: 'Error',
          value: 'cost was $1,234.00',
          stacktrace: {
            frames: [
              {
                filename: '/Users/jane/app.ts',
                abs_path: '/Users/jane/app.ts',
                context_line: 'const id = 123456789012',
                vars: { sql: 'SELECT * FROM cur' },
                pre_context: ['before'],
                post_context: ['after'],
              },
            ],
          },
        },
      ],
    },
    threads: { values: [{ stacktrace: { frames: [{ abs_path: '/Users/bob/x.ts', vars: { y: 1 } }] } }] },
    spans: [
      {
        data: {
          'db.statement': 's3://acme-billing/x',
          token: 'abc',
          'http.request.header.x-account': ['123456789012'],
          'http.status_code': 200,
        },
        description: 'query /Users/jane/cur.parquet',
        span_id: 's1',
        start_timestamp: 0,
        trace_id: 't1',
      },
    ],
    breadcrumbs: [{ message: 'charged $5.00', data: { token: 'sekret', path: '/Users/jane/x' } }],
    tags: { account_id: '123456789012', region: 'path /Users/jane' },
    contexts: {
      os: { name: 'macOS' },
      device: { name: 'janes-host' },
      trace: { span_id: 's', trace_id: 't', data: { 'db.statement': 's3://acme/x' } },
    },
  };
}

describe('redactEventInPlace', () => {
  it('drops direct-identifier / machine-detail fields wholesale', () => {
    const ev = sampleEvent();
    redactEventInPlace(ev);
    expect(ev.user).toBeUndefined();
    expect(ev.request).toBeUndefined();
    expect(ev.server_name).toBeUndefined();
    expect(ev.extra).toBeUndefined();
  });

  it('scrubs free-text, logentry params and fingerprints', () => {
    const ev = sampleEvent();
    redactEventInPlace(ev);
    expect(ev.message).toBe('failed for s3://[redacted] and account [redacted-account]');
    expect(ev.transaction).toBe('op /Users/[user]/x');
    expect(ev.logentry?.message).toBe('user [redacted-email]');
    expect(ev.logentry?.params?.[0]).toBe('[redacted-arn]');
    expect(ev.logentry?.params?.[1]).toBe(7);
    expect(ev.fingerprint).toStrictEqual(['[redacted-email]', 'grp']);
  });

  it('scrubs exception value + frames and drops vars/pre/post context', () => {
    const ev = sampleEvent();
    redactEventInPlace(ev);
    const frame = ev.exception?.values?.[0]?.stacktrace?.frames?.[0];
    expect(ev.exception?.values?.[0]?.value).toBe('cost was [redacted-amount]');
    expect(frame?.filename).toBe('/Users/[user]/app.ts');
    expect(frame?.abs_path).toBe('/Users/[user]/app.ts');
    expect(frame?.context_line).toBe('const id = [redacted-account]');
    expect(frame?.vars).toBeUndefined();
    expect(frame?.pre_context).toBeUndefined();
    expect(frame?.post_context).toBeUndefined();
  });

  it('scrubs THREAD stack frames too (not just exception frames)', () => {
    const ev = sampleEvent();
    redactEventInPlace(ev);
    const frame = ev.threads?.values[0]?.stacktrace?.frames?.[0];
    expect(frame?.abs_path).toBe('/Users/[user]/x.ts');
    expect(frame?.vars).toBeUndefined();
  });

  it('scrubs transaction span description and data', () => {
    const ev = sampleEvent();
    redactEventInPlace(ev);
    const span = ev.spans?.[0];
    expect(span?.description).toBe('query /Users/[user]/cur.parquet');
    expect(span?.data['db.statement']).toBe('s3://[redacted]');
    expect(span?.data['token']).toBe('[redacted]');
    // Array/object span attributes can hide PII (an account ID in a header array)
    // and can't be string-scrubbed, so they're dropped wholesale; plain numbers
    // pass through untouched.
    expect(span?.data['http.request.header.x-account']).toBe('[redacted]');
    expect(span?.data['http.status_code']).toBe(200);
  });

  it('scrubs breadcrumb message and deep-redacts breadcrumb data', () => {
    const ev = sampleEvent();
    redactEventInPlace(ev);
    const crumb = ev.breadcrumbs?.[0];
    expect(crumb?.message).toBe('charged [redacted-amount]');
    expect(crumb?.data?.['token']).toBe('[redacted]');
    expect(crumb?.data?.['path']).toBe('/Users/[user]/x');
  });

  it('drops secret-keyed tags and pattern-scrubs the rest', () => {
    const ev = sampleEvent();
    redactEventInPlace(ev);
    expect(ev.tags?.['account_id']).toBe('[redacted]');
    expect(ev.tags?.['region']).toBe('path /Users/[user]');
  });

  it('allowlists contexts and deep-redacts the kept trace context', () => {
    const ev = sampleEvent();
    redactEventInPlace(ev);
    expect(ev.contexts?.['os']).toBeDefined();
    expect(ev.contexts?.['device']).toBeUndefined();
    expect(ev.contexts?.['trace']?.['data']).toStrictEqual({ 'db.statement': 's3://[redacted]' });
  });
});
