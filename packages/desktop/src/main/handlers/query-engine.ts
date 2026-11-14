import { BrowserWindow, ipcMain } from 'electron';
import type { QueryEngineState, QueryEngineStatus } from '@costgoblin/core';
import type { AppContext } from './context.js';

/** What a `db` that is not a supervised process reports: it runs, and never
 *  stopped. */
const ALWAYS_RUNNING: QueryEngineState = { state: 'running', restartedAt: null };

/**
 * The DuckDB process as the renderer sees it, and what main does when that
 * process ends unexpectedly (`duckdb-supervisor.ts` restarts it):
 *
 * - once a replacement runs, the rollup is warmed again: the builds the dead
 *   process was running are lost, and a warmup rebuilds exactly the months
 *   that are missing;
 * - once the supervisor gives up (`stopped`), the automatic rollup build is
 *   paused too. The build is the heaviest work the app starts by itself, so a
 *   user who restarts the engine gets one that only runs what they ask for,
 *   until they ask for the rollup again.
 *
 * Mirrors the rollup channel: `engine:get-status` for the state on mount,
 * `engine:status-changed` pushed to every window on each change.
 */
export function registerQueryEngineHandlers(app: AppContext): void {
  const engine = app.ctx.engine;

  const status = (): QueryEngineStatus => ({
    ...(engine?.getState() ?? ALWAYS_RUNNING),
    rollupBuildsPaused: app.rollupBuildsPaused(),
  });
  const broadcast = (): void => {
    const current = status();
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('engine:status-changed', current);
    }
  };

  ipcMain.handle('engine:get-status', () => status());

  ipcMain.handle('engine:restart', async (): Promise<void> => {
    await engine?.restart();
  });

  ipcMain.handle('engine:resume-rollup-builds', (): void => {
    app.resumeRollupBuilds();
    broadcast();
  });

  engine?.onStateChanged((state) => {
    if (state.state === 'stopped') app.pauseRollupBuilds();
    broadcast();
  });

  // After the state change, so the warmup's queries go to a running process.
  // While builds are paused it only re-validates what is built.
  engine?.onRestarted(() => { app.warmupBase(); });
}
