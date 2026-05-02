import type { RawRow } from './duckdb-client.js';

export type QueryStatus = 'queued' | 'running' | 'success' | 'error';

export interface QueryLogEntry {
  readonly id: number;
  readonly sql: string;
  readonly paramCount: number;
  readonly status: QueryStatus;
  readonly startedAt: number;
  readonly durationMs: number | null;
  readonly rowCount: number | null;
  readonly error: string | null;
  readonly materialized: boolean;
}

interface InternalEntry {
  id: number;
  sql: string;
  params: readonly unknown[];
  paramCount: number;
  status: QueryStatus;
  startedAt: number;
  durationMs: number | null;
  rowCount: number | null;
  error: string | null;
  materialized: boolean;
}

const MAX_ENTRIES = 200;

export class QueryLog {
  private entries: InternalEntry[] = [];
  private nextId = 0;

  start(sql: string, params: readonly unknown[], materialized: boolean = false): number {
    const id = this.nextId++;
    this.entries.push({
      id,
      sql,
      params,
      paramCount: params.length,
      status: 'queued',
      startedAt: Date.now(),
      durationMs: null,
      rowCount: null,
      error: null,
      materialized,
    });
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(-MAX_ENTRIES);
    }
    return id;
  }

  markRunning(id: number): void {
    const entry = this.entries.find(e => e.id === id);
    if (entry?.status === 'queued') {
      entry.status = 'running';
    }
  }

  complete(id: number, rowCount: number): void {
    const entry = this.entries.find(e => e.id === id);
    if (entry === undefined) return;
    entry.status = 'success';
    entry.durationMs = Date.now() - entry.startedAt;
    entry.rowCount = rowCount;
  }

  fail(id: number, message: string): void {
    const entry = this.entries.find(e => e.id === id);
    if (entry === undefined) return;
    entry.status = 'error';
    entry.durationMs = Date.now() - entry.startedAt;
    entry.error = message;
  }

  getEntries(): QueryLogEntry[] {
    return this.entries.map(e => ({
      id: e.id,
      sql: e.sql,
      paramCount: e.paramCount,
      status: e.status,
      startedAt: e.startedAt,
      durationMs: e.durationMs,
      rowCount: e.rowCount,
      error: e.error,
      materialized: e.materialized,
    }));
  }

  getEntryForExplain(id: number): { sql: string; params: readonly unknown[] } | undefined {
    const entry = this.entries.find(e => e.id === id);
    if (entry === undefined) return undefined;
    return { sql: entry.sql, params: entry.params };
  }

  clearCompleted(): void {
    this.entries = this.entries.filter(e => e.status === 'running' || e.status === 'queued');
  }

  clear(): void {
    this.entries = [];
  }

  wrapQuery(fn: (sql: string, onStarted?: () => void) => Promise<RawRow[]>): (sql: string) => Promise<RawRow[]> {
    return (sql: string) => {
      const id = this.start(sql, []);
      return fn(sql, () => { this.markRunning(id); }).then(
        (rows) => { this.complete(id, rows.length); return rows; },
        (err: unknown) => { this.fail(id, err instanceof Error ? err.message : String(err)); throw err; },
      );
    };
  }

  wrapPreparedQuery(fn: (sql: string, params: readonly unknown[], onStarted?: () => void) => Promise<RawRow[]>): (sql: string, params: readonly unknown[], materialized?: boolean) => Promise<RawRow[]> {
    return (sql: string, params: readonly unknown[], materialized?: boolean) => {
      const id = this.start(sql, params, materialized === true);
      return fn(sql, params, () => { this.markRunning(id); }).then(
        (rows) => { this.complete(id, rows.length); return rows; },
        (err: unknown) => { this.fail(id, err instanceof Error ? err.message : String(err)); throw err; },
      );
    };
  }
}
