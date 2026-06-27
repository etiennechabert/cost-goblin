import type { Event } from '@sentry/electron/main';
import { isStringRecord, isSensitiveKey, redactNumeric, redactSensitiveString, redactValueDeep } from '@costgoblin/core';

/**
 * Sentry `beforeSend` PII scrub, applied in place to the real Sentry `Event`.
 *
 * The value-level redaction (regex patterns, deep object walk) lives in
 * `@costgoblin/core` where it's exhaustively unit-tested and framework-free;
 * this function is the thin, typed mapping over the SDK's event shape. It is
 * deliberately aggressive — fields that could carry cost data, account IDs, tag
 * values or local machine details are dropped outright (SPEC.md telemetry data
 * principles).
 */
type ExceptionValue = NonNullable<NonNullable<Event['exception']>['values']>[number];
type StackFrame = NonNullable<NonNullable<ExceptionValue['stacktrace']>['frames']>[number];

/** Scrub one stack frame in place: pattern-redact the textual fields and drop
 *  local variables + surrounding source lines (highest-risk for data literals).
 *  Shared by exception and thread stacktraces. */
function scrubFrame(frame: StackFrame): void {
  if (typeof frame.filename === 'string') frame.filename = redactSensitiveString(frame.filename);
  if (typeof frame.abs_path === 'string') frame.abs_path = redactSensitiveString(frame.abs_path);
  if (typeof frame.module === 'string') frame.module = redactSensitiveString(frame.module);
  if (typeof frame.context_line === 'string') frame.context_line = redactSensitiveString(frame.context_line);
  delete frame.vars;
  delete frame.pre_context;
  delete frame.post_context;
}

export function redactEventInPlace(event: Event): void {
  // Direct-identifier / machine-detail fields: drop wholesale.
  delete event.user;
  delete event.request;
  delete event.server_name;
  delete event.extra;

  // Free-text fields that may quote business data.
  if (typeof event.message === 'string') event.message = redactSensitiveString(event.message);
  if (event.logentry && typeof event.logentry.message === 'string') {
    event.logentry.message = redactSensitiveString(event.logentry.message);
  }
  // Structured-log params land verbatim from `captureMessage('… %s', value)`.
  if (event.logentry?.params) event.logentry.params = event.logentry.params.map((p) => redactValueDeep(p));
  if (typeof event.transaction === 'string') event.transaction = redactSensitiveString(event.transaction);
  // Fingerprints can be set with dynamic values.
  if (event.fingerprint) event.fingerprint = event.fingerprint.map((f) => redactSensitiveString(f));

  // Exceptions and threads share a stack-frame shape — scrub both. (Native
  // crashes / profiling populate `threads`; JS errors populate `exception`.)
  for (const ex of event.exception?.values ?? []) {
    if (typeof ex.value === 'string') ex.value = redactSensitiveString(ex.value);
    for (const frame of ex.stacktrace?.frames ?? []) scrubFrame(frame);
  }
  for (const thread of event.threads?.values ?? []) {
    for (const frame of thread.stacktrace?.frames ?? []) scrubFrame(frame);
  }

  // Transactions: span descriptions (often the operation / SQL shape) and span
  // data (HTTP hosts, S3 URIs, file paths) are scrubbed in place.
  for (const span of event.spans ?? []) {
    if (typeof span.description === 'string') span.description = redactSensitiveString(span.description);
    for (const [key, value] of Object.entries(span.data)) {
      if (isSensitiveKey(key)) span.data[key] = '[redacted]';
      else if (typeof value === 'string') span.data[key] = redactSensitiveString(value);
      else if (typeof value === 'number') span.data[key] = redactNumeric(value);
      else if (typeof value === 'object') {
        // Arrays and objects can hide PII (e.g. an account ID in ['123456789012'])
        // and don't fit the string scrub or the homogeneous SpanAttributeValue
        // array types, so fail closed and drop them. Booleans carry no PII.
        span.data[key] = '[redacted]';
      }
    }
  }

  // Breadcrumbs: scrub the message and deep-redact structured data.
  for (const crumb of event.breadcrumbs ?? []) {
    if (typeof crumb.message === 'string') crumb.message = redactSensitiveString(crumb.message);
    if (crumb.data !== undefined) {
      const scrubbed = redactValueDeep(crumb.data);
      // redactValueDeep returns a redacted record for a record. For any off-type
      // runtime value (e.g. a top-level array) fail closed to {} rather than
      // leave the ORIGINAL unredacted value in place.
      crumb.data = isStringRecord(scrubbed) ? { ...scrubbed } : {};
    }
  }

  // Tags: drop secret-bearing keys, pattern-scrub the rest.
  if (event.tags) {
    for (const [key, value] of Object.entries(event.tags)) {
      if (isSensitiveKey(key)) event.tags[key] = '[redacted]';
      else if (typeof value === 'string') event.tags[key] = redactSensitiveString(value);
      else if (typeof value === 'number') event.tags[key] = redactNumeric(value);
    }
  }

  // Contexts: allowlist the low-PII, debugging-useful ones; drop the rest
  // (e.g. `device` carries the hostname). Kept values are still deep-redacted —
  // `trace` carries a span description/data that can quote a query or path.
  // Rebuilt rather than delete-in-loop so we keep the typed shape.
  if (event.contexts) {
    const allowed = new Set(['os', 'runtime', 'app', 'trace']);
    const kept: NonNullable<Event['contexts']> = {};
    for (const [key, value] of Object.entries(event.contexts)) {
      if (!allowed.has(key) || value === undefined) continue;
      const scrubbed = redactValueDeep(value);
      if (isStringRecord(scrubbed)) kept[key] = scrubbed;
    }
    event.contexts = kept;
  }
}
