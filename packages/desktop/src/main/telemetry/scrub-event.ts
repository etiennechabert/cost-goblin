import type { Event } from '@sentry/electron/main';
import { isStringRecord, isSensitiveKey, redactSensitiveString, redactValueDeep } from '@costgoblin/core';

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
  if (typeof event.transaction === 'string') event.transaction = redactSensitiveString(event.transaction);

  // Exceptions: scrub the message and every stack frame; drop local variables
  // and surrounding source context (highest-risk for leaking data literals).
  for (const ex of event.exception?.values ?? []) {
    if (typeof ex.value === 'string') ex.value = redactSensitiveString(ex.value);
    for (const frame of ex.stacktrace?.frames ?? []) {
      if (typeof frame.filename === 'string') frame.filename = redactSensitiveString(frame.filename);
      if (typeof frame.abs_path === 'string') frame.abs_path = redactSensitiveString(frame.abs_path);
      if (typeof frame.module === 'string') frame.module = redactSensitiveString(frame.module);
      if (typeof frame.context_line === 'string') frame.context_line = redactSensitiveString(frame.context_line);
      delete frame.vars;
      delete frame.pre_context;
      delete frame.post_context;
    }
  }

  // Breadcrumbs: scrub the message and deep-redact structured data.
  for (const crumb of event.breadcrumbs ?? []) {
    if (typeof crumb.message === 'string') crumb.message = redactSensitiveString(crumb.message);
    if (crumb.data !== undefined) {
      const scrubbed = redactValueDeep(crumb.data);
      if (isStringRecord(scrubbed)) crumb.data = { ...scrubbed };
    }
  }

  // Tags: drop secret-bearing keys, pattern-scrub the rest.
  if (event.tags) {
    for (const [key, value] of Object.entries(event.tags)) {
      if (isSensitiveKey(key)) event.tags[key] = '[redacted]';
      else if (typeof value === 'string') event.tags[key] = redactSensitiveString(value);
    }
  }

  // Contexts: allowlist the low-PII, debugging-useful ones; drop the rest
  // (e.g. `device` carries the hostname). Rebuilt rather than delete-in-loop so
  // we keep the typed shape and avoid dynamic property deletion.
  if (event.contexts) {
    const allowed = new Set(['os', 'runtime', 'app', 'trace']);
    const kept: NonNullable<Event['contexts']> = {};
    for (const [key, value] of Object.entries(event.contexts)) {
      if (allowed.has(key) && value !== undefined) kept[key] = value;
    }
    event.contexts = kept;
  }
}
