import { isStringRecord } from '../utils/json.js';

/**
 * PII scrubbing primitives for the Sentry `beforeSend` hook.
 *
 * These are pure and framework-free (core takes ZERO dependency on the Sentry
 * SDK) so the security-critical redaction logic can be exhaustively unit-tested
 * with plain objects. The desktop main process composes them over the real
 * Sentry `Event` — see packages/desktop/src/main/telemetry/scrub-event.ts.
 *
 * The guiding rule (SPEC.md): no cost data, tag values, account IDs, team names
 * or business data ever leaves the machine. We therefore redact aggressively and
 * fail closed — when in doubt, a value is replaced rather than forwarded.
 */

const REDACTED = '[redacted]';

// Patterns redacted inside any free-text string (error messages, breadcrumbs,
// stack-frame paths). Each is global so every occurrence is replaced.
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const S3_URI_RE = /s3:\/\/[^\s'"]+/gi;
const ARN_RE = /arn:aws:[^\s'"]+/gi;
// 12-digit AWS account IDs. Lookarounds (not \b) so an ID glued to letters or
// underscores still matches — `acct123456789012`, `id_123456789012` — while a
// longer digit run (a 15-digit number) is left alone rather than partly redacted.
const ACCOUNT_RE = /(?<!\d)\d{12}(?!\d)/g;
const AMOUNT_RE = /\$\s?\d[\d,]*(?:\.\d+)?/g;
// Home directories leak the OS username. Keep the path shape (useful in stack
// traces) but replace the user segment: /Users/jane/… → /Users/[user]/…
const POSIX_HOME_RE = /(\/(?:Users|home)\/)([^/\\\s]+)/g;
const WIN_HOME_RE = /([A-Za-z]:\\Users\\)([^\\/\s]+)/g;

/** Redact sensitive substrings (emails, AWS account IDs, ARNs, S3 URIs, dollar
 *  amounts, home-dir usernames) from a single string. */
export function redactSensitiveString(input: string): string {
  return input
    .replaceAll(EMAIL_RE, '[redacted-email]')
    .replaceAll(S3_URI_RE, 's3://[redacted]')
    .replaceAll(ARN_RE, '[redacted-arn]')
    .replaceAll(ACCOUNT_RE, '[redacted-account]')
    .replaceAll(AMOUNT_RE, '[redacted-amount]')
    .replaceAll(POSIX_HOME_RE, '$1[user]')
    .replaceAll(WIN_HOME_RE, '$1[user]');
}

// Object keys whose VALUE must be dropped wholesale regardless of content —
// secrets, credentials, and direct identifiers we never want to transmit.
const SENSITIVE_KEY_RE =
  /password|passwd|secret|token|api[-_]?key|access[-_]?key|authorization|\bauth\b|cookie|session|credential|private[-_]?key|\bdsn\b|account[-_]?id|email|\barn\b/i;

/** True when a key looks like it holds a secret or direct identifier. */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key);
}

const MAX_DEPTH = 6;

/**
 * Deep-redact an arbitrary JSON-ish value: strings are passed through
 * {@link redactSensitiveString}; object entries under a {@link isSensitiveKey}
 * key are dropped entirely; everything else recurses. Anything past the depth
 * limit, or of an exotic type (function/symbol/bigint), is replaced — fail
 * closed rather than forward something unredacted.
 */
export function redactValueDeep(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (typeof value === 'string') return redactSensitiveString(value);
  if (value === null || value === undefined) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((v) => redactValueDeep(v, depth + 1));
  if (isStringRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSensitiveKey(k) ? REDACTED : redactValueDeep(v, depth + 1);
    }
    return out;
  }
  return REDACTED;
}
