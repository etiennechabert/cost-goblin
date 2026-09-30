import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { providerEtagPath, providerMetaDir, providerRawDir } from '../sync/provider-paths.js';
import { asProviderName } from '../types/branded.js';

const provider = asProviderName('aws-main');

describe('provider paths', () => {
  it('nests raw data and sync sidecars under the provider dir', () => {
    expect(providerRawDir('/data', provider)).toBe(join('/data', 'aws-main', 'raw'));
    expect(providerMetaDir('/data', provider)).toBe(join('/data', 'aws-main', 'meta'));
  });

  it('places the tier etag sidecar directly in the meta dir', () => {
    expect(providerEtagPath('/data', provider, 'hourly')).toBe(join('/data', 'aws-main', 'meta', 'sync-etags-hourly.json'));
  });
});
