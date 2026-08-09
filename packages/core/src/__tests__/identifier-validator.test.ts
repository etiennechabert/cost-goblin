import { describe, it, expect } from 'vitest';
import { assertBillingPeriod, assertDateString, assertHourString, assertTier, isSafeColumnIdentifier, SecurityError } from '../query/identifier-validator.js';

describe('isSafeColumnIdentifier', () => {
  it('accepts bare snake_case column identifiers', () => {
    for (const col of ['account_id', 'region', 'service_category', 'charge_category', 'commitment_status', '_internal', 'col123']) {
      expect(isSafeColumnIdentifier(col)).toBe(true);
    }
  });

  it('rejects identifiers that could break out of an interpolated SQL position', () => {
    for (const bad of [
      'account_id; DROP TABLE cost_base',
      "account_id') OR 1=1 --",
      'account_id IN (SELECT 1)',
      'MAX(cost)',
      'a b',
      '1cost',
      'résumé',
      '',
      'tag-name',
      'a.b',
    ]) {
      expect(isSafeColumnIdentifier(bad)).toBe(false);
    }
  });
});

describe('assertTier', () => {
  it('accepts the known billing-data tiers', () => {
    expect(() => { assertTier('daily'); }).not.toThrow();
    expect(() => { assertTier('hourly'); }).not.toThrow();
    expect(() => { assertTier('cost-optimization'); }).not.toThrow();
  });

  it('rejects anything outside the tier allow-list', () => {
    expect(() => { assertTier('weekly'); }).toThrow(SecurityError);
    expect(() => { assertTier('Daily'); }).toThrow(SecurityError);
    expect(() => { assertTier(''); }).toThrow(SecurityError);
  });

  it('rejects SQL and path injection attempts', () => {
    expect(() => { assertTier("daily'*') UNION SELECT 1 --"); }).toThrow(SecurityError);
    expect(() => { assertTier('daily/../../etc'); }).toThrow(SecurityError);
  });
});

describe('assertBillingPeriod', () => {
  it('accepts well-formed YYYY-MM periods', () => {
    expect(() => { assertBillingPeriod('2026-01'); }).not.toThrow();
    expect(() => { assertBillingPeriod('2026-12'); }).not.toThrow();
    expect(() => { assertBillingPeriod('1999-06'); }).not.toThrow();
  });

  it('rejects malformed periods', () => {
    expect(() => { assertBillingPeriod('2026-13'); }).toThrow(SecurityError);
    expect(() => { assertBillingPeriod('2026-00'); }).toThrow(SecurityError);
    expect(() => { assertBillingPeriod('2026-1'); }).toThrow(SecurityError);
    expect(() => { assertBillingPeriod('2026-01-01'); }).toThrow(SecurityError);
    expect(() => { assertBillingPeriod('*'); }).toThrow(SecurityError);
    expect(() => { assertBillingPeriod(''); }).toThrow(SecurityError);
  });

  it('rejects SQL and path injection attempts', () => {
    expect(() => { assertBillingPeriod("2026-01'*') UNION SELECT 1 --"); }).toThrow(SecurityError);
    expect(() => { assertBillingPeriod('2026-01/../../../etc/passwd'); }).toThrow(SecurityError);
  });
});

describe('assertDateString', () => {
  it('accepts valid YYYY-MM-DD dates', () => {
    expect(() => { assertDateString('2026-01-01'); }).not.toThrow();
    expect(() => { assertDateString('2026-12-31'); }).not.toThrow();
    expect(() => { assertDateString('2025-06-15'); }).not.toThrow();
  });

  it('rejects invalid formats', () => {
    expect(() => { assertDateString('2026-1-01'); }).toThrow(SecurityError);
    expect(() => { assertDateString('2026-13-01'); }).toThrow(SecurityError);
    expect(() => { assertDateString('2026-00-01'); }).toThrow(SecurityError);
    expect(() => { assertDateString('2026-01-00'); }).toThrow(SecurityError);
    expect(() => { assertDateString('2026-01-32'); }).toThrow(SecurityError);
    expect(() => { assertDateString('not-a-date'); }).toThrow(SecurityError);
    expect(() => { assertDateString(''); }).toThrow(SecurityError);
  });

  it('rejects SQL injection attempts', () => {
    expect(() => { assertDateString("2026-01-01' OR 1=1 --"); }).toThrow(SecurityError);
    expect(() => { assertDateString("2026-01-01'; DROP TABLE cost_base; --"); }).toThrow(SecurityError);
  });
});

describe('assertHourString', () => {
  it('accepts valid YYYY-MM-DD HH:00:00 timestamps', () => {
    expect(() => { assertHourString('2026-04-30 00:00:00'); }).not.toThrow();
    expect(() => { assertHourString('2026-04-30 14:00:00'); }).not.toThrow();
    expect(() => { assertHourString('2026-04-30 23:00:00'); }).not.toThrow();
    expect(() => { assertHourString('2025-12-31 09:00:00'); }).not.toThrow();
  });

  it('rejects non-zero minutes or seconds', () => {
    expect(() => { assertHourString('2026-04-30 14:30:00'); }).toThrow(SecurityError);
    expect(() => { assertHourString('2026-04-30 14:00:01'); }).toThrow(SecurityError);
    expect(() => { assertHourString('2026-04-30 14:00'); }).toThrow(SecurityError);
  });

  it('rejects out-of-range hours and dates', () => {
    expect(() => { assertHourString('2026-04-30 24:00:00'); }).toThrow(SecurityError);
    expect(() => { assertHourString('2026-04-30 99:00:00'); }).toThrow(SecurityError);
    expect(() => { assertHourString('2026-13-30 14:00:00'); }).toThrow(SecurityError);
    expect(() => { assertHourString('2026-04-32 14:00:00'); }).toThrow(SecurityError);
  });

  it('rejects SQL injection attempts', () => {
    expect(() => { assertHourString("2026-04-30 14:00:00' OR 1=1 --"); }).toThrow(SecurityError);
    expect(() => { assertHourString("2026-04-30 14:00:00'; DROP TABLE cost_base; --"); }).toThrow(SecurityError);
    expect(() => { assertHourString(''); }).toThrow(SecurityError);
  });
});
