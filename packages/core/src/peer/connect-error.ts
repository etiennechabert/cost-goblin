/** The text shown when a sharing key's host cannot be reached.
 *
 *  macOS Local Network privacy refuses a blocked app's LAN connections with
 *  EHOSTUNREACH, the same error as a host that is really off the network, so on
 *  macOS that code also names the setting to check. */
export function describePeerConnectError(err: unknown, platform: NodeJS.Platform): string {
  const message = err instanceof Error ? err.message : String(err);
  if (platform !== 'darwin' || !hasCode(err, 'EHOSTUNREACH')) return message;
  return `${message}. If your teammate is on this network, macOS may be blocking CostGoblin from it: allow CostGoblin in System Settings › Privacy & Security › Local Network, then restart CostGoblin.`;
}

function hasCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === code;
}
