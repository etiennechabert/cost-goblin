import { beforeEach, describe, expect, it, vi } from 'vitest';
import { lookupAuthorizedUserEmail } from '../main/gcp-identity.js';

/** Stand-in for google-auth-library's UserRefreshClient: the refresh result
 *  (`credentials`) and tokeninfo answer are set per test, and every
 *  construction and tokeninfo call is recorded. No network. */
interface FakeRefresh {
  token: string | null;
  credentials: { id_token?: string; scope?: string };
  tokenInfoEmail: string | undefined;
}

const { state, constructed, tokenInfoCalls } = vi.hoisted(() => {
  const current: FakeRefresh = { token: 'ya29.fake', credentials: {}, tokenInfoEmail: undefined };
  const constructed: unknown[] = [];
  const tokenInfoCalls: string[] = [];
  return { state: { current }, constructed, tokenInfoCalls };
});

vi.mock('google-auth-library', () => ({
  UserRefreshClient: class {
    credentials: { id_token?: string; scope?: string } = {};
    constructor(options: unknown) { constructed.push(options); }
    getAccessToken(): Promise<{ token: string | null }> {
      this.credentials = state.current.credentials;
      return Promise.resolve({ token: state.current.token });
    }
    getTokenInfo(token: string): Promise<{ email?: string; scopes: string[] }> {
      tokenInfoCalls.push(token);
      const email = state.current.tokenInfoEmail;
      return Promise.resolve(email === undefined ? { scopes: [] } : { email, scopes: [] });
    }
  },
}));

function jwt(payload: unknown): string {
  const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'RS256' })}.${part(payload)}.sig`;
}

const SECRET = { clientId: 'cid', clientSecret: 'FAKE-SECRET', refreshToken: 'FAKE-REFRESH' };

describe('lookupAuthorizedUserEmail', () => {
  beforeEach(() => {
    constructed.length = 0;
    tokenInfoCalls.length = 0;
    state.current = { token: 'ya29.fake', credentials: {}, tokenInfoEmail: undefined };
  });

  it('reads the email from the refresh s id_token, with no second round trip', async () => {
    state.current.credentials = { id_token: jwt({ email: 'alice@acme.com' }), scope: 'openid https://www.googleapis.com/auth/userinfo.email' };
    expect(await lookupAuthorizedUserEmail(SECRET)).toEqual({ status: 'known', email: 'alice@acme.com' });
    expect(tokenInfoCalls).toEqual([]);
  });

  it('bounds every request with gaxios timeout, so a stall is aborted rather than abandoned', async () => {
    await lookupAuthorizedUserEmail(SECRET);
    expect(constructed[0]).toMatchObject({ clientId: 'cid', refreshToken: 'FAKE-REFRESH', transporterOptions: { timeout: expect.any(Number) } });
  });

  it('answers not-recorded without tokeninfo when the granted scopes cannot name the account', async () => {
    // The impersonated-ADC source: cloud-platform only.
    state.current.credentials = { scope: 'https://www.googleapis.com/auth/cloud-platform' };
    expect(await lookupAuthorizedUserEmail(SECRET)).toEqual({ status: 'unknown', reason: 'not-recorded' });
    expect(tokenInfoCalls).toEqual([]);
  });

  it('falls back to tokeninfo when the refresh did not say what it granted', async () => {
    state.current.tokenInfoEmail = 'bob@acme.com';
    expect(await lookupAuthorizedUserEmail(SECRET)).toEqual({ status: 'known', email: 'bob@acme.com' });
    expect(tokenInfoCalls).toEqual(['ya29.fake']);
  });

  it('answers not-recorded when tokeninfo names no one, and expired when no token was minted', async () => {
    expect(await lookupAuthorizedUserEmail(SECRET)).toEqual({ status: 'unknown', reason: 'not-recorded' });
    state.current.token = null;
    expect(await lookupAuthorizedUserEmail(SECRET)).toEqual({ status: 'unknown', reason: 'expired' });
  });
});
