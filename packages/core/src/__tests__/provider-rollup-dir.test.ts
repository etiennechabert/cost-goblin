import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { providerRawDir, providerRollupDir } from '../sync/provider-paths.js';
import { asProviderName } from '../types/branded.js';

describe('providerRollupDir', () => {
  it('keeps each provider\'s pre-aggregated partitions beside, never inside, its raw data', () => {
    const awsMain = asProviderName('aws-main');
    const gcpMain = asProviderName('gcp-main');

    expect(providerRollupDir('/data', awsMain)).toBe(join('/data', 'aws-main', 'rollup'));
    expect(providerRollupDir('/data', gcpMain)).toBe(join('/data', 'gcp-main', 'rollup'));
    // The query layer globs raw/{tier}-*/: a rollup nested under raw/ would be read as billing data.
    expect(providerRollupDir('/data', awsMain).startsWith(providerRawDir('/data', awsMain))).toBe(false);
  });
});
