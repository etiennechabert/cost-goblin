import { cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { DataInventoryResult } from '@costgoblin/core/browser';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { useOldestDailyPeriod } from '../hooks/use-oldest-daily-period.js';
import { MOCK_MULTI_PROVIDER_CONFIG, MockCostApi } from '../__fixtures__/mock-api.js';

afterEach(cleanup);

function inventory(periods: readonly { period: string; localStatus: 'missing' | 'repartitioned' }[]): DataInventoryResult {
  return {
    periods: periods.map(p => ({ ...p, files: [], totalSize: 0 })),
    totalRemoteSize: 0,
    totalLocalPeriods: 0,
    totalRemotePeriods: 0,
    lastSync: null,
    local: { periods: [], diskBytes: 0, oldestPeriod: null, newestPeriod: null },
  };
}

/** aws-main and aws-secondary, each answering as the test says. */
class TwoProviderApi extends MockCostApi {
  constructor(private readonly answers: Record<string, () => Promise<DataInventoryResult>>) { super(); }
  override getConfig() { return Promise.resolve(MOCK_MULTI_PROVIDER_CONFIG); }
  override getDataInventory(_tier?: string, providerName?: string): Promise<DataInventoryResult> {
    const answer = this.answers[providerName ?? ''];
    return answer === undefined ? Promise.reject(new Error('unknown provider')) : answer();
  }
}

function renderOldest(api: MockCostApi, enabled = true) {
  const wrapper = ({ children }: { children: ReactNode }) => <CostApiProvider value={api}>{children}</CostApiProvider>;
  return renderHook(() => useOldestDailyPeriod(enabled), { wrapper });
}

describe('useOldestDailyPeriod', () => {
  it('takes the oldest local period across providers, ignoring ones only on the remote', async () => {
    const api = new TwoProviderApi({
      'aws-main': () => Promise.resolve(inventory([{ period: '2024-11', localStatus: 'missing' }, { period: '2025-04', localStatus: 'repartitioned' }])),
      'aws-secondary': () => Promise.resolve(inventory([{ period: '2025-02', localStatus: 'repartitioned' }])),
    });
    const { result } = renderOldest(api);
    expect(result.current).toBeNull();
    await waitFor(() => { expect(result.current).toBe('2025-02-01'); });
  });

  it('still reports the others when one provider fails to list', async () => {
    const api = new TwoProviderApi({
      'aws-main': () => Promise.reject(new Error('bucket unreachable')),
      'aws-secondary': () => Promise.resolve(inventory([{ period: '2025-03', localStatus: 'repartitioned' }])),
    });
    const { result } = renderOldest(api);
    await waitFor(() => { expect(result.current).toBe('2025-03-01'); });
  });

  it('stays null when every provider fails or none holds a local period', async () => {
    const failing = new TwoProviderApi({
      'aws-main': () => Promise.reject(new Error('down')),
      'aws-secondary': () => Promise.reject(new Error('down')),
    });
    const first = renderOldest(failing);
    const empty = renderOldest(new TwoProviderApi({
      'aws-main': () => Promise.resolve(inventory([{ period: '2025-01', localStatus: 'missing' }])),
      'aws-secondary': () => Promise.resolve(inventory([])),
    }));
    await new Promise(resolve => { setTimeout(resolve, 20); });
    expect(first.result.current).toBeNull();
    expect(empty.result.current).toBeNull();
  });

  it('makes no inventory calls while disabled', async () => {
    const calls: string[] = [];
    const api = new TwoProviderApi({
      'aws-main': () => { calls.push('aws-main'); return Promise.resolve(inventory([])); },
      'aws-secondary': () => { calls.push('aws-secondary'); return Promise.resolve(inventory([])); },
    });
    renderOldest(api, false);
    await new Promise(resolve => { setTimeout(resolve, 20); });
    expect(calls).toEqual([]);
  });
});
