import { vi } from 'vitest';
import { telemetry } from '../../main/telemetry/controller.js';
import { startedSpans } from './electron-fake.js';

/**
 * Arms performance tracing for one test, as a user who opted in at boot
 * would, so the span helpers reach the fake Sentry SDK, and empties its record
 * of started spans. `vi.restoreAllMocks()` disarms it. The test file mocks
 * `electron` and `@sentry/electron/main` with the fakes in electron-fake.ts.
 */
export function armTracing(): void {
  startedSpans.splice(0);
  vi.spyOn(telemetry, 'isTracingActive').mockReturnValue(true);
}
