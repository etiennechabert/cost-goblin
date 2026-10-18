import { describe, it, expect } from 'vitest';
import { firstReachable } from '../peer/first-reachable.js';
import { generateIdentityKeyPair, PeerIdentityError, signBytes, verifyBytes } from '../peer/identity.js';
import { parseSharingKey, SharingKeyError } from '../peer/sharing-key.js';

/** Malformed key material from a peer must fail with the peer module's own
 *  error types, never verify, and never be mistaken for something else. */

const DATA = Buffer.from('signed manifest bytes');

describe('verifyBytes with a malformed publisher key', () => {
  const signer = generateIdentityKeyPair();
  const signature = signBytes(signer.privateKey, DATA);

  it.each([
    ['empty', ''],
    ['too short to decode', 'abc'],
    ['31 bytes', Buffer.alloc(31, 7).toString('base64url')],
    ['33 bytes', Buffer.alloc(33, 7).toString('base64url')],
  ])('throws a PeerIdentityError for a key that is %s', (_label, publicKey) => {
    let caught: unknown;
    try {
      verifyBytes(publicKey, DATA, signature);
    } catch (err: unknown) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PeerIdentityError);
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toMatchObject({ name: 'PeerIdentityError', message: 'Invalid Ed25519 public key' });
  });

  it('returns false, without throwing, for a well-formed key that did not sign', () => {
    expect(verifyBytes(Buffer.alloc(32, 0xff).toString('base64url'), DATA, signature)).toBe(false);
    expect(verifyBytes(signer.publicKey, DATA, signature)).toBe(true);
  });
});

describe('parseSharingKey with a payload that is not an object', () => {
  const keyFor = (json: string): string => `CGSHARE1-${Buffer.from(json, 'utf-8').toString('base64url')}`;

  it.each(['[]', '[{"v":1}]', '42', '"CGSHARE1"', 'null', 'true'])('rejects a %s payload as malformed', (json) => {
    expect(() => parseSharingKey(keyFor(json))).toThrow(SharingKeyError);
    expect(() => parseSharingKey(keyFor(json))).toThrow(/^Sharing key payload is malformed\.$/);
  });
});

describe('firstReachable with a failure that no candidate caused', () => {
  it('rethrows it instead of reporting the candidates unreachable', async () => {
    // A candidate list that cannot even be read: the failure is not one
    // attempt's, so it must not be folded into an `unreachable` result.
    const candidates: string[] = [];
    Object.defineProperty(candidates, 0, {
      enumerable: true,
      get(): string {
        throw new Error('candidate list unavailable');
      },
    });
    const attempted: string[] = [];
    const attempt = (candidate: string): Promise<string> => {
      attempted.push(candidate);
      return Promise.resolve(candidate);
    };

    await expect(firstReachable(candidates, attempt)).rejects.toThrow('candidate list unavailable');
    expect(attempted).toEqual([]);
  });

  it('reports an empty candidate list as unreachable with no errors', async () => {
    const attempt = (candidate: string): Promise<string> => Promise.resolve(candidate);
    await expect(firstReachable([], attempt)).resolves.toEqual({ status: 'unreachable', errors: [] });
  });
});
