import { describe, it, expect } from 'vitest';
import { coveredDaysInRange } from '../query/coverage.js';
import { asProviderName } from '../types/branded.js';

const AWS = asProviderName('aws-main');
const GCP = asProviderName('gcp-main');

describe('coveredDaysInRange', () => {
  it('counts every day of a range inside synced months', () => {
    const providers = [{ name: AWS, availablePeriods: ['2026-01', '2026-02', '2026-03'] }];
    expect(coveredDaysInRange({ start: '2026-01-04', end: '2026-01-31' }, providers)).toBe(28);
    expect(coveredDaysInRange({ start: '2026-01-15', end: '2026-03-14' }, providers)).toBe(59);
  });

  it('leaves out the days before the first synced month', () => {
    // Data starts in February: Jan 18-31 is missing, Feb 1-14 is there.
    const providers = [{ name: AWS, availablePeriods: ['2026-02', '2026-03'] }];
    expect(coveredDaysInRange({ start: '2026-01-18', end: '2026-02-14' }, providers)).toBe(14);
    expect(coveredDaysInRange({ start: '2025-12-01', end: '2026-01-31' }, providers)).toBe(0);
  });

  it('leaves out a month missing in the middle', () => {
    const providers = [{ name: AWS, availablePeriods: ['2026-01', '2026-03'] }];
    expect(coveredDaysInRange({ start: '2026-01-01', end: '2026-03-31' }, providers)).toBe(31 + 31);
  });

  it('counts a leap February in full', () => {
    const providers = [{ name: AWS, availablePeriods: ['2028-02'] }];
    expect(coveredDaysInRange({ start: '2028-02-01', end: '2028-02-29' }, providers)).toBe(29);
  });

  it('takes a month any provider holds', () => {
    // GCP was added in March; January is still covered by AWS.
    const providers = [
      { name: AWS, availablePeriods: ['2026-01', '2026-02', '2026-03'] },
      { name: GCP, availablePeriods: ['2026-03'] },
    ];
    expect(coveredDaysInRange({ start: '2026-01-01', end: '2026-01-31' }, providers)).toBe(31);
    // ...and a later provider's months count where the first has none.
    const lateFirst = [
      { name: AWS, availablePeriods: ['2025-06'] },
      { name: GCP, availablePeriods: ['2026-03'] },
    ];
    expect(coveredDaysInRange({ start: '2026-03-01', end: '2026-03-10' }, lateFirst)).toBe(10);
  });

  it('treats a provider with unknown months as covering the whole range', () => {
    expect(coveredDaysInRange({ start: '2026-01-01', end: '2026-01-31' }, [{ name: AWS }])).toBe(31);
  });

  it('covers nothing without providers, or for an invalid or reversed range', () => {
    const providers = [{ name: AWS, availablePeriods: ['2026-01'] }];
    expect(coveredDaysInRange({ start: '2026-01-01', end: '2026-01-31' }, [])).toBe(0);
    expect(coveredDaysInRange({ start: '2026-01-31', end: '2026-01-01' }, providers)).toBe(0);
    expect(coveredDaysInRange({ start: 'not-a-date', end: '2026-01-31' }, providers)).toBe(0);
  });
});
