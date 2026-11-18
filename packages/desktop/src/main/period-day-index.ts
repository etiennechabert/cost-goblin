import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildPeriodDaysQuery,
  isQueryCancelled,
  logger,
  providerRawDir,
  type PeriodDays,
  type ProviderName,
  type ProviderType,
} from '@costgoblin/core';
import type { RawRow } from './duckdb-client.js';

interface PeriodDayIndexDeps {
  readonly dataDir: string;
  /** Runs a day-list query. Many queries wait on one answer, so whatever
   *  runs it must be out of reach of a view's cancel, as a rollup build is. */
  readonly runQuery: (sql: string) => Promise<RawRow[]>;
  /** True for a failure that says nothing about the files read (the query
   *  engine stopped): rethrown, as a cancelled query is. */
  readonly isEngineFailure?: (err: unknown) => boolean;
}

interface IndexedPeriod {
  readonly fingerprint: string;
  readonly days: readonly string[];
}

/** Day-list queries running at once. A first use asks for every month on
 *  disk; each is a scan of one dictionary-encoded column. */
const MAX_CONCURRENT_QUERIES = 4;

function daysOf(rows: readonly RawRow[]): string[] {
  return rows.flatMap((row) => {
    const day = row['day'];
    return typeof day === 'string' ? [day] : [];
  });
}

/**
 * Which UTC days each billing period's raw files hold rows of (`PeriodDays`):
 * what `periodsForRange` needs to tell which periods a date range reads. A
 * period's files hold days of other months too, so the answer comes from the
 * files themselves.
 *
 * A period's days are read once (about 30 ms for a month of 30 million line
 * items) and kept for as long as its files stay the same: every call checks
 * their names, sizes and modification times, so a sync, a deleted month or a
 * pulled share is seen without anyone having to say so. Nothing is written to
 * disk; a start reads every month again.
 *
 * A period whose days can't be read (a file a download left half written) is
 * left out of the answer and logged, and read again on the next call. The
 * range then takes it by the months it touches, as every period was before:
 * a file that can't be read fails the queries on its own month, not all of
 * them.
 */
export class PeriodDayIndex {
  private readonly dataDir: string;
  private readonly runQuery: (sql: string) => Promise<RawRow[]>;
  private readonly isEngineFailure: (err: unknown) => boolean;
  private readonly indexed = new Map<string, IndexedPeriod>();
  /** Day-list queries in flight, by period and fingerprint. */
  private readonly reading = new Map<string, Promise<readonly string[]>>();
  /** The periods whose last read failed: logged when they start failing, not
   *  on every query that finds them still unreadable. */
  private readonly failing = new Set<string>();
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(deps: PeriodDayIndexDeps) {
    this.dataDir = deps.dataDir;
    this.runQuery = deps.runQuery;
    this.isEngineFailure = deps.isEngineFailure ?? ((): boolean => false);
  }

  /** The days of each of `periods` (the provider's months on disk for
   *  `tier`). Rejects only with a cancellation or an engine failure. */
  async daysFor(
    provider: { readonly name: ProviderName; readonly type: ProviderType },
    tier: 'daily' | 'hourly',
    periods: readonly string[],
  ): Promise<PeriodDays> {
    const entries = await Promise.all(periods.map(async (period): Promise<[string, readonly string[]] | null> => {
      const days = await this.daysOfPeriod(provider, tier, period);
      return days === null ? null : [period, days];
    }));
    return Object.fromEntries(entries.filter(entry => entry !== null));
  }

  private async daysOfPeriod(
    provider: { readonly name: ProviderName; readonly type: ProviderType },
    tier: 'daily' | 'hourly',
    period: string,
  ): Promise<readonly string[] | null> {
    const key = `${String(provider.name)}\0${tier}\0${period}`;
    const fingerprint = await this.fingerprint(provider.name, tier, period);
    if (fingerprint === null) return null;
    const known = this.indexed.get(key);
    if (known?.fingerprint === fingerprint) return known.days;

    const readingKey = `${key}\0${fingerprint}`;
    let reading = this.reading.get(readingKey);
    if (reading === undefined) {
      reading = this.limited(async () => daysOf(await this.runQuery(buildPeriodDaysQuery(this.dataDir, provider, tier, period))));
      this.reading.set(readingKey, reading);
      const done = (): void => { this.reading.delete(readingKey); };
      void reading.then(done, done);
    }
    try {
      const days = await reading;
      this.indexed.set(key, { fingerprint, days });
      this.failing.delete(key);
      return days;
    } catch (err: unknown) {
      if (isQueryCancelled(err) || this.isEngineFailure(err)) throw err;
      // Every query asks again until the files read; a file still being
      // downloaded changes on each, so the log says it once, not each time.
      if (!this.failing.has(key)) {
        this.failing.add(key);
        logger.warn(`period-days: could not read the days of ${tier} ${period} (${String(provider.name)}); `
          + `ranges read it by its own month only — ${err instanceof Error ? err.message : String(err)}`);
      }
      return null;
    }
  }

  /** What changes when the period's files do: each Parquet file's name, size
   *  and modification time. Null when the directory can't be listed, or holds
   *  no Parquet file: there is nothing to read the days of. */
  private async fingerprint(provider: ProviderName, tier: string, period: string): Promise<string | null> {
    const dir = join(providerRawDir(this.dataDir, provider), `${tier}-${period}`);
    try {
      const files = (await readdir(dir)).filter(name => name.endsWith('.parquet')).sort((a, b) => a.localeCompare(b));
      if (files.length === 0) return null;
      const stamps = await Promise.all(files.map(async (name) => {
        const { size, mtimeMs } = await stat(join(dir, name));
        return `${name}\0${String(size)}\0${String(mtimeMs)}`;
      }));
      return stamps.join('\n');
    } catch {
      // The directory or a file went away under the listing (a sync replacing
      // the month): nothing to index until it is back.
      return null;
    }
  }

  /** Runs `task` once fewer than MAX_CONCURRENT_QUERIES are running. A task
   *  that ends hands its slot to the one waiting longest, so a newcomer never
   *  takes it first. */
  private async limited<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= MAX_CONCURRENT_QUERIES) {
      await new Promise<void>((resolve) => { this.waiting.push(resolve); });
    } else {
      this.running += 1;
    }
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next === undefined) this.running -= 1;
      else next();
    }
  }
}
