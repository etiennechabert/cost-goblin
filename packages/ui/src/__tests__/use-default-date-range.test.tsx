import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LAG_DAYS, asDateString } from '@costgoblin/core/browser';
import { getDefaultDateRange } from '../components/date-range-picker.js';
import type { DateRange } from '../components/date-range-picker.js';
import { useDefaultDateRange } from '../hooks/use-default-date-range.js';
import type { LagDaysState } from '../hooks/use-lag-days.js';

const NOT_LOADED: LagDaysState = { loaded: false, lagDays: DEFAULT_LAG_DAYS };

function loaded(lagDays: number): LagDaysState {
  return { loaded: true, lagDays };
}

const PICKED: DateRange = { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') };

function renderRange(lag: LagDaysState) {
  return renderHook(({ lag: current }) => useDefaultDateRange(current), { initialProps: { lag } });
}

// Pin the clock so the default the hook computes and the one each assertion
// recomputes can't straddle a UTC midnight. Only Date is faked.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-03-15T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useDefaultDateRange', () => {
  it('seeds the default window for the lag in force, untouched', () => {
    const { result } = renderRange(NOT_LOADED);
    expect(result.current[0]).toEqual(getDefaultDateRange(DEFAULT_LAG_DAYS));
    expect(result.current[2]).toBe(false);
  });

  it('re-seeds the default for the configured lag once it arrives', () => {
    const { result, rerender } = renderRange(NOT_LOADED);
    rerender({ lag: loaded(5) });
    expect(result.current[0]).toEqual(getDefaultDateRange(5));
    expect(result.current[0]).toEqual({ start: '2026-02-08', end: '2026-03-10' });
    // A re-seed is still the default, not a range anyone chose.
    expect(result.current[2]).toBe(false);
  });

  it('keeps the seeded range object when the configured lag is the default one', () => {
    // Effects keyed on the range must not re-run for a lag that changes nothing.
    const { result, rerender } = renderRange(NOT_LOADED);
    const seeded = result.current[0];
    rerender({ lag: loaded(DEFAULT_LAG_DAYS) });
    expect(result.current[0]).toBe(seeded);
  });

  it('seeds an already-loaded lag directly', () => {
    const { result } = renderRange(loaded(5));
    expect(result.current[0]).toEqual(getDefaultDateRange(5));
  });

  it('never overwrites a range set before the configured lag arrives', () => {
    const { result, rerender } = renderRange(NOT_LOADED);
    act(() => { result.current[1](PICKED); });
    expect(result.current[2]).toBe(true);

    rerender({ lag: loaded(5) });
    expect(result.current[0]).toEqual(PICKED);
    expect(result.current[2]).toBe(true);
  });

  it('marks the range touched even when it is set to the default value', () => {
    // E.g. the picker's "Last 30 days" before the lag arrives: an explicit
    // choice, so the configured lag must not move it.
    const { result, rerender } = renderRange(NOT_LOADED);
    act(() => { result.current[1](getDefaultDateRange(DEFAULT_LAG_DAYS)); });
    rerender({ lag: loaded(5) });
    expect(result.current[0]).toEqual(getDefaultDateRange(DEFAULT_LAG_DAYS));
    expect(result.current[2]).toBe(true);
  });

  it('re-seeds once: a later lag change leaves the range alone', () => {
    const { result, rerender } = renderRange(NOT_LOADED);
    rerender({ lag: loaded(5) });
    rerender({ lag: loaded(7) });
    expect(result.current[0]).toEqual(getDefaultDateRange(5));
  });

  it('keeps the setter stable across renders and re-seeds', () => {
    const { result, rerender } = renderRange(NOT_LOADED);
    const setter = result.current[1];
    rerender({ lag: loaded(5) });
    expect(result.current[1]).toBe(setter);
  });
});
