import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryEngineState } from '@costgoblin/core';
import { registerQueryEngineHandlers } from '../main/handlers/query-engine.js';
import type { QueryEngineControl } from '../main/handlers/context.js';
import { openFakeWindow, resetElectronFakes } from './helpers/electron-fake.js';
import { createHarness, type Harness } from './helpers/ipc-harness.js';

/** The channels that tell the renderer about the DuckDB process and let the
 *  user act on it, and what main does by itself when the process comes back
 *  or is given up on. The engine here is a stand-in whose state the test
 *  sets; duckdb-supervisor.test.ts covers the real one. */

vi.mock('electron', async () => (await import('./helpers/electron-fake.js')).fakeElectronModule);
vi.mock('@sentry/electron/main', async () => (await import('./helpers/electron-fake.js')).fakeSentryModule);

class FakeEngine implements QueryEngineControl {
  state: QueryEngineState = { state: 'running', restartedAt: null };
  restartCalls = 0;
  restartFails = false;
  private readonly stateListeners = new Set<(state: QueryEngineState) => void>();
  private readonly restartListeners = new Set<() => void>();

  getState(): QueryEngineState { return this.state; }
  onStateChanged(listener: (state: QueryEngineState) => void): () => void {
    this.stateListeners.add(listener);
    return () => { this.stateListeners.delete(listener); };
  }
  onRestarted(listener: () => void): () => void {
    this.restartListeners.add(listener);
    return () => { this.restartListeners.delete(listener); };
  }
  restart(): Promise<void> {
    this.restartCalls += 1;
    return this.restartFails ? Promise.reject(new Error('The query engine stopped 3 times in 10 minutes and was not restarted.')) : Promise.resolve();
  }

  /** Change state the way the supervisor does: set, then tell. */
  become(state: QueryEngineState): void {
    this.state = state;
    for (const listener of this.stateListeners) listener(state);
  }
  /** A replacement process is running: state first, then the restart event. */
  comeBack(at: number): void {
    this.become({ state: 'running', restartedAt: at });
    for (const listener of this.restartListeners) listener();
  }
}

const STOPPED: QueryEngineState = { state: 'stopped', deaths: 3, windowMinutes: 10 };
const harnesses: Harness[] = [];

beforeEach(() => { resetElectronFakes(); });

afterEach(async () => {
  vi.restoreAllMocks();
  for (const h of harnesses.splice(0)) await h.dispose();
});

async function engineApp(engine?: FakeEngine): Promise<Harness> {
  const h = await createHarness({ data: 'none', overrides: () => (engine === undefined ? {} : { engine }) });
  harnesses.push(h);
  registerQueryEngineHandlers(h.app);
  return h;
}

describe('query engine channels', () => {
  it('reports the engine\'s state with whether rollup builds are paused', async () => {
    const engine = new FakeEngine();
    const h = await engineApp(engine);

    expect(await h.ipc.invoke('engine:get-status')).toEqual({ state: 'running', restartedAt: null, rollupBuildsPaused: false });

    engine.state = { state: 'restarting' };
    expect(await h.ipc.invoke('engine:get-status')).toEqual({ state: 'restarting', rollupBuildsPaused: false });
  });

  it('reports a running engine where the DuckDB client is not a supervised process', async () => {
    const h = await engineApp();
    expect(await h.ipc.invoke('engine:get-status')).toEqual({ state: 'running', restartedAt: null, rollupBuildsPaused: false });
    // Nothing to restart; the rollup can still be resumed.
    await h.ipc.invoke('engine:restart');
    h.app.pauseRollupBuilds();
    await h.ipc.invoke('engine:resume-rollup-builds');
    expect(h.app.rollupBuildsPaused()).toBe(false);
  });

  it('tells every window when the engine restarts, and re-warms the rollup once it is back', async () => {
    const engine = new FakeEngine();
    const h = await engineApp(engine);
    const win = openFakeWindow();
    const warmup = vi.spyOn(h.app, 'warmupBase');

    engine.become({ state: 'restarting' });
    expect(win.webContents.send).toHaveBeenLastCalledWith('engine:status-changed', { state: 'restarting', rollupBuildsPaused: false });
    // Not before the new process runs: a warmup now would only queue behind it.
    expect(warmup).not.toHaveBeenCalled();

    engine.comeBack(1_700_000_000_000);
    expect(win.webContents.send).toHaveBeenLastCalledWith('engine:status-changed', { state: 'running', restartedAt: 1_700_000_000_000, rollupBuildsPaused: false });
    expect(warmup).toHaveBeenCalledTimes(1);
    expect(h.app.rollupBuildsPaused()).toBe(false);
  });

  it('pauses the automatic rollup build when the engine is given up on', async () => {
    const engine = new FakeEngine();
    const h = await engineApp(engine);
    const win = openFakeWindow();

    engine.become(STOPPED);

    expect(h.app.rollupBuildsPaused()).toBe(true);
    // One message carries both: the engine stopped, and the build is paused.
    expect(win.webContents.send).toHaveBeenCalledTimes(1);
    expect(win.webContents.send).toHaveBeenCalledWith('engine:status-changed', { ...STOPPED, rollupBuildsPaused: true });
  });

  it('restarts a stopped engine on request, leaving the rollup build paused', async () => {
    const engine = new FakeEngine();
    const h = await engineApp(engine);
    const win = openFakeWindow();
    engine.become(STOPPED);

    await h.ipc.invoke('engine:restart');
    expect(engine.restartCalls).toBe(1);
    engine.comeBack(1_700_000_000_500);

    expect(h.app.rollupBuildsPaused()).toBe(true);
    expect(win.webContents.send).toHaveBeenLastCalledWith('engine:status-changed', { state: 'running', restartedAt: 1_700_000_000_500, rollupBuildsPaused: true });
    expect(await h.ipc.invoke('engine:get-status')).toEqual({ state: 'running', restartedAt: 1_700_000_000_500, rollupBuildsPaused: true });
  });

  it('rejects a restart that did not get the engine running', async () => {
    const engine = new FakeEngine();
    const h = await engineApp(engine);
    engine.restartFails = true;
    await expect(h.ipc.invoke('engine:restart')).rejects.toThrow(/was not restarted/);
  });

  it('resumes the rollup build on request: unpaused, started, and every window told', async () => {
    const engine = new FakeEngine();
    const h = await engineApp(engine);
    const win = openFakeWindow();
    engine.become(STOPPED);
    engine.comeBack(1_700_000_000_500);
    await h.app.awaitWarmup(5_000);
    const validate = vi.spyOn(h.app.rollupStore, 'loadAndValidate');

    await h.ipc.invoke('engine:resume-rollup-builds');

    expect(h.app.rollupBuildsPaused()).toBe(false);
    // The warmup that was held back: it validates what is built, then builds the rest.
    await vi.waitFor(() => { expect(validate).toHaveBeenCalledTimes(1); });
    expect(win.webContents.send).toHaveBeenLastCalledWith('engine:status-changed', { state: 'running', restartedAt: 1_700_000_000_500, rollupBuildsPaused: false });
  });
});
