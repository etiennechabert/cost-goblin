import { isStringRecord } from '../utils/json.js';
import { redactSensitiveString } from './scrub.js';
import type { TelemetryEventKind, TelemetryOutboxEntry } from './types.js';

const MAX_TITLE_LEN = 200;

function firstExceptionLabel(event: Readonly<Record<string, unknown>>): string | null {
  const exception = event['exception'];
  if (!isStringRecord(exception)) return null;
  const values = exception['values'];
  if (!Array.isArray(values) || values.length === 0) return null;
  const first: unknown = values[0];
  if (!isStringRecord(first)) return null;
  const type = typeof first['type'] === 'string' ? first['type'] : '';
  const value = typeof first['value'] === 'string' ? first['value'] : '';
  const label = [type, value].filter((s) => s.length > 0).join(': ');
  return label.length > 0 ? label : 'Error';
}

function messageLabel(event: Readonly<Record<string, unknown>>): string | null {
  const msg = event['message'];
  if (typeof msg === 'string') return msg;
  // Sentry can carry a structured `{ message, params }` logentry.
  if (isStringRecord(msg) && typeof msg['message'] === 'string') return msg['message'];
  return null;
}

/**
 * Summarise an already-scrubbed Sentry event into one audit-log line. Pure:
 * `occurredAt` is injected by the caller (core never reads the clock). Reads
 * only the event's own fields and re-redacts the resulting title defensively.
 */
export function summarizeEventForOutbox(event: unknown, occurredAt: string): TelemetryOutboxEntry {
  if (!isStringRecord(event)) {
    return { timestamp: occurredAt, eventId: null, level: null, kind: 'other', title: '(unrecognised event)' };
  }

  const eventId = typeof event['event_id'] === 'string' ? event['event_id'] : null;
  const level = typeof event['level'] === 'string' ? event['level'] : null;

  let kind: TelemetryEventKind = 'other';
  let title = '(event)';

  const exceptionLabel = firstExceptionLabel(event);
  if (exceptionLabel !== null) {
    kind = 'error';
    title = exceptionLabel;
  } else if (event['type'] === 'transaction') {
    kind = 'transaction';
    const tx = event['transaction'];
    title = typeof tx === 'string' && tx.length > 0 ? tx : 'Transaction';
  } else {
    const msg = messageLabel(event);
    if (msg !== null) title = msg;
  }

  return {
    timestamp: occurredAt,
    eventId,
    level,
    kind,
    title: redactSensitiveString(title).slice(0, MAX_TITLE_LEN),
  };
}
