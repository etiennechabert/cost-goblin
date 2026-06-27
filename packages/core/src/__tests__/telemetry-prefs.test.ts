import { describe, it, expect } from 'vitest';
import {
  TELEMETRY_DEFAULTS,
  isTelemetryEnabled,
  parseTelemetryPreferences,
} from '../telemetry/types.js';
import { summarizeEventForOutbox } from '../telemetry/summary.js';

describe('parseTelemetryPreferences', () => {
  it('defaults every channel OFF for non-objects', () => {
    expect(parseTelemetryPreferences(null)).toStrictEqual(TELEMETRY_DEFAULTS);
    expect(parseTelemetryPreferences(undefined)).toStrictEqual(TELEMETRY_DEFAULTS);
    expect(parseTelemetryPreferences('nope')).toStrictEqual(TELEMETRY_DEFAULTS);
  });

  it('reads only strictly-true booleans (fails closed)', () => {
    expect(parseTelemetryPreferences({ errorReports: true, nativeCrashReports: 'true', performance: 'true', analytics: 1 })).toStrictEqual({
      errorReports: true,
      nativeCrashReports: false,
      performance: false,
      analytics: false,
    });
  });

  it('round-trips a fully-enabled object', () => {
    const prefs = { errorReports: true, nativeCrashReports: true, performance: true, analytics: true };
    expect(parseTelemetryPreferences(prefs)).toStrictEqual(prefs);
  });
});

describe('isTelemetryEnabled', () => {
  it('is false only when every channel is off', () => {
    expect(isTelemetryEnabled(TELEMETRY_DEFAULTS)).toBe(false);
    expect(isTelemetryEnabled({ errorReports: true, nativeCrashReports: false, performance: false, analytics: false })).toBe(true);
    expect(isTelemetryEnabled({ errorReports: false, nativeCrashReports: true, performance: false, analytics: false })).toBe(true);
    expect(isTelemetryEnabled({ errorReports: false, nativeCrashReports: false, performance: false, analytics: true })).toBe(true);
  });
});

describe('summarizeEventForOutbox', () => {
  const at = '2026-06-26T12:00:00.000Z';

  it('summarises an exception event', () => {
    const entry = summarizeEventForOutbox(
      {
        event_id: 'abc123',
        level: 'error',
        exception: { values: [{ type: 'TypeError', value: 'boom' }] },
      },
      at,
    );
    expect(entry).toStrictEqual({
      timestamp: at,
      eventId: 'abc123',
      level: 'error',
      kind: 'error',
      title: 'TypeError: boom',
    });
  });

  it('summarises a transaction event', () => {
    const entry = summarizeEventForOutbox({ type: 'transaction', transaction: 'GET /costs' }, at);
    expect(entry.kind).toBe('transaction');
    expect(entry.title).toBe('GET /costs');
  });

  it('summarises a plain message event', () => {
    const entry = summarizeEventForOutbox({ message: 'sync started' }, at);
    expect(entry.kind).toBe('other');
    expect(entry.title).toBe('sync started');
  });

  it('re-redacts the title defensively', () => {
    const entry = summarizeEventForOutbox(
      { exception: { values: [{ type: 'Error', value: 'failed for 123456789012' }] } },
      at,
    );
    expect(entry.title).toBe('Error: failed for [redacted-account]');
  });

  it('handles unrecognised payloads without throwing', () => {
    const entry = summarizeEventForOutbox(42, at);
    expect(entry.kind).toBe('other');
    expect(entry.eventId).toBe(null);
  });
});
