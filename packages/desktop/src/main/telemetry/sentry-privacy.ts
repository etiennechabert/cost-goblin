import type { ElectronMainOptions } from '@sentry/electron/main';

/**
 * What the Sentry SDK may attach on its own, before `scrubEvent` ever sees an
 * event. Sentry 11 replaced `sendDefaultPii: false` with these per-category
 * switches, and every one of them defaults to ON (`resolveDataCollectionOptions`
 * in @sentry/core), so each is turned off explicitly. Shared by the main and
 * renderer `Sentry.init` calls: the renderer's client collects with its own
 * options before forwarding to main. `frameContextLines` stays at Sentry's
 * default of 5: it is our own bundled source around a stack frame, as the
 * ContextLines integration sent before. `Required` makes a category a later
 * Sentry release adds (on by default) a type error here until it is decided.
 */
export const SENTRY_DATA_COLLECTION: Required<NonNullable<ElectronMainOptions['dataCollection']>> = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  // Sentry's MCP server instrumentation (the bundled MCP server): tool
  // arguments and results are cost queries and their answers.
  mcp: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  // Local variables can hold cost rows, account ids and file paths.
  stackFrameVariables: false,
  frameContextLines: 5,
};

/**
 * Sentry 11 streams spans by default, and a streamed span is no event: it
 * skips the main process's transaction gate (an event processor, see
 * `TelemetryController.transactionGate`), so it would leave without the
 * channel gate, scrub and audit-outbox copy. The static lifecycle keeps every
 * trace a transaction event that goes through them. If a later major drops
 * the static lifecycle, the gate has to move to the span stream first: span
 * hooks (`beforeSendSpan`) see spans one at a time and cannot drop them.
 */
export const SENTRY_TRACE_LIFECYCLE = 'static';
