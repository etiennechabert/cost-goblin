import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIdleTracker } from '../peer/secure-server.js';

describe('createIdleTracker', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('fires once the timeout elapses with no request in flight', () => {
    const onIdle = vi.fn<() => void>();
    const tracker = createIdleTracker(60_000, onIdle);
    tracker.arm();
    vi.advanceTimersByTime(59_999);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  // setTimeout runs on a clock that stops while the machine sleeps, so a
  // single full-length timer let the listener outlive the deadline it
  // advertised by however long the machine slept. The wall clock is what the
  // UI shows, so it is what must end the session.
  it('stops soon after the wall-clock deadline passes during a sleep', () => {
    const onIdle = vi.fn<() => void>();
    const tracker = createIdleTracker(30 * 60_000, onIdle);
    tracker.arm();
    const deadline = tracker.deadline();
    expect(deadline).not.toBeNull();
    // Sleep: the wall clock jumps past the deadline, the timer clock does not.
    vi.setSystemTime((deadline ?? 0) + 60_000);
    vi.advanceTimersByTime(30_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('re-arms instead of firing while a request is in flight', () => {
    const onIdle = vi.fn<() => void>();
    const tracker = createIdleTracker(1_000, onIdle);
    tracker.arm();
    tracker.requestStarted();
    vi.advanceTimersByTime(1_000);
    expect(onIdle).not.toHaveBeenCalled();
    tracker.requestEnded();
    vi.advanceTimersByTime(1_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });
});
