import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '../logger/logger.js';
import type { LogEntry } from '../logger/logger.js';

const NOW = '2026-10-18T09:30:00.000Z';

/** A fresh Logger (never the shared one) with one handler collecting its entries. */
function collectingLogger(): { readonly log: Logger; readonly entries: LogEntry[] } {
  const log = new Logger();
  const entries: LogEntry[] = [];
  log.addHandler((entry) => { entries.push(entry); });
  return { log, entries };
}

function logOneOfEach(log: Logger): void {
  log.debug('noise');
  log.info('started');
  log.warn('slow');
  log.error('failed');
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Logger levels', () => {
  it('drops debug messages at the default info level', () => {
    const { log, entries } = collectingLogger();
    logOneOfEach(log);
    expect(entries.map(e => e.level)).toEqual(['info', 'warn', 'error']);
  });

  it('delivers debug messages after setLevel("debug")', () => {
    const { log, entries } = collectingLogger();
    log.setLevel('debug');
    logOneOfEach(log);
    expect(entries.map(e => e.message)).toEqual(['noise', 'started', 'slow', 'failed']);
  });

  it('keeps only errors after setLevel("error"), and lowers again on a later call', () => {
    const { log, entries } = collectingLogger();
    log.setLevel('error');
    logOneOfEach(log);
    expect(entries.map(e => e.level)).toEqual(['error']);
    log.setLevel('warn');
    logOneOfEach(log);
    expect(entries.map(e => e.level)).toEqual(['error', 'warn', 'error']);
  });
});

describe('Logger entries', () => {
  it('stamps each entry with the current time and attaches context only when given', () => {
    const { log, entries } = collectingLogger();
    log.warn('slow sync', { months: 3 });
    log.info('done');
    expect(entries).toStrictEqual([
      { level: 'warn', message: 'slow sync', timestamp: NOW, context: { months: 3 } },
      { level: 'info', message: 'done', timestamp: NOW },
    ]);
  });

  it('hands every entry to each handler, in the order they were added', () => {
    const log = new Logger();
    const seen: string[] = [];
    log.addHandler((entry) => { seen.push(`first:${entry.message}`); });
    log.addHandler((entry) => { seen.push(`second:${entry.message}`); });
    log.error('boom');
    log.debug('ignored');
    expect(seen).toEqual(['first:boom', 'second:boom']);
  });
});
