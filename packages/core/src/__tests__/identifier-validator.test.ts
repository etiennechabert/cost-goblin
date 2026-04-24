import { describe, it, expect } from 'vitest';
import { validateColumnName, validateTablePath, SecurityError } from '../query/identifier-validator.js';
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
