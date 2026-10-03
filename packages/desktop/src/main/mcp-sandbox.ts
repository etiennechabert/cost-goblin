import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '@costgoblin/core';
import type { DuckDbSandboxOptions } from '@costgoblin/core';
import type { RawRow } from './duckdb-client.js';
import { computeDefaultMemoryGB, computeDefaultThreads } from './duckdb-tuning.js';

/**
 * Electron-free helpers for the MCP server's dedicated, sandboxed DuckDB
 * instance (#594). MCP tools run SQL an AI client supplies (run_sql,
 * explore_data), so their instance may read only what MCP legitimately needs:
 * the workspace's Parquet (under dataDir) and the flattened org-accounts JSON
 * the costs CTE joins. Every other stateDir file (telemetry outbox, baselines,
 * preferences) and everything else on disk or on the network is refused.
 */

/** What an MCP client sees instead of DuckDB's `Permission Error: Cannot access
 *  file "<abs path>" ...` — the tools echo `err.message`, so mapping it once at
 *  the query boundary keeps local paths out of every tool response. */
export const MCP_SANDBOX_REFUSAL = 'Query tried to read outside the CostGoblin workspace; only the costs data can be queried.';

/** Ceilings for the MCP instance — it runs alongside the app's shared instance,
 *  so it gets a small, fixed slice rather than the user's performance overrides. */
const MCP_MAX_MEMORY_GB = 2;
const MCP_MAX_THREADS = 4;
/** Spill cap: without it DuckDB may fill 90% of the free disk. */
const MCP_MAX_TEMP_DIRECTORY_GB = 10;

export interface McpSandboxPaths {
  readonly dataDir: string;
  readonly stateDir: string;
  /** The workspace temp root; the MCP instance spills into its own `mcp/` subdir. */
  readonly tempDir: string;
}

/** Create (pinned mode doesn't pre-create them) and canonicalise the granted
 *  directories, and build the sandbox options. DuckDB matches the canonical
 *  path of each file it opens, so the allow-list must be canonical too —
 *  otherwise a symlinked workspace root (macOS `/var` -> `/private/var`) would
 *  deny its own data. Throws if a directory can't be created or resolved. */
export function prepareMcpSandbox(paths: McpSandboxPaths): DuckDbSandboxOptions {
  const spillDir = join(paths.tempDir, 'mcp');
  for (const dir of [paths.dataDir, paths.stateDir, spillDir]) {
    mkdirSync(dir, { recursive: true });
  }
  const dataDir = realpathSync(paths.dataDir);
  const tempDirectory = realpathSync(spillDir);
  return {
    allowedDirectories: [dataDir, tempDirectory],
    // Exactly the org-accounts file getOrgAccountsPath() hands the costs CTE —
    // never the whole stateDir. It may not exist yet; a path granted before
    // the file is created is still readable once it is.
    allowedPaths: [join(realpathSync(paths.stateDir), 'org-account-tags.json')],
    tempDirectory,
    maxTempDirectorySizeGB: MCP_MAX_TEMP_DIRECTORY_GB,
    memoryLimitGB: Math.max(1, Math.min(MCP_MAX_MEMORY_GB, computeDefaultMemoryGB())),
    threads: Math.max(1, Math.min(MCP_MAX_THREADS, computeDefaultThreads())),
  };
}

function isSandboxDenial(err: unknown): boolean {
  return err instanceof Error && err.message.includes('Permission Error:');
}

/** Replace a sandbox denial with the generic, path-free refusal (logging a
 *  path-free warning); pass every other error through unchanged. */
export function mapSandboxError(err: unknown): unknown {
  if (!isSandboxDenial(err)) return err;
  logger.warn('mcp: query refused by the DuckDB sandbox (access outside the workspace)');
  return new Error(MCP_SANDBOX_REFUSAL);
}

async function withSandboxErrors(run: () => Promise<RawRow[]>): Promise<RawRow[]> {
  try {
    return await run();
  } catch (err: unknown) {
    throw mapSandboxError(err);
  }
}

export interface McpQueryFns {
  readonly runQuery: (sql: string) => Promise<RawRow[]>;
  readonly runPreparedQuery: (sql: string, params: readonly unknown[]) => Promise<RawRow[]>;
}

/** Both McpContext query functions, routed to the sandboxed client with
 *  denials mapped to {@link MCP_SANDBOX_REFUSAL}. No result cache: MCP SQL is
 *  arbitrary and must not share cached rows with the app's instance. */
export function sandboxedQueryFns(db: McpQueryFns): McpQueryFns {
  return {
    runQuery: (sql) => withSandboxErrors(() => db.runQuery(sql)),
    runPreparedQuery: (sql, params) => withSandboxErrors(() => db.runPreparedQuery(sql, params)),
  };
}
