/** The text shown when none of a sharing key's hosts can be reached: the last
 *  attempt's error, as before.
 *
 *  macOS Local Network privacy refuses a blocked app's LAN connections with
 *  EHOSTUNREACH, the same error as a host that is really off the network, so on
 *  macOS any attempt failing that way also names the setting to check — even
 *  when a later host (a VPN or container address) failed differently. */
export function describePeerConnectError(errors: readonly unknown[], platform: NodeJS.Platform): string {
  const message = errors.length === 0 ? 'no host to connect to' : errorText(errors[errors.length - 1]);
  if (platform !== 'darwin' || !errors.some((err) => hasCode(err, 'EHOSTUNREACH'))) return message;
  return `${message}. If your teammate is on this network, macOS may be blocking CostGoblin from it: allow CostGoblin in System Settings › Privacy & Security › Local Network, then restart CostGoblin.`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function hasCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === code;
}
