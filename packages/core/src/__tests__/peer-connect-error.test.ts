import { describe, expect, it } from 'vitest';
import { describePeerConnectError } from '../peer/connect-error.js';

function connectError(code: string, host = '192.168.0.28'): Error {
  return Object.assign(new Error(`connect ${code} ${host}:53178 - Local (192.168.0.251:49169)`), { code });
}

describe('describePeerConnectError', () => {
  it('points macOS users at Local Network privacy when the host is unreachable', () => {
    const text = describePeerConnectError([connectError('EHOSTUNREACH')], 'darwin');
    expect(text).toContain('connect EHOSTUNREACH 192.168.0.28:53178');
    expect(text).toContain('Privacy & Security › Local Network');
  });

  it('still points there when a later host of the key failed differently', () => {
    // A publisher on a VPN advertises its LAN address and its tunnel address;
    // the blocked LAN attempt is the one that explains the failure.
    const text = describePeerConnectError(
      [connectError('EHOSTUNREACH'), connectError('ECONNREFUSED', '100.64.0.1')],
      'darwin',
    );
    expect(text).toContain('connect ECONNREFUSED 100.64.0.1:53178');
    expect(text).toContain('Privacy & Security › Local Network');
  });

  it('adds no Local Network hint on other platforms or for other failures', () => {
    const cases: [unknown[], NodeJS.Platform, string][] = [
      [[connectError('EHOSTUNREACH')], 'win32', 'connect EHOSTUNREACH 192.168.0.28:53178 - Local (192.168.0.251:49169)'],
      [[connectError('ECONNREFUSED')], 'darwin', 'connect ECONNREFUSED 192.168.0.28:53178 - Local (192.168.0.251:49169)'],
      [[new Error('Peer request timed out')], 'darwin', 'Peer request timed out'],
      [['boom'], 'darwin', 'boom'],
      [[], 'darwin', 'no host to connect to'],
    ];
    for (const [errors, platform, message] of cases) {
      const text = describePeerConnectError(errors, platform);
      expect(text.startsWith(`${message}. `)).toBe(true);
      expect(text).not.toContain('Local Network');
    }
  });

  it('suggests Tailscale for a teammate on another network, on every platform', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const text = describePeerConnectError([connectError('ETIMEDOUT', '100.101.102.103')], platform);
      expect(text).toContain('Not on the same network as your teammate?');
      expect(text).toContain('Tailscale');
      expect(text.endsWith('.')).toBe(true);
    }
  });
});
