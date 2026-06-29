export type {
  TelemetryPreferences,
  TelemetryStatus,
  TelemetryEventKind,
  TelemetryOutboxEntry,
} from './types.js';
export { TELEMETRY_DEFAULTS, TELEMETRY_TRACES_SAMPLE_RATE, isTelemetryEnabled, parseTelemetryPreferences } from './types.js';
export { redactSensitiveString, isSensitiveKey, redactValueDeep, redactNumeric } from './scrub.js';
export { summarizeEventForOutbox } from './summary.js';
