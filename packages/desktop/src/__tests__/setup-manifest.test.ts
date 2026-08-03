import { describe, expect, it } from 'vitest';
import {
  REQUIRED_FOCUS_COLUMNS,
  classifyManifestColumns,
  parseManifestColumnNames,
  selectManifestKey,
} from '../main/setup-manifest.js';

// Shapes taken from a live AWS FOCUS 1.2 Data Export (see PR #526): the
// metadata/ dir carries BOTH {export}-Manifest.json (a `columns` array of
// {name, type}) and a {export}-Manifest-FOCUS.json sidecar with a different
// shape (Schema.ColumnDefinition) that parses as zero columns.
const focusManifest = JSON.stringify({
  columns: REQUIRED_FOCUS_COLUMNS.map(name => ({ name, type: 'STRING' })),
});

const focusSidecar = JSON.stringify({
  Schema: { ColumnDefinition: REQUIRED_FOCUS_COLUMNS.map(name => ({ ColumnName: name })) },
});

const curManifest = JSON.stringify({
  columns: [
    { name: 'line_item_usage_start_date', type: 'TIMESTAMP' },
    { name: 'line_item_unblended_cost', type: 'DOUBLE' },
    { name: 'bill_billing_period_start_date', type: 'TIMESTAMP' },
    { name: 'product_servicecode', type: 'STRING' },
  ],
});

describe('classifyManifestColumns', () => {
  it('classifies a complete FOCUS 1.2 column list as daily with nothing missing', () => {
    expect(classifyManifestColumns([...REQUIRED_FOCUS_COLUMNS]))
      .toEqual({ detectedType: 'daily', missingColumns: [] });
  });

  it('reports which required FOCUS columns are missing', () => {
    const partial = REQUIRED_FOCUS_COLUMNS.filter(c => c !== 'Tags' && c !== 'x_Operation');
    expect(classifyManifestColumns(partial))
      .toEqual({ detectedType: 'daily', missingColumns: ['Tags', 'x_Operation'] });
  });

  it('classifies CUR 2.0 line_item_*/bill_* columns as cur-legacy', () => {
    expect(classifyManifestColumns(parseManifestColumnNames(curManifest)).detectedType).toBe('cur-legacy');
  });

  it('classifies a cost-optimization-hub export by its recommendation columns', () => {
    expect(classifyManifestColumns(['recommendation_id', 'estimated_monthly_savings']).detectedType)
      .toBe('cost-optimization');
  });

  it('classifies an unrecognized column list as unknown', () => {
    expect(classifyManifestColumns(['foo', 'bar']).detectedType).toBe('unknown');
    expect(classifyManifestColumns([]).detectedType).toBe('unknown');
  });
});

describe('parseManifestColumnNames', () => {
  it('extracts column names from the columns manifest', () => {
    expect(parseManifestColumnNames(focusManifest)).toEqual([...REQUIRED_FOCUS_COLUMNS]);
  });

  it('returns no columns for the Manifest-FOCUS.json sidecar shape', () => {
    expect(parseManifestColumnNames(focusSidecar)).toEqual([]);
  });

  it('returns no columns for invalid JSON or non-object bodies', () => {
    expect(parseManifestColumnNames('not json')).toEqual([]);
    expect(parseManifestColumnNames('[]')).toEqual([]);
    expect(parseManifestColumnNames('{"columns": "nope"}')).toEqual([]);
  });

  it('skips malformed column entries', () => {
    const body = JSON.stringify({ columns: [{ name: 'Good' }, { name: 42 }, 'junk', { other: 'x' }] });
    expect(parseManifestColumnNames(body)).toEqual(['Good']);
  });
});

describe('selectManifestKey', () => {
  it('prefers the columns manifest over the Manifest-FOCUS.json sidecar regardless of listing order', () => {
    // S3 lists the sidecar FIRST ('-' < '.'): first-.json would pick it and
    // parse zero columns, misclassifying a valid FOCUS export as unknown.
    const sorted = ['exports/metadata/my-export-Manifest-FOCUS.json', 'exports/metadata/my-export-Manifest.json'];
    expect(selectManifestKey(sorted)).toBe('exports/metadata/my-export-Manifest.json');
    expect(selectManifestKey([...sorted].reverse())).toBe('exports/metadata/my-export-Manifest.json');
  });

  it('falls back to the sidecar when it is the only json present', () => {
    expect(selectManifestKey(['m/x-Manifest-FOCUS.json'])).toBe('m/x-Manifest-FOCUS.json');
  });

  it('returns undefined for an empty listing', () => {
    expect(selectManifestKey([])).toBeUndefined();
  });

  it('classifies end-to-end from a listing with both manifests', () => {
    const key = selectManifestKey(['e/metadata/e-Manifest-FOCUS.json', 'e/metadata/e-Manifest.json']);
    const body = key?.endsWith('Manifest-FOCUS.json') === true ? focusSidecar : focusManifest;
    expect(classifyManifestColumns(parseManifestColumnNames(body)))
      .toEqual({ detectedType: 'daily', missingColumns: [] });
  });
});
