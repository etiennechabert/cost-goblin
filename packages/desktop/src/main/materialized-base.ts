import { logger } from '@costgoblin/core';
import type { RawRow } from './duckdb-client.js';

interface MaterializedState {
  readonly start: string;
  readonly end: string;
  readonly tier: string;
  readonly configHash: string;
}

export class MaterializedBase {
  private state: MaterializedState | null = null;
  private pending: Promise<void> | null = null;

  async materialize(
    runQuery: (sql: string) => Promise<RawRow[]>,
    sql: string,
    dateRange: { readonly start: string; readonly end: string },
    tier: string,
    cfgHash: string,
  ): Promise<void> {
    if (this.pending !== null) {
      await this.pending;
      if (this.state !== null
        && this.state.start === dateRange.start
        && this.state.end === dateRange.end
        && this.state.tier === tier
        && this.state.configHash === cfgHash) {
        return;
      }
    }

    const start = Date.now();
    this.pending = runQuery(sql)
      .then(() => {
        this.state = { start: dateRange.start, end: dateRange.end, tier, configHash: cfgHash };
        logger.info('materialized-base: ready', {
          dateRange,
          tier,
          durationMs: Date.now() - start,
        });
      })
      .catch((err: unknown) => {
        logger.warn(`materialized-base: failed — ${err instanceof Error ? err.message : String(err)}`);
        this.state = null;
      })
      .finally(() => { this.pending = null; });

    return this.pending;
  }

  async drop(runQuery: (sql: string) => Promise<RawRow[]>): Promise<void> {
    this.state = null;
    this.pending = null;
    try {
      await runQuery('DROP TABLE IF EXISTS cost_base');
    } catch {
      // table might not exist yet
    }
  }

  getSource(
    dateRange: { readonly start: string; readonly end: string },
    tier: string,
  ): string | undefined {
    if (this.state === null) return undefined;
    if (this.state.tier !== tier) return undefined;
    if (this.state.start > dateRange.start || this.state.end < dateRange.end) return undefined;
    return 'cost_base';
  }

  isReady(): boolean {
    return this.state !== null;
  }

  getCurrentState(): MaterializedState | null {
    return this.state;
  }
}

export function configHash(dimensions: unknown, costScope: unknown): string {
  return JSON.stringify({ d: dimensions, c: costScope });
}
