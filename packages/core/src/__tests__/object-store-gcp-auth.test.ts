import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createObjectStoreHandle, providerAuth } from '../sync/object-store.js';
import { parseProviderName } from '../config/provider-name.js';
import { asBucketPath } from '../types/branded.js';
import type { ProviderConfig } from '../types/config.js';

/** `createGcsStorage` is the one place a GCS client is built, so the identity
 *  each provider lists with is exactly the options it receives. The fake
 *  storage answers every listing with a single Parquet object. */
interface FakeStorage {
  bucket: () => { getFiles: () => Promise<{ name: string; metadata: { crc32c: string; size: string } }[][]> };
}

const { createGcsStorage } = vi.hoisted(() => ({
  createGcsStorage: vi.fn<(options: Record<string, unknown>) => Promise<FakeStorage>>(() => Promise.resolve({
    bucket: () => ({
      getFiles: () => Promise.resolve([[
        { name: 'focus/daily/billing_period=2026-01/shard-0.parquet', metadata: { crc32c: 'crc', size: '5' } },
      ]]),
    }),
  })),
}));

vi.mock('../sync/gcs-storage.js', () => ({ createGcsStorage }));

const READER_A = 'reader-a@personal-proj.iam.gserviceaccount.com';
const READER_B = 'reader-b@company-proj.iam.gserviceaccount.com';

function gcpProvider(name: string, extra: { impersonateServiceAccount?: string; keyFile?: string }): ProviderConfig {
  return {
    name: parseProviderName(name),
    type: 'gcp',
    ...extra,
    sync: { daily: { bucket: asBucketPath('gs://billing-export/focus/daily/'), retentionDays: 365 }, intervalMinutes: 60 },
  };
}

beforeEach(() => {
  createGcsStorage.mockClear();
});

describe('createObjectStoreHandle for GCP providers', () => {
  it('lists each provider as its own impersonated service account', async () => {
    const personal = await createObjectStoreHandle(providerAuth(gcpProvider('gcp-personal', { impersonateServiceAccount: READER_A })));
    const company = await createObjectStoreHandle(providerAuth(gcpProvider('gcp-company', { impersonateServiceAccount: READER_B })));

    await personal.listFiles('billing-export', 'focus/daily/');
    await company.listFiles('billing-export', 'focus/daily/');

    expect(createGcsStorage.mock.calls.map(([options]) => options)).toEqual([
      { impersonateServiceAccount: READER_A },
      { impersonateServiceAccount: READER_B },
    ]);
  });

  it('keeps plain ADC and key-file providers unchanged', async () => {
    const adc = await createObjectStoreHandle(providerAuth(gcpProvider('gcp-adc', {})));
    const keyed = await createObjectStoreHandle(providerAuth(gcpProvider('gcp-key', { keyFile: '/keys/reader.json' })));

    await adc.listFiles('billing-export', 'focus/daily/');
    await keyed.listFiles('billing-export', 'focus/daily/');

    expect(createGcsStorage.mock.calls.map(([options]) => options)).toEqual([
      {},
      { keyFile: '/keys/reader.json' },
    ]);
  });
});
