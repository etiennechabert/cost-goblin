import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Terminating a DuckDB worker thread while it runs a query aborts the process
 * that hosts the thread (`libc++abi: terminating due to uncaught exception of
 * type Napi::Error`) — in the app, that process is Electron's main process,
 * and the MCP server's sandboxed instance is terminated every time MCP is
 * stopped, disabled or has its token regenerated.
 *
 * An abort can't be asserted from inside the process it kills, so each case
 * runs helpers/duckdb-terminate-child.ts in a process of its own and reads how
 * that process ended.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerPath = join(__dirname, '..', '..', 'out', 'worker', 'duckdb-worker.cjs');
const childPath = join(__dirname, 'helpers', 'duckdb-terminate-child.ts');

if (!existsSync(workerPath)) {
  throw new Error(
    `Worker bundle not found at ${workerPath}. Run "npm run build:worker" in packages/desktop first.`,
  );
}

interface ChildRun {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** The slow query runs for tens of seconds; a child still alive after this is
 *  killed, which the assertions report as a SIGKILL. */
const CHILD_TIMEOUT_MS = 45_000;

function runChild(mode: 'running' | 'just-sent'): Promise<ChildRun> {
  return new Promise<ChildRun>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', childPath, workerPath, mode], {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });
    const killer = setTimeout(() => { child.kill('SIGKILL'); }, CHILD_TIMEOUT_MS);
    child.once('error', (err) => {
      clearTimeout(killer);
      reject(err);
    });
    child.once('close', (code, signal) => {
      clearTimeout(killer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

interface ChildReport {
  readonly outcome: string;
  readonly afterTerminate: string;
  readonly terminateMs: number;
}

function parseReport(stdout: string): ChildReport {
  const parsed: unknown = JSON.parse(stdout);
  if (typeof parsed !== 'object' || parsed === null) throw new Error(`unexpected child output: ${stdout}`);
  const outcome: unknown = Reflect.get(parsed, 'outcome');
  const afterTerminate: unknown = Reflect.get(parsed, 'afterTerminate');
  const terminateMs: unknown = Reflect.get(parsed, 'terminateMs');
  if (typeof outcome !== 'string' || typeof afterTerminate !== 'string' || typeof terminateMs !== 'number') {
    throw new Error(`unexpected child output: ${stdout}`);
  }
  return { outcome, afterTerminate, terminateMs };
}

describe('terminating a DuckDB client with a query in flight', () => {
  it.each([
    ['a query DuckDB is executing', 'running'],
    ['a query that was only just sent', 'just-sent'],
  ] as const)('leaves the host process up, with %s', async (_label, mode) => {
    const run = await runChild(mode);

    expect(run.stderr).not.toContain('Napi::Error');
    expect({ code: run.code, signal: run.signal }).toEqual({ code: 0, signal: null });

    const report = parseReport(run.stdout);
    // The query is cancelled rather than left to run, so the stop is prompt.
    expect(report.outcome).toBe('Query cancelled');
    expect(report.terminateMs).toBeLessThan(10_000);
    expect(report.afterTerminate).toBe('DuckDB client terminated');
  }, 60_000);
});
