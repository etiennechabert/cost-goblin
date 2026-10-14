/** Sharing only works between machines that can reach each other directly.
 *  Across networks that takes a VPN both are on; Tailscale is the one that
 *  needs no setup here — its address is a regular interface address, so the
 *  publisher's key lists it as soon as Tailscale is up. */
const REMOTE_HINT =
  'Not on the same network as your teammate? Connect both computers to Tailscale, then copy their sharing key again — it picks up the Tailscale address on its own.';

/** The text shown when none of a sharing key's hosts can be reached: the
 *  last host's error, then what to try.
 *
 *  macOS Local Network privacy refuses a blocked app's LAN connections with
 *  EHOSTUNREACH, the same error as a host that is really off the network, so on
 *  macOS any attempt failing that way also names the setting to check — even
 *  when a later host (a VPN or container address) failed differently. */
export function describePeerConnectError(errors: readonly unknown[], platform: NodeJS.Platform): string {
  const message = errors.length === 0 ? 'no host to connect to' : errorText(errors[errors.length - 1]);
  if (platform !== 'darwin' || !errors.some((err) => hasCode(err, 'EHOSTUNREACH'))) return `${message}. ${REMOTE_HINT}`;
  return `${message}. If your teammate is on this network, macOS may be blocking CostGoblin from it: allow CostGoblin in System Settings › Privacy & Security › Local Network, then restart CostGoblin. ${REMOTE_HINT}`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function hasCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === code;
}
