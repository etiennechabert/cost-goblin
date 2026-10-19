import { describe, expect, it } from 'vitest';
import { TELEMETRY_TRACES_SAMPLE_RATE_DEV, TELEMETRY_TRACES_SAMPLE_RATE_PROD, resolveTracesSampleRate } from '../telemetry/types.js';

describe('resolveTracesSampleRate', () => {
  it('samples every trace in local development', () => {
    expect(resolveTracesSampleRate(true)).toBe(1);
    expect(TELEMETRY_TRACES_SAMPLE_RATE_DEV).toBe(1);
  });

  it('samples a tenth of traces in a packaged build', () => {
    expect(resolveTracesSampleRate(false)).toBe(0.1);
    expect(TELEMETRY_TRACES_SAMPLE_RATE_PROD).toBe(0.1);
  });
});
