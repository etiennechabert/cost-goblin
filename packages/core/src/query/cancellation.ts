/**
 * Error message the DuckDB worker emits when an in-flight query is cancelled —
 * the UI calls `cancelPendingQueries()` on navigation / param change, and the
 * worker rejects the superseded queries with this exact text. It is expected
 * control flow, not a failure: the renderer retries it ({@link file://use-query.ts})
 * and the desktop telemetry controller filters it out of Sentry.
 *
 * Exported as a single source of truth so the emit site, the renderer's retry
 * check, and the Sentry `ignoreErrors` filter can never drift apart — a reword
 * here updates all three at once instead of silently breaking telemetry and
 * retries.
 */
export const QUERY_CANCELLED_MESSAGE = 'Query cancelled';
