import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseJsonObject } from '@costgoblin/core';
import { updatePrefsFile } from '../main/handlers/prefs-file.js';
import { applyMcpEnabled, persistMcpEnabled, readMcpEnabledSync } from '../main/mcp-prefs.js';
import type { ApplyMcpEnabledDeps } from '../main/mcp-prefs.js';

let dir: string;
let prefsFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cg-mcp-prefs-'));
  prefsFile = join(dir, 'ui-preferences.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function readPrefs(): Promise<Readonly<Record<string, unknown>> | null> {
  return parseJsonObject(await readFile(prefsFile, 'utf-8'));
}

describe('readMcpEnabledSync', () => {
  it('is off when there is no prefs file', () => {
    expect(readMcpEnabledSync(prefsFile)).toBe(false);
  });

  it('is off for a corrupt prefs file', async () => {
    await writeFile(prefsFile, '{ not json');
    expect(readMcpEnabledSync(prefsFile)).toBe(false);
  });

  it('is off without an mcp slice', async () => {
    await writeFile(prefsFile, JSON.stringify({ telemetry: { errorReports: true } }));
    expect(readMcpEnabledSync(prefsFile)).toBe(false);
  });

  it('is off for a non-boolean flag', async () => {
    await writeFile(prefsFile, JSON.stringify({ mcp: { enabled: 'yes' } }));
    expect(readMcpEnabledSync(prefsFile)).toBe(false);
  });

  it('follows persistMcpEnabled', async () => {
    await persistMcpEnabled(prefsFile, true);
    expect(readMcpEnabledSync(prefsFile)).toBe(true);
    await persistMcpEnabled(prefsFile, false);
    expect(readMcpEnabledSync(prefsFile)).toBe(false);
  });
});

describe('persistMcpEnabled', () => {
  it('writes only the mcp slice and keeps the others', async () => {
    await writeFile(prefsFile, JSON.stringify({ defaultViewId: 'overview', performance: { threads: 4 } }));
    await persistMcpEnabled(prefsFile, true);
    expect(await readPrefs()).toStrictEqual({
      defaultViewId: 'overview',
      performance: { threads: 4 },
      mcp: { enabled: true },
    });
  });

  it('keeps a concurrent telemetry write, and the telemetry writer keeps the mcp slice', async () => {
    await writeFile(prefsFile, JSON.stringify({ performance: { threads: 4 } }));
    await Promise.all([
      persistMcpEnabled(prefsFile, true),
      updatePrefsFile(prefsFile, (current) => ({ ...current, telemetry: { errorReports: true } })),
    ]);
    expect(await readPrefs()).toStrictEqual({
      performance: { threads: 4 },
      mcp: { enabled: true },
      telemetry: { errorReports: true },
    });
  });
});

interface Recorder {
  readonly calls: string[];
  readonly deps: ApplyMcpEnabledDeps;
}

/** Deps that log each side effect in order and track a running flag. */
function recorder(opts: {
  readonly running: boolean;
  readonly startError?: Error;
  readonly persistError?: (enabled: boolean) => Error | undefined;
}): Recorder {
  const calls: string[] = [];
  let running = opts.running;
  return {
    calls,
    deps: {
      persist: (enabled) => {
        calls.push(`persist:${String(enabled)}`);
        const err = opts.persistError?.(enabled);
        return err === undefined ? Promise.resolve() : Promise.reject(err);
      },
      start: () => {
        calls.push('start');
        if (opts.startError !== undefined) return Promise.reject(opts.startError);
        running = true;
        return Promise.resolve();
      },
      stop: () => {
        calls.push('stop');
        running = false;
        return Promise.resolve();
      },
      isRunning: () => running,
    },
  };
}

describe('applyMcpEnabled', () => {
  it('enable: starts the server, then persists true', async () => {
    const r = recorder({ running: false });
    await applyMcpEnabled(true, r.deps);
    expect(r.calls).toStrictEqual(['start', 'persist:true']);
  });

  it('enable: does not start a server that is already running', async () => {
    const r = recorder({ running: true });
    await applyMcpEnabled(true, r.deps);
    expect(r.calls).toStrictEqual(['persist:true']);
  });

  it('disable: persists false, then stops the server', async () => {
    const r = recorder({ running: true });
    await applyMcpEnabled(false, r.deps);
    expect(r.calls).toStrictEqual(['persist:false', 'stop']);
  });

  // isRunning() is false while a start (or a token-rotation restart) is still
  // in flight, so gating the stop on it would drop the Disable and leave that
  // start listening. stop() is serialized behind any in-flight start and is a
  // no-op when nothing runs, so it is always queued.
  it('disable: queues a stop even when isRunning() says stopped', async () => {
    const r = recorder({ running: false });
    await applyMcpEnabled(false, r.deps);
    expect(r.calls).toStrictEqual(['persist:false', 'stop']);
  });

  it('a failed start saves the setting as off and rethrows, never persisting true', async () => {
    const startError = new Error('listen EADDRINUSE');
    const r = recorder({ running: false, startError });
    await expect(applyMcpEnabled(true, r.deps)).rejects.toBe(startError);
    expect(r.calls).toStrictEqual(['start', 'persist:false']);
  });

  it('a failed start still reports the start error when saving off also fails', async () => {
    const startError = new Error('listen EADDRINUSE');
    const r = recorder({ running: false, startError, persistError: () => new Error('disk full') });
    await expect(applyMcpEnabled(true, r.deps)).rejects.toBe(startError);
    expect(r.calls).toStrictEqual(['start', 'persist:false']);
  });

  it('a failed persist(true) stops the server it just started and rethrows', async () => {
    const persistError = new Error('disk full');
    const r = recorder({ running: false, persistError: (enabled) => (enabled ? persistError : undefined) });
    await expect(applyMcpEnabled(true, r.deps)).rejects.toBe(persistError);
    expect(r.calls).toStrictEqual(['start', 'persist:true', 'stop']);
    expect(r.deps.isRunning()).toBe(false);
  });

  it('a failed persist(true) leaves a server it did not start running', async () => {
    const persistError = new Error('disk full');
    const r = recorder({ running: true, persistError: (enabled) => (enabled ? persistError : undefined) });
    await expect(applyMcpEnabled(true, r.deps)).rejects.toBe(persistError);
    expect(r.calls).toStrictEqual(['persist:true']);
    expect(r.deps.isRunning()).toBe(true);
  });

  it.each([
    ['the string "true"', 'true'],
    ['the number 1', 1],
    ['undefined', undefined],
    ['null', null],
    ['an object', { enabled: true }],
  ])('rejects %s with no side effects', async (_label, value) => {
    const r = recorder({ running: false });
    await expect(applyMcpEnabled(value, r.deps)).rejects.toThrow(TypeError);
    expect(r.calls).toStrictEqual([]);
  });
});
