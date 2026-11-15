import { createServer } from 'node:net';

/** A port nothing listens on right now (bound to 0, then released). A fixed
 *  port collides with the same suite running in another checkout at the same time. */
export async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => { probe.listen(0, '127.0.0.1', resolve); });
  const address = probe.address();
  await new Promise<void>((resolve) => { probe.close(() => { resolve(); }); });
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}
