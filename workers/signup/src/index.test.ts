import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import worker from './index';

interface KvPut {
  readonly key: string;
  readonly value: string;
}

function makeFakeKv(): { get: (key: string) => Promise<string | null>; put: (key: string, value: string) => Promise<void>; puts: KvPut[] } {
  const store = new Map<string, string>();
  const puts: KvPut[] = [];
  return {
    puts,
    get: (key) => Promise.resolve(store.get(key) ?? null),
    put: (key, value) => {
      store.set(key, value);
      puts.push({ key, value });
      return Promise.resolve();
    },
  };
}

function signupRequest(body: Record<string, string>): Request {
  return new Request('https://costgoblin.com/api/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.7' },
    body: JSON.stringify(body),
  });
}

const validBody = { email: 'a@example.com', 'cf-turnstile-response': 'tok' };

let siteverifyCalls = 0;
let siteverifySuccess = true;
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  siteverifyCalls = 0;
  siteverifySuccess = true;
  vi.stubGlobal('fetch', () => {
    siteverifyCalls += 1;
    return Promise.resolve(
      new Response(JSON.stringify({ success: siteverifySuccess, 'error-codes': [] }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('signup worker: Turnstile secret missing fails closed', () => {
  const cases: ReadonlyArray<readonly [string, Record<string, string>]> = [
    ['unset', {}],
    ['empty', { TURNSTILE_SECRET_KEY: '' }],
  ];

  it.each(cases)('rejects with 503 when TURNSTILE_SECRET_KEY is %s', async (_label, secretEnv) => {
    const kv = makeFakeKv();
    const res = await worker.fetch(signupRequest(validBody), { SIGNUPS: kv, ...secretEnv });

    expect(res.status).toBe(503);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://costgoblin.com');
    const body: unknown = await res.json();
    expect(body).toMatchObject({ ok: false });
    expect(kv.puts).toHaveLength(0);
    expect(siteverifyCalls).toBe(0);
    expect(consoleError).toHaveBeenCalledWith(
      'signup: TURNSTILE_SECRET_KEY is not configured; rejecting request',
    );
  });
});

describe('signup worker: Turnstile secret configured', () => {
  it('stores the signup when siteverify succeeds', async () => {
    const kv = makeFakeKv();
    const res = await worker.fetch(signupRequest(validBody), { SIGNUPS: kv, TURNSTILE_SECRET_KEY: 'secret' });

    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(body).toEqual({ ok: true });
    expect(siteverifyCalls).toBe(1);
    expect(kv.puts.filter((p) => p.key === 'signup:a@example.com')).toHaveLength(1);
  });

  it('rejects with 403 and stores nothing when siteverify fails', async () => {
    siteverifySuccess = false;
    const kv = makeFakeKv();
    const res = await worker.fetch(signupRequest(validBody), { SIGNUPS: kv, TURNSTILE_SECRET_KEY: 'secret' });

    expect(res.status).toBe(403);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://costgoblin.com');
    expect(siteverifyCalls).toBe(1);
    expect(kv.puts.filter((p) => p.key.startsWith('signup:'))).toHaveLength(0);
  });
});

describe('signup worker: honeypot', () => {
  const cases: ReadonlyArray<readonly [string, Record<string, string>]> = [
    ['configured', { TURNSTILE_SECRET_KEY: 'secret' }],
    ['unset', {}],
  ];

  it.each(cases)('silently accepts a filled honeypot when the secret is %s', async (_label, secretEnv) => {
    const kv = makeFakeKv();
    const res = await worker.fetch(signupRequest({ ...validBody, website: 'http://spam.example' }), {
      SIGNUPS: kv,
      ...secretEnv,
    });

    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(body).toEqual({ ok: true });
    expect(kv.puts).toHaveLength(0);
    expect(siteverifyCalls).toBe(0);
  });
});
