import { describe, it, expect } from 'vitest';
import { buildCostQuery, buildTrendQuery, buildMissingTagsQuery, buildNonResourceCostQuery, buildEntityDetailQuery, buildDailyCostsQuery } from '../query/builder.js';
import type { DimensionsConfig } from '../types/config.js';
import { asDimensionId, asDateString, asDollars, asEntityRef, asTagValue } from '../types/branded.js';

const dimensions: DimensionsConfig = {
  builtIn: [
    { name: asDimensionId('account'), label: 'Account', field: 'account_id', displayField: 'account_name' },
    { name: asDimensionId('service'), label: 'Service', field: 'service' },
  ],
  tags: [
    {
      tagName: 'org:team',
      label: 'Team',
      concept: 'owner',
      normalize: 'lowercase-kebab',
      aliases: {
        'core-banking': ['core_banking', 'corebanking'],
      },
    },
  ],
};

describe('SQL Injection Prevention', () => {
  describe('Filter values are parameterized', () => {
    it('prevents SQL injection via single quotes in filter values', () => {
      const result = buildCostQuery(
        {
          groupBy: asDimensionId('service'),
          dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') },
          filters: { [asDimensionId('account')]: asTagValue("'; DROP TABLE users; --") },
        },
        '/data',
        dimensions,
      );
      // Value should be in params array, not interpolated in SQL
      expect(result.params).toContain("'; DROP TABLE users; --");
      // SQL should use placeholder, not raw value
      expect(result.sql).toContain('account_id = $');
      expect(result.sql).not.toContain("DROP TABLE");
    });

    it('handles double quotes in filter values safely', () => {
      const result = buildCostQuery(
        {
          groupBy: asDimensionId('service'),
          dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') },
          filters: { [asDimensionId('account')]: asTagValue('test"value"with"quotes') },
        },
        '/data',
        dimensions,
      );
      expect(result.params).toContain('test"value"with"quotes');
      expect(result.sql).toContain('account_id = $');
    });

    it('handles SQL comment sequences in filter values', () => {
      const result = buildCostQuery(
        {
          groupBy: asDimensionId('service'),
          dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') },
          filters: { [asDimensionId('account')]: asTagValue('test--comment') },
        },
        '/data',
        dimensions,
      );
      expect(result.params).toContain('test--comment');
      expect(result.sql).toContain('account_id = $');
    });

    it('handles multi-line values with newlines', () => {
      const result = buildCostQuery(
        {
          groupBy: asDimensionId('service'),
          dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') },
          filters: { [asDimensionId('account')]: asTagValue('test\nvalue\nwith\nnewlines') },
        },
        '/data',
        dimensions,
      );
      expect(result.params).toContain('test\nvalue\nwith\nnewlines');
      expect(result.sql).toContain('account_id = $');
    });

    it('prevents UNION-based injection in filter values', () => {
      const result = buildCostQuery(
        {
          groupBy: asDimensionId('service'),
          dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') },
          filters: { [asDimensionId('service')]: asTagValue("' UNION SELECT password FROM users --") },
        },
        '/data',
        dimensions,
      );
      expect(result.params).toContain("' UNION SELECT password FROM users --");
      expect(result.sql).not.toContain('UNION SELECT password');
    });

    it('handles semicolons in filter values (command injection attempt)', () => {
      const result = buildCostQuery(
        {
          groupBy: asDimensionId('service'),
          dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') },
          filters: { [asDimensionId('service')]: asTagValue("test'; DELETE FROM accounts; SELECT '") },
        },
        '/data',
        dimensions,
      );
      expect(result.params).toContain("test'; DELETE FROM accounts; SELECT '");
      expect(result.sql).not.toContain('DELETE FROM');
    });
  });

  describe('Date values are parameterized', () => {
    it('prevents SQL injection via date range start', () => {
      const result = buildCostQuery(
        {
          groupBy: asDimensionId('service'),
          dateRange: { start: asDateString("2026-01-01' OR '1'='1"), end: asDateString('2026-01-31') },
          filters: {},
        },
        '/data',
        dimensions,
      );
      // Date should be in params, not interpolated
      expect(result.params).toContain("2026-01-01' OR '1'='1");
      expect(result.sql).toContain('usage_date BETWEEN $');
      expect(result.sql).not.toContain("OR '1'='1");
    });

    it('prevents SQL injection via date range end', () => {
      const result = buildCostQuery(
        {
          groupBy: asDimensionId('service'),
          dateRange: { start: asDateString('2026-01-01'), end: asDateString("2026-01-31'; DROP TABLE costs; --") },
          filters: {},
        },
        '/data',
        dimensions,
      );
      expect(result.params).toContain("2026-01-31'; DROP TABLE costs; --");
      expect(result.sql).not.toContain('DROP TABLE');
    });
  });

  describe('Numeric values are parameterized', () => {
    it('prevents injection via topN parameter in buildCostQuery', () => {
      const result = buildCostQuery(
        {
          groupBy: asDimensionId('service'),
          dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') },
          filters: {},
        },
        '/data',
        dimensions,
        5, // topN
      );
      expect(result.params).toContain(5);
      expect(result.sql).toContain('LIMIT $');
    });

    it('prevents injection via deltaThreshold in buildTrendQuery', () => {
      const result = buildTrendQuery(
        {
          groupBy: asDimensionId('service'),
          dateRange: { start: asDateString('2026-02-01'), end: asDateString('2026-02-28') },
          filters: {},
          deltaThreshold: asDollars(100),
          percentThreshold: 10,
        },
        '/data',
        dimensions,
      );
      expect(result.params).toContain(100);
      expect(result.sql).toContain('ABS(COALESCE(c.total_cost, 0) - COALESCE(p.total_cost, 0)) >= $');
    });

    it('prevents injection via minCost in buildMissingTagsQuery', () => {
      const result = buildMissingTagsQuery(
        {
          dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') },
          filters: {},
          minCost: asDollars(50),
          tagDimension: asDimensionId('tag_org_team'),
        },
        '/data',
        dimensions,
      );
      expect(result.params).toContain(50);
      expect(result.sql).toContain('r.cost >= $');
    });
  });

  describe('Entity values are parameterized', () => {
    it('prevents SQL injection via entity parameter in buildEntityDetailQuery', () => {
      const result = buildEntityDetailQuery(
        {
          dimension: asDimensionId('service'),
          entity: asEntityRef("EC2'; DROP TABLE costs; --"),
          dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') },
          filters: {},
        },
        '/data',
        dimensions,
      );
      expect(result.params).toContain("EC2'; DROP TABLE costs; --");
      expect(result.sql).not.toContain('DROP TABLE');
    });

    it('handles special characters in entity values', () => {
      const result = buildEntityDetailQuery(
        {
          dimension: asDimensionId('service'),
          entity: asEntityRef("test'value\"with;special--chars"),
          dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') },
          filters: {},
        },
        '/data',
        dimensions,
      );
      expect(result.params).toContain("test'value\"with;special--chars");
    });
  });

  describe('Multiple parameters are safely handled', () => {
    it('handles multiple filter values with injection attempts', () => {
      const result = buildCostQuery(
        {
          groupBy: asDimensionId('service'),
          dateRange: { start: asDateString("2026-01-01' OR 1=1 --"), end: asDateString("2026-01-31'; DROP TABLE x; --") },
          filters: {
            [asDimensionId('account')]: asTagValue("'; DELETE FROM users; --"),
            [asDimensionId('service')]: asTagValue("' UNION SELECT * FROM secrets --"),
          },
        },
        '/data',
        dimensions,
      );
      // All malicious values should be in params array
      expect(result.params).toContain("2026-01-01' OR 1=1 --");
      expect(result.params).toContain("2026-01-31'; DROP TABLE x; --");
      expect(result.params).toContain("'; DELETE FROM users; --");
      expect(result.params).toContain("' UNION SELECT * FROM secrets --");
      // SQL should not contain any of the injection payloads
      expect(result.sql).not.toContain('DROP TABLE');
      expect(result.sql).not.toContain('DELETE FROM');
      expect(result.sql).not.toContain('UNION SELECT');
      expect(result.sql).not.toContain('OR 1=1');
    });

    it('maintains correct parameter ordering with multiple injections', () => {
      const result = buildDailyCostsQuery(
        {
          groupBy: asDimensionId('service'),
          dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') },
          filters: {
            [asDimensionId('account')]: asTagValue("malicious'value"),
            [asDimensionId('service')]: asTagValue("another'injection"),
          },
        },
        '/data',
        dimensions,
      );
      // Verify all parameters are present (filters are added first, then dates)
      expect(result.params).toContain("malicious'value");
      expect(result.params).toContain("another'injection");
      expect(result.params).toContain('2026-01-01');
      expect(result.params).toContain('2026-01-31');
      // Verify we have exactly 4 parameters
      expect(result.params.length).toBe(4);
    });
  });

  describe('Non-parameterizable identifiers are validated', () => {
    it('accepts valid dimension IDs', () => {
      const validResult = buildCostQuery(
        {
          groupBy: asDimensionId('service'),
          dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') },
          filters: {},
        },
        '/data',
        dimensions,
      );
      expect(validResult.sql).toContain('service AS entity');
    });

    it('rejects unknown dimension IDs with SecurityError', () => {
      expect(() => buildCostQuery(
        {
          groupBy: asDimensionId("fake_column'; DROP TABLE users; --"),
          dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') },
          filters: {},
        },
        '/data',
        dimensions,
      )).toThrow('Unknown dimension');
    });
  });

  describe('Edge cases and special characters', () => {
    it('handles null bytes in filter values', () => {
      const result = buildCostQuery(
        {
          groupBy: asDimensionId('service'),
          dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') },
          filters: { [asDimensionId('account')]: asTagValue('test\x00value') },
        },
        '/data',
        dimensions,
      );
      expect(result.params).toContain('test\x00value');
    });

    it('handles Unicode characters in filter values', () => {
      const result = buildCostQuery(
        {
          groupBy: asDimensionId('service'),
          dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') },
          filters: { [asDimensionId('account')]: asTagValue('test-值-🔒-value') },
        },
        '/data',
        dimensions,
      );
      expect(result.params).toContain('test-值-🔒-value');
    });

    it('handles backslashes in filter values', () => {
      const result = buildCostQuery(
        {
          groupBy: asDimensionId('service'),
          dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') },
          filters: { [asDimensionId('account')]: asTagValue('test\\value\\with\\backslashes') },
        },
        '/data',
        dimensions,
      );
      expect(result.params).toContain('test\\value\\with\\backslashes');
    });

    it('handles percent signs (LIKE injection attempt)', () => {
      const result = buildCostQuery(
        {
          groupBy: asDimensionId('service'),
          dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') },
          filters: { [asDimensionId('account')]: asTagValue('%malicious%') },
        },
        '/data',
        dimensions,
      );
      expect(result.params).toContain('%malicious%');
    });

    it('handles empty string filter values', () => {
      const result = buildCostQuery(
        {
          groupBy: asDimensionId('service'),
          dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') },
          filters: { [asDimensionId('account')]: asTagValue('') },
        },
        '/data',
        dimensions,
      );
      expect(result.params).toContain('');
    });
  });

  describe('Data path validation', () => {
    it('does not parameterize data directory paths', () => {
      // Data directory is a trusted value from config, not user input
      const result = buildCostQuery(
        {
          groupBy: asDimensionId('service'),
          dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') },
          filters: {},
        },
        '/data',
        dimensions,
      );
      // Path should be in SQL, not params
      expect(result.sql).toContain('/data/aws/raw/');
      expect(result.params).not.toContain('/data');
    });

    it('includes data directory path in SQL structure', () => {
      const result = buildCostQuery(
        {
          groupBy: asDimensionId('service'),
          dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') },
          filters: {},
        },
        '/custom/path',
        dimensions,
      );
      expect(result.sql).toContain('/custom/path/aws/raw/');
    });
  });

  describe('Query structure integrity', () => {
    it('maintains valid SQL structure with injected values', () => {
      const result = buildCostQuery(
        {
          groupBy: asDimensionId('service'),
          dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') },
          filters: { [asDimensionId('service')]: asTagValue("'; DROP TABLE x; SELECT '") },
        },
        '/data',
        dimensions,
      );
      // SQL should contain proper WHERE clause
      expect(result.sql).toContain('WHERE');
      // SQL should contain proper SELECT structure
      expect(result.sql).toMatch(/SELECT[\s\S]+FROM[\s\S]+WHERE/);
      // All parameter placeholders should be numbered sequentially
      const placeholders = result.sql.match(/\$\d+/g);
      expect(placeholders).toBeTruthy();
      if (placeholders !== null) {
        expect(placeholders.length).toBe(result.params.length);
      }
    });

    it('uses sequential parameter numbering', () => {
      const result = buildTrendQuery(
        {
          groupBy: asDimensionId('service'),
          dateRange: { start: asDateString('2026-02-01'), end: asDateString('2026-02-28') },
          filters: {
            [asDimensionId('account')]: asTagValue('test1'),
            [asDimensionId('service')]: asTagValue('test2'),
          },
          deltaThreshold: asDollars(100),
          percentThreshold: 10,
        },
        '/data',
        dimensions,
      );
      // Extract all placeholders
      const placeholders = result.sql.match(/\$(\d+)/g);
      expect(placeholders).toBeTruthy();
      if (placeholders !== null) {
        // Convert to numbers and verify they're sequential
        const numbers = placeholders.map(p => parseInt(p.slice(1), 10));
        const maxNumber = Math.max(...numbers);
        expect(maxNumber).toBe(result.params.length);
        // Verify no gaps in numbering (each number from 1 to max should appear)
        for (let i = 1; i <= maxNumber; i++) {
          expect(numbers).toContain(i);
        }
      }
    });
  });

  describe('buildNonResourceCostQuery security', () => {
    it('parameterizes date and filter values', () => {
      const result = buildNonResourceCostQuery(
        {
          dateRange: { start: asDateString("2026-01-01' OR 1=1 --"), end: asDateString('2026-01-31') },
          filters: { [asDimensionId('account')]: asTagValue("'; DROP TABLE x; --") },
          minCost: asDollars(0),
          tagDimension: asDimensionId('tag_org_team'),
        },
        '/data',
        dimensions,
      );
      expect(result.params).toContain("2026-01-01' OR 1=1 --");
      expect(result.params).toContain("'; DROP TABLE x; --");
      expect(result.sql).not.toContain('DROP TABLE');
      expect(result.sql).not.toContain('OR 1=1');
    });
  });
});
