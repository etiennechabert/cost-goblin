import { describe, expect, it } from 'vitest';
import type { Event } from '@sentry/electron/main';
import { redactEventInPlace } from '../main/telemetry/scrub-event.js';

/** The sparse and off-type event shapes redactEventInPlace must tolerate:
 *  absent sections are left absent, text-free fields untouched, and anything
 *  that can't be scrubbed is dropped rather than sent as-is. The fully
 *  populated event is covered in telemetry-scrub-event.test.ts. */

describe('redactEventInPlace on sparse events', () => {
  it('leaves an event with no scrubbable sections as it was', () => {
    const event: Event = { event_id: 'abc123', level: 'error', platform: 'node', timestamp: 1 };

    redactEventInPlace(event);

    expect(event).toEqual({ event_id: 'abc123', level: 'error', platform: 'node', timestamp: 1 });
  });

  it('keeps empty sections empty', () => {
    const event: Event = {
      exception: {},
      threads: { values: [] },
      spans: [],
      breadcrumbs: [],
      tags: {},
      contexts: {},
      logentry: {},
    };

    redactEventInPlace(event);

    expect(event).toEqual({ exception: {}, threads: { values: [] }, spans: [], breadcrumbs: [], tags: {}, contexts: {}, logentry: {} });
  });

  it('scrubs module paths in stack frames and tolerates frames, exceptions and threads with no text', () => {
    const event: Event = {
      exception: {
        values: [
          { type: 'Error', stacktrace: { frames: [{ module: '/Users/jane/costgoblin/main', function: 'run', lineno: 3 }, {}] } },
          { type: 'TypeError' },
        ],
      },
      threads: { values: [{ id: 1 }, { id: 2, stacktrace: {} }] },
    };

    redactEventInPlace(event);

    expect(event.exception?.values?.[0]?.stacktrace?.frames).toEqual([
      { module: '/Users/[user]/costgoblin/main', function: 'run', lineno: 3 },
      {},
    ]);
    expect(event.exception?.values?.[1]).toEqual({ type: 'TypeError' });
    expect(event.threads).toEqual({ values: [{ id: 1 }, { id: 2, stacktrace: {} }] });
  });

  it('leaves non-text span attributes and spans without a description alone', () => {
    const event: Event = {
      spans: [{ span_id: 's1', trace_id: 't1', start_timestamp: 0, status: 'ok', data: { 'cache.hit': true, 'db.rows': 12 } }],
    };

    redactEventInPlace(event);

    expect(event.spans?.[0]).toEqual({ span_id: 's1', trace_id: 't1', start_timestamp: 0, status: 'ok', data: { 'cache.hit': true, 'db.rows': 12 } });
  });

  it('drops breadcrumb data it cannot redact as a record, and keeps bare breadcrumbs', () => {
    const offType: unknown = JSON.parse('["123456789012"]');
    const event: Event = {
      breadcrumbs: [
        { category: 'navigation' },
        { category: 'ipc', data: { channel: 'query:costs' } },
        { category: 'console' },
      ],
    };
    Reflect.set(event.breadcrumbs?.[2] ?? {}, 'data', offType);

    redactEventInPlace(event);

    expect(event.breadcrumbs).toEqual([
      { category: 'navigation' },
      { category: 'ipc', data: { channel: 'query:costs' } },
      { category: 'console', data: {} },
    ]);
  });

  it('keeps boolean tags, and drops unset or non-object contexts even when allow-listed', () => {
    const event: Event = { tags: { packaged: true }, contexts: { app: { app_name: 'CostGoblin' } } };
    Reflect.set(event.contexts ?? {}, 'os', undefined);
    Reflect.set(event.contexts ?? {}, 'runtime', JSON.parse('["node", "24"]'));

    redactEventInPlace(event);

    expect(event.tags).toEqual({ packaged: true });
    expect(event.contexts).toEqual({ app: { app_name: 'CostGoblin' } });
  });

  it('leaves a logentry that carries no message string as it was', () => {
    const event: Event = { logentry: { params: [] } };

    redactEventInPlace(event);

    expect(event).toEqual({ logentry: { params: [] } });
  });
});
