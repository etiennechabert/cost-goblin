import { describe, it, expect } from 'vitest';
import { formatBytes } from '../components/format.js';

describe('formatBytes', () => {
  it('formats within each unit with sensible precision', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(5_000_000)).toBe('4.8 MB');
    expect(formatBytes(1_500_000)).toBe('1.4 MB');
    // Large values within a unit drop the decimal.
    expect(formatBytes(150 * 1024 * 1024)).toBe('150 MB');
  });

  it('rolls over to the next unit instead of rendering "1024 MB"', () => {
    // Just under 1 GiB rounds up at MB precision — must promote to GB.
    expect(formatBytes(1024 * 1024 * 1024 - 1)).toBe('1.0 GB');
    expect(formatBytes(1024)).toBe('1.0 KB');
  });

  it('never returns a negative size', () => {
    expect(formatBytes(-100)).toBe('0 B');
  });
});
