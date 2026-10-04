import { findGcloudCli, gcloudChildPath, gcloudSpawnShape } from '@costgoblin/core';

/** One home for "run a read-only gcloud command and capture its output" —
 *  the wizard's project list and the "Signed in as" panel's config read.
 *  The binary comes from the trusted-install resolver (never a bare-name
 *  PATH lookup), the spawn shape from `gcloudSpawnShape` (the CVE-2024-27980
 *  recipe), and the child PATH from `gcloudChildPath` (trusted SDK dirs
 *  first). The child inherits the process env, so an e2e launch's
 *  cloud-sandbox pins (`CLOUDSDK_CONFIG` etc.) apply here exactly as they do
 *  to the sync's rsync.
 *
 *  stdin is ignored: a gcloud that wants interactive input (a re-auth or
 *  first-run prompt) must fail on the timeout rather than block forever. */

export type GcloudCaptureResult =
  /** Not installed in any trusted location — or the spawn reported ENOENT,
   *  the race where it vanished after resolution. On Windows the `.cmd`
   *  needs a shell, which starts whether or not gcloud exists, so the
   *  resolver is the reliable signal there. */
  | { readonly kind: 'missing' }
  | { readonly kind: 'exited'; readonly code: number | null; readonly stdout: string; readonly stderr: string }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'failed'; readonly message: string };

export async function runGcloudCapture(args: readonly string[], timeoutMs: number): Promise<GcloudCaptureResult> {
  const bin = findGcloudCli();
  if (bin === null) return { kind: 'missing' };
  const { spawn } = await import('node:child_process');
  const { StringDecoder } = await import('node:string_decoder');
  let shape: ReturnType<typeof gcloudSpawnShape>;
  try {
    shape = gcloudSpawnShape(bin, args);
  } catch (err: unknown) {
    return { kind: 'failed', message: err instanceof Error ? err.message : String(err) };
  }

  return new Promise<GcloudCaptureResult>((resolve) => {
    const proc = spawn(shape.command, shape.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: shape.shell,
      env: { ...process.env, PATH: gcloudChildPath(process.env['PATH'] ?? '') },
    });
    // StringDecoder, not chunk.toString(): a pipe boundary can fall mid
    // multi-byte character, and two halves each decode to U+FFFD.
    const outDecoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: GcloudCaptureResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      proc.kill();
      finish({ kind: 'timeout' });
    }, timeoutMs);

    proc.stdout.on('data', (chunk: Buffer) => { stdout += outDecoder.write(chunk); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += errDecoder.write(chunk); });
    proc.on('error', (err: NodeJS.ErrnoException) => {
      finish(err.code === 'ENOENT' ? { kind: 'missing' } : { kind: 'failed', message: err.message });
    });
    proc.on('close', (code) => {
      stdout += outDecoder.end();
      stderr += errDecoder.end();
      finish({ kind: 'exited', code, stdout, stderr });
    });
  });
}
