import { describe, expect, it } from 'vitest';
import { summarizeEventForOutbox } from '../telemetry/summary.js';
import type { TelemetryOutboxEntry } from '../telemetry/types.js';

const at = '2026-10-18T09:30:00.000Z';

/** The entry an event with no id/level yields, so each test states only the
 *  fields it is about. */
function entry(kind: TelemetryOutboxEntry['kind'], title: string): TelemetryOutboxEntry {
  return { timestamp: at, eventId: null, level: null, kind, title };
}

describe('summarizeEventForOutbox: exception labels', () => {
  it('falls back to the message when exception.values is missing', () => {
    expect(summarizeEventForOutbox({ exception: {}, message: 'no values' }, at)).toStrictEqual(entry('other', 'no values'));
  });

  it('falls back to the message when exception.values is empty', () => {
    expect(summarizeEventForOutbox({ exception: { values: [] }, message: 'empty values' }, at)).toStrictEqual(entry('other', 'empty values'));
  });

  it('ignores a first exception value that is not an object', () => {
    expect(summarizeEventForOutbox({ exception: { values: ['TypeError: boom'] } }, at)).toStrictEqual(entry('other', '(event)'));
  });

  it('labels an exception that carries only a type', () => {
    expect(summarizeEventForOutbox({ exception: { values: [{ type: 'RangeError' }] } }, at)).toStrictEqual(entry('error', 'RangeError'));
  });

  it('labels an exception that carries only a value', () => {
    expect(summarizeEventForOutbox({ exception: { values: [{ value: 'disk full' }] } }, at)).toStrictEqual(entry('error', 'disk full'));
  });

  it('labels an exception whose type and value are not strings as a bare Error', () => {
    expect(summarizeEventForOutbox({ exception: { values: [{ type: 42, value: null }] } }, at)).toStrictEqual(entry('error', 'Error'));
  });

  it('uses only the first exception value', () => {
    const event = { exception: { values: [{ type: 'First', value: 'one' }, { type: 'Second', value: 'two' }] } };
    expect(summarizeEventForOutbox(event, at).title).toBe('First: one');
  });

  it('names a native crash whose exception has no strings a bare Error', () => {
    expect(summarizeEventForOutbox({ platform: 'native', exception: { values: [{}] } }, at)).toStrictEqual(entry('crash', 'Native crash — Error'));
  });
});

describe('summarizeEventForOutbox: message labels', () => {
  it('reads the body of a structured { message, params } logentry', () => {
    const event = { message: { message: 'Synced %s months', params: ['3'] } };
    expect(summarizeEventForOutbox(event, at)).toStrictEqual(entry('other', 'Synced %s months'));
  });

  it('ignores a structured message without a string body', () => {
    expect(summarizeEventForOutbox({ message: { params: ['3'] } }, at).title).toBe('(event)');
    expect(summarizeEventForOutbox({ message: { message: 7 } }, at).title).toBe('(event)');
  });

  it('ignores a message that is neither a string nor an object', () => {
    expect(summarizeEventForOutbox({ message: 42 }, at)).toStrictEqual(entry('other', '(event)'));
    expect(summarizeEventForOutbox({ message: ['sync started'] }, at).title).toBe('(event)');
  });

  it('labels an event with neither an exception nor a message "(event)"', () => {
    expect(summarizeEventForOutbox({}, at)).toStrictEqual(entry('other', '(event)'));
  });

  it('prefers the exception over the message', () => {
    const event = { message: 'ignored', exception: { values: [{ type: 'TypeError', value: 'boom' }] } };
    expect(summarizeEventForOutbox(event, at)).toStrictEqual(entry('error', 'TypeError: boom'));
  });
});

describe('summarizeEventForOutbox: transactions', () => {
  it('labels a transaction with no name "Transaction"', () => {
    expect(summarizeEventForOutbox({ type: 'transaction' }, at)).toStrictEqual(entry('transaction', 'Transaction'));
  });

  it('labels a transaction with an empty or non-string name "Transaction"', () => {
    expect(summarizeEventForOutbox({ type: 'transaction', transaction: '' }, at).title).toBe('Transaction');
    expect(summarizeEventForOutbox({ type: 'transaction', transaction: 42 }, at).title).toBe('Transaction');
  });

  it('keeps the transaction kind for a transaction that also says platform:native', () => {
    expect(summarizeEventForOutbox({ type: 'transaction', platform: 'native', transaction: 'boot' }, at)).toStrictEqual(entry('transaction', 'boot'));
  });
});

describe('summarizeEventForOutbox: id, level and title length', () => {
  it('reports a non-string event_id and level as null', () => {
    const summary = summarizeEventForOutbox({ event_id: 123, level: 5, message: 'x' }, at);
    expect(summary.eventId).toBeNull();
    expect(summary.level).toBeNull();
  });

  it('truncates the title to 200 characters', () => {
    const summary = summarizeEventForOutbox({ message: 'a'.repeat(250) }, at);
    expect(summary.title).toBe('a'.repeat(200));
  });
});
