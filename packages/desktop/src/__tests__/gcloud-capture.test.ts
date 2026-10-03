import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runGcloudCapture } from '../main/gcloud-capture.js';

// The trusted-binary resolver is the only way a gcloud path reaches spawn;
// pointing it at a script stands in for the CLI without touching a real one.
const { mockFindGcloudCli } = vi.hoisted(() => ({
  mockFindGcloudCli: vi.fn((): string | null => null),
}));
vi.mock('@costgoblin/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@costgoblin/core')>()),
  findGcloudCli: mockFindGcloudCli,
}));

// POSIX shell scripts stand in for gcloud; on Windows gcloud is a `.cmd`
// spawned through cmd.exe, which these scripts cannot imitate.
describe.skipIf(process.platform === 'win32')('runGcloudCapture', () => {
  let dir = '';

  async function fakeGcloud(name: string, body: string): Promise<string> {
    const path = join(dir, name);
    await writeFile(path, `#!/bin/sh\n${body}\n`, 'utf8');
    await chmod(path, 0o755);
    return path;
  }

  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'gcloud-capture-')); });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
  beforeEach(() => { mockFindGcloudCli.mockReset(); });

  it('reports a CLI that is not installed in any trusted location, without spawning', async () => {
    mockFindGcloudCli.mockReturnValue(null);
    expect(await runGcloudCapture(['config', 'list'], 5_000)).toEqual({ kind: 'missing' });
  });

  it('captures stdout, stderr and the exit code, passing the arguments through', async () => {
    mockFindGcloudCli.mockReturnValue(await fakeGcloud('echo-args', 'echo "args:$*"; echo "café é" ; echo "warn" >&2; exit 0'));
    expect(await runGcloudCapture(['config', 'list', '--format=json'], 5_000)).toEqual({
      kind: 'exited',
      code: 0,
      stdout: 'args:config list --format=json\ncafé é\n',
      stderr: 'warn\n',
    });
  });

  it('reports a failing run with its exit code', async () => {
    mockFindGcloudCli.mockReturnValue(await fakeGcloud('fail', 'echo "ERROR: nope" >&2; exit 3'));
    expect(await runGcloudCapture([], 5_000)).toEqual({ kind: 'exited', code: 3, stdout: '', stderr: 'ERROR: nope\n' });
  });

  it('gives up on a gcloud that never answers', async () => {
    mockFindGcloudCli.mockReturnValue(await fakeGcloud('hang', 'sleep 5'));
    expect(await runGcloudCapture([], 100)).toEqual({ kind: 'timeout' });
  });

  it('treats a resolved path that vanished before spawn as missing', async () => {
    mockFindGcloudCli.mockReturnValue(join(dir, 'gone'));
    expect(await runGcloudCapture([], 5_000)).toEqual({ kind: 'missing' });
  });

  it('never lets gcloud wait on stdin', async () => {
    // `read` on an ignored (closed) stdin returns immediately with EOF.
    mockFindGcloudCli.mockReturnValue(await fakeGcloud('reads', 'if read line; then echo "got:$line"; else echo eof; fi'));
    expect(await runGcloudCapture([], 5_000)).toMatchObject({ kind: 'exited', stdout: 'eof\n' });
  });
});
