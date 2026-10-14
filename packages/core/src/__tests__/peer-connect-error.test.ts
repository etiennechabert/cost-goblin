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

  it('keeps the plain message on other platforms and for other failures', () => {
    expect(describePeerConnectError([connectError('EHOSTUNREACH')], 'win32')).toBe(
      'connect EHOSTUNREACH 192.168.0.28:53178 - Local (192.168.0.251:49169)',
    );
    expect(describePeerConnectError([connectError('ECONNREFUSED')], 'darwin')).toBe(
      'connect ECONNREFUSED 192.168.0.28:53178 - Local (192.168.0.251:49169)',
    );
    expect(describePeerConnectError([new Error('Peer request timed out')], 'darwin')).toBe('Peer request timed out');
    expect(describePeerConnectError(['boom'], 'darwin')).toBe('boom');
    expect(describePeerConnectError([], 'darwin')).toBe('no host to connect to');
  });
});
