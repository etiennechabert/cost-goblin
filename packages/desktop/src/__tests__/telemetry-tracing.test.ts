import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { traceRootSpan, traceSpan } from '../main/telemetry/tracing.js';
import { AMBIENT_SPAN, startedSpans } from './helpers/electron-fake.js';
import { armTracing } from './helpers/tracing.js';

/** The span helpers the main process wraps its work in: a pure pass-through
 *  until performance tracing is armed, then a span that nests under the active
 *  one (traceSpan) or starts a transaction of its own (traceRootSpan). The fake
 *  SDK carries the active span through the async flow and starts every span
 *  under an ambient one, standing for whatever the real SDK may have active. */

vi.mock('electron', async () => (await import('./helpers/electron-fake.js')).fakeElectronModule);
vi.mock('@sentry/electron/main', async () => (await import('./helpers/electron-fake.js')).fakeSentryModule);

function tick(): Promise<void> {
  return new Promise<void>((resolve) => { setImmediate(resolve); });
}

beforeEach(() => {
  startedSpans.splice(0);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('span helpers while tracing is off', () => {
  it('run the work directly and start no span', async () => {
    expect(traceSpan({ name: 'db.query' }, (span) => span)).toBeUndefined();
    await expect(traceRootSpan({ name: 'sync.s3' }, (span) => Promise.resolve(span))).resolves.toBeUndefined();
    expect(startedSpans).toEqual([]);
  });
});

describe('span helpers while tracing is armed', () => {
  beforeEach(() => {
    armTracing();
  });

  it('nest a traced step under the span active where it starts, across awaits', async () => {
    const result = await traceSpan({ name: 'outer', op: 'test.outer' }, async (outer) => {
      outer?.setAttribute('rows', 3);
      await tick();
      return traceSpan({ name: 'inner' }, () => 'done');
    });

    expect(result).toBe('done');
    const [outer, inner] = startedSpans;
    expect(outer).toMatchObject({ name: 'outer', op: 'test.outer', parent: AMBIENT_SPAN, attributes: { rows: 3 } });
    expect(inner?.parent).toBe(outer);
  });

  it('start a unit of work as a root span, its own transaction, whatever span is active', async () => {
    await traceSpan({ name: 'caller' }, () => traceRootSpan({ name: 'sync.s3', op: 'sync.s3' }, async (root) => {
      root?.setAttribute('sync.files_downloaded', 2);
      await tick();
      return traceSpan({ name: 'step' }, () => 'stepped');
    }));

    const [caller, root, step] = startedSpans;
    expect(caller?.parent).toBe(AMBIENT_SPAN);
    expect(root).toMatchObject({ name: 'sync.s3', op: 'sync.s3', parent: null, attributes: { 'sync.files_downloaded': 2 } });
    // Its own steps still nest under it.
    expect(step?.parent).toBe(root);

    // With nothing of ours active, it is a root span all the same.
    await traceRootSpan({ name: 'rollup.warmup' }, () => Promise.resolve());
    expect(startedSpans.at(-1)).toMatchObject({ name: 'rollup.warmup', parent: null });
  });
});
