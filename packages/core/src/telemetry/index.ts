export type {
  TelemetryPreferences,
  TelemetryStatus,
  TelemetryEventKind,
  TelemetryOutboxEntry,
} from './types.js';
export { TELEMETRY_DEFAULTS, isTelemetryEnabled, parseTelemetryPreferences } from './types.js';
export { redactSensitiveString, isSensitiveKey, redactValueDeep, redactNumeric } from './scrub.js';
export { summarizeEventForOutbox } from './summary.js';
