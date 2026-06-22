import { describe, it, expect } from 'vitest';
import {
  MAX_MEMORY_GB,
  MIN_MEMORY_GB,
  clampMemoryGB,
  clampThreads,
  computeDefaultMemoryGB,
  computeDefaultThreads,
  maxThreads,
  resolveMemoryGB,
  resolveThreads,
  totalMemoryGB,
} from '../main/duckdb-tuning.js';

describe('duckdb-tuning defaults', () => {
  it('memory default stays within [MIN, MAX] and never exceeds total RAM', () => {
    const def = computeDefaultMemoryGB();
    expect(def).toBeGreaterThanOrEqual(MIN_MEMORY_GB);
    expect(def).toBeLessThanOrEqual(MAX_MEMORY_GB);
    expect(def).toBeLessThanOrEqual(totalMemoryGB());
  });

  it('thread default is at least 1 and at most the logical core count', () => {
    const def = computeDefaultThreads();
    expect(def).toBeGreaterThanOrEqual(1);
    expect(def).toBeLessThanOrEqual(maxThreads());
  });
});

describe('clampMemoryGB', () => {
  it('floors at MIN_MEMORY_GB', () => {
    expect(clampMemoryGB(0)).toBe(MIN_MEMORY_GB);
    expect(clampMemoryGB(-10)).toBe(MIN_MEMORY_GB);
  });
  it('caps at min(MAX_MEMORY_GB, total RAM)', () => {
    const ceiling = Math.min(MAX_MEMORY_GB, totalMemoryGB());
    expect(clampMemoryGB(10_000)).toBe(ceiling);
  });
  it('rounds and passes through in-range values', () => {
    const ceiling = Math.min(MAX_MEMORY_GB, totalMemoryGB());
    if (ceiling >= 3) expect(clampMemoryGB(3)).toBe(3);
    expect(clampMemoryGB(2.4)).toBe(2);
  });
});

describe('clampThreads', () => {
  it('floors at 1 and caps at the logical core count', () => {
    expect(clampThreads(0)).toBe(1);
    expect(clampThreads(-3)).toBe(1);
    expect(clampThreads(10_000)).toBe(maxThreads());
  });
});

describe('resolve* (override ?? default)', () => {
  it('uses the computed default when override is null/undefined', () => {
    expect(resolveMemoryGB(null)).toBe(computeDefaultMemoryGB());
    expect(resolveMemoryGB(undefined)).toBe(computeDefaultMemoryGB());
    expect(resolveThreads(null)).toBe(computeDefaultThreads());
    expect(resolveThreads(undefined)).toBe(computeDefaultThreads());
  });
  it('uses the clamped override when provided', () => {
    expect(resolveMemoryGB(10_000)).toBe(clampMemoryGB(10_000));
    expect(resolveThreads(10_000)).toBe(clampThreads(10_000));
  });
});
