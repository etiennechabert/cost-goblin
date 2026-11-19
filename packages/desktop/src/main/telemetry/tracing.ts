import * as Sentry from '@sentry/electron/main';
import type { Span } from '@sentry/electron/main';
import { telemetry } from './controller.js';

/**
 * Low-cardinality Sentry span `op` strings for the main-process operations we
 * instrument. Centralised so every emit site — and any future dashboard or
 * alert keyed off these ops — stays in lockstep.
 */
export const SPAN_OP = {
  /** One DuckDB query round-trip (main → worker → main). */
  dbQuery: 'db.query',
  /** One rollup partition build (a single period, on a fresh connection). */
  rollupBuild: 'rollup.build',
  /** The startup warm-load rebuild of missing/stale partitions. */
  rollupWarmup: 'rollup.warmup',
  /** A post-sync rollup re-roll over the periods a sync changed. */
  rollupMaintain: 'rollup.maintain',
  /** One S3 selective-sync run (download + ingest of a set of periods). */
  sync: 'sync.s3',
} as const;

/** Options accepted by {@link traceSpan} — Sentry's `startSpan` options. Exported
 *  so call sites can hoist static span options to module constants (no per-call
 *  allocation on the hot path) without importing the Sentry SDK themselves. */
export type SpanOptions = Parameters<typeof Sentry.startSpan>[0];

/**
 * Run `fn` inside a Sentry span when performance tracing is armed; otherwise call
 * it directly — a pure pass-through that constructs no SDK objects, so the hot
 * query path costs nothing for the (near-total) majority who never opt in.
 *
 * The span finishes automatically once `fn`'s result settles (a returned promise
 * is awaited by the SDK). With no active parent it becomes its own transaction;
 * inside another span it nests. `fn` receives the live `Span` (or `undefined`
 * when tracing is off) so callers can attach result attributes — row counts,
 * byte totals — after the work completes.
 */
export function traceSpan<T>(options: SpanOptions, fn: (span: Span | undefined) => T): T {
  if (!telemetry.isTracingActive()) return fn(undefined);
  return Sentry.startSpan(options, (span) => fn(span));
}

/**
 * {@link traceSpan} for a unit of work of its own (a sync, a rollup warm-up or
 * re-roll): the span starts as a root span whatever span is active, so Sentry
 * sends it as a transaction of its own. Nested under a caller's span it would
 * be only a child, and in the static trace lifecycle a child that ends after
 * its transaction (a warm-up outlives the call that starts it) is never sent.
 * Clearing the active span first is what Sentry 11.10 recommends in place of
 * the deprecated `forceTransaction` start option. Spans started inside `fn`
 * still nest under this one.
 */
export function traceRootSpan<T>(options: SpanOptions, fn: (span: Span | undefined) => T): T {
  if (!telemetry.isTracingActive()) return fn(undefined);
  return Sentry.withActiveSpan(null, () => Sentry.startSpan(options, (span) => fn(span)));
}
