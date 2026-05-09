import { describe, it, expect } from 'vitest';
import { assertDateString, assertHourString, validateColumnName, validateTablePath, SecurityError } from '../query/identifier-validator.js';
import type { DimensionsConfig } from '../types/config.js';
import { asDimensionId } from '../types/branded.js';

const testDimensions: DimensionsConfig = {
  builtIn: [
    {
      name: asDimensionId('account'),
      label: 'Account',
      field: 'account_id',
      displayField: 'account_name',
    },
    {
      name: asDimensionId('region'),
      label: 'Region',
      field: 'region',
    },
    {
      name: asDimensionId('service'),
      label: 'Service',
      field: 'service',
    },
  ],
  tags: [
    {
      tagName: 'team',
      label: 'Team',
      normalize: 'lowercase-kebab',
    },
    {
      tagName: 'environment',
      label: 'Environment',
      normalize: 'lowercase',
    },
    {
      tagName: 'cost-center',
      label: 'Cost Center',
    },
  ],
};

describe('validateColumnName', () => {
  it('accepts standard CUR columns', () => {
    expect(() => { validateColumnName('usage_date', testDimensions); }).not.toThrow();
    expect(() => { validateColumnName('cost', testDimensions); }).not.toThrow();
    expect(() => { validateColumnName('account_id', testDimensions); }).not.toThrow();
    expect(() => { validateColumnName('line_item_usage_account_id', testDimensions); }).not.toThrow();
  });

  it('accepts built-in dimension fields', () => {
    expect(() => { validateColumnName('account_id', testDimensions); }).not.toThrow();
    expect(() => { validateColumnName('account_name', testDimensions); }).not.toThrow();
    expect(() => { validateColumnName('region', testDimensions); }).not.toThrow();
    expect(() => { validateColumnName('service', testDimensions); }).not.toThrow();
  });

  it('accepts tag columns', () => {
    expect(() => { validateColumnName('tag_team', testDimensions); }).not.toThrow();
    expect(() => { validateColumnName('tag_environment', testDimensions); }).not.toThrow();
    expect(() => { validateColumnName('tag_cost_center', testDimensions); }).not.toThrow();
    expect(() => { validateColumnName('fallback_tag_team', testDimensions); }).not.toThrow();
  });

  it('accepts aggregate and computed columns', () => {
    expect(() => { validateColumnName('entity', testDimensions); }).not.toThrow();
    expect(() => { validateColumnName('total_cost', testDimensions); }).not.toThrow();
    expect(() => { validateColumnName('current_cost', testDimensions); }).not.toThrow();
    expect(() => { validateColumnName('delta', testDimensions); }).not.toThrow();
    expect(() => { validateColumnName('percent_change', testDimensions); }).not.toThrow();
  });

  it('rejects unknown column names', () => {
    expect(() => { validateColumnName('malicious_column', testDimensions); })
      .toThrow(SecurityError);
    expect(() => { validateColumnName('DROP TABLE users', testDimensions); })
      .toThrow(SecurityError);
    expect(() => { validateColumnName('1=1; DROP TABLE--', testDimensions); })
      .toThrow(SecurityError);
  });

  it('throws SecurityError with descriptive message', () => {
    expect(() => { validateColumnName('bad_column', testDimensions); })
      .toThrow('Invalid column name "bad_column" - not in dimensions config allow-list');
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

describe('validateTablePath', () => {
  it('accepts valid daily tier paths', () => {
    expect(() => { validateTablePath('/data/aws/raw/daily-2026-03/*.parquet'); }).not.toThrow();
    expect(() => { validateTablePath('/data/aws/raw/daily-2026-04/*.parquet'); }).not.toThrow();
    expect(() => { validateTablePath('/data/aws/raw/daily-2025-12/*.parquet'); }).not.toThrow();
  });

  it('accepts valid hourly tier paths', () => {
    expect(() => { validateTablePath('/data/aws/raw/hourly-2026-03/*.parquet'); }).not.toThrow();
    expect(() => { validateTablePath('/data/aws/raw/hourly-2026-04/*.parquet'); }).not.toThrow();
  });

  it('accepts valid cost-optimization tier paths', () => {
    expect(() => { validateTablePath('/data/aws/raw/cost-optimization-2026-03/*.parquet'); }).not.toThrow();
  });

  it('accepts wildcard period paths', () => {
    expect(() => { validateTablePath('/data/aws/raw/daily-*/*.parquet'); }).not.toThrow();
    expect(() => { validateTablePath('/data/aws/raw/hourly-*/*.parquet'); }).not.toThrow();
  });

  it('accepts read_parquet wrapped paths', () => {
    expect(() => { validateTablePath("read_parquet('/data/aws/raw/daily-2026-03/*.parquet')"); }).not.toThrow();
    expect(() => { validateTablePath('read_parquet(\'/data/aws/raw/daily-*/*.parquet\')'); }).not.toThrow();
  });

  it('rejects invalid tier names', () => {
    expect(() => { validateTablePath('/data/aws/raw/malicious-2026-03/*.parquet'); })
      .toThrow(SecurityError);
    expect(() => { validateTablePath('/data/aws/raw/DROP-2026-03/*.parquet'); })
      .toThrow(SecurityError);
  });

  it('rejects invalid period formats', () => {
    expect(() => { validateTablePath('/data/aws/raw/daily-2026/*.parquet'); })
      .toThrow(SecurityError);
    expect(() => { validateTablePath('/data/aws/raw/daily-invalid/*.parquet'); })
      .toThrow(SecurityError);
    expect(() => { validateTablePath('/data/aws/raw/daily-2026-13/*.parquet'); })
      .toThrow(SecurityError);
  });

  it('rejects invalid path structure', () => {
    expect(() => { validateTablePath('/data/wrong/path/daily-2026-03/*.parquet'); })
      .toThrow(SecurityError);
    expect(() => { validateTablePath('SELECT * FROM users'); })
      .toThrow(SecurityError);
    expect(() => { validateTablePath('../../../etc/passwd'); })
      .toThrow(SecurityError);
  });

  it('throws SecurityError with descriptive message for invalid tier', () => {
    expect(() => { validateTablePath('/data/aws/raw/invalid-2026-03/*.parquet'); })
      .toThrow('Invalid tier "invalid" in table path');
  });

  it('throws SecurityError with descriptive message for invalid period', () => {
    expect(() => { validateTablePath('/data/aws/raw/daily-badperiod/*.parquet'); })
      .toThrow('Invalid period "badperiod" in table path');
  });
});
