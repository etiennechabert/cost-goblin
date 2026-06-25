import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { app as electronApp, ipcMain } from 'electron';
import { parseJsonObject } from '@costgoblin/core';
import type { AppContext } from './context.js';

const execFileAsync = promisify(execFile);

export function registerDebugHandlers(app: AppContext): void {
  ipcMain.handle('debug:get-query-log', () => {
    return app.queryLog.getEntries();
  });

  ipcMain.handle('debug:run-explain', async (_event, queryId: number): Promise<string> => {
    const entry = app.queryLog.getEntryForExplain(queryId);
    if (entry === undefined) return 'Query not found in log';
    const sql = `EXPLAIN ANALYZE ${entry.sql}`;
    try {
      const rows = await app.runPreparedQuery(sql, entry.params);
      return rows.map(r => Object.values(r).join('\t')).join('\n');
    } catch (err: unknown) {
      return `EXPLAIN failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  });

  ipcMain.handle('debug:materialized-status', () => {
    // The in-memory materialized base was replaced by the persistent RollupStore.
    return { ready: app.rollupStore.isReady(), validPeriods: [...app.rollupStore.getValidPeriods()] };
  });

  ipcMain.handle('debug:clear-completed', () => {
    app.queryLog.clearCompleted();
  });

  ipcMain.handle('debug:clear-query-log', () => {
    app.queryLog.clear();
  });

  ipcMain.handle('debug:get-memory-mb', () => {
    return Math.round(process.memoryUsage().rss / 1024 / 1024);
  });

  // Current git branch — only meaningful in dev (a source checkout/worktree).
  // Packaged builds aren't a repo, so return null and let the UI fall back to
  // the version string. Detached HEAD also returns null.
  ipcMain.handle('debug:get-git-branch', async (): Promise<string | null> => {
    if (electronApp.isPackaged) return null;
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: electronApp.getAppPath(),
      });
      const branch = stdout.trim();
      return branch === '' || branch === 'HEAD' ? null : branch;
    } catch {
      return null;
    }
  });

  // Open PR for the current branch, via the gh CLI. Null when not a dev
  // checkout, gh is missing/unauthenticated, or no PR exists yet. The renderer
  // uses the title to replace the cryptic branch label and the url to link it;
  // absence just leaves the plain branch name.
  ipcMain.handle('debug:get-branch-pr', async (): Promise<{ url: string; title: string; number: number } | null> => {
    if (electronApp.isPackaged) return null;
    try {
      const { stdout } = await execFileAsync('gh', ['pr', 'view', '--json', 'url,title,number'], {
        cwd: electronApp.getAppPath(),
      });
      const pr = parseJsonObject(stdout);
      if (pr === null) return null;
      const { url, title, number } = pr;
      if (typeof url !== 'string' || !url.startsWith('https://')) return null;
      if (typeof title !== 'string' || typeof number !== 'number') return null;
      return { url, title, number };
    } catch {
      return null;
    }
  });
}
