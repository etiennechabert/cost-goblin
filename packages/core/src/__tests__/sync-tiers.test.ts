import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { providerEtagPath } from '../sync/provider-paths.js';
import { getEtagFileName } from '../sync/tiers.js';
import { asProviderName } from '../types/branded.js';

describe('getEtagFileName', () => {
  it('maps each tier to its own sidecar file', () => {
    expect(getEtagFileName('daily')).toBe('sync-etags.json');
    expect(getEtagFileName('hourly')).toBe('sync-etags-hourly.json');
    expect(getEtagFileName('cost-optimization')).toBe('sync-etags-cost-optimization.json');
  });

  it('falls back to the daily sidecar for an unknown tier', () => {
    expect(getEtagFileName('weekly')).toBe('sync-etags.json');
  });
});

describe('providerEtagPath', () => {
  it('places the tier sidecar under the provider meta dir', () => {
    const provider = asProviderName('aws-main');
    expect(providerEtagPath('/data', provider, 'hourly')).toBe(join('/data', 'aws-main', 'meta', 'sync-etags-hourly.json'));
  });
});
