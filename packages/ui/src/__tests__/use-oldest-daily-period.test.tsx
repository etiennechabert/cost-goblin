import { cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { DataInventoryResult } from '@costgoblin/core/browser';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { useOldestDailyPeriod } from '../hooks/use-oldest-daily-period.js';
import { MOCK_MULTI_PROVIDER_CONFIG, MockCostApi } from '../__fixtures__/mock-api.js';

afterEach(cleanup);

/** A local-only inventory whose oldest on-disk period is `oldest`. */
function inventory(oldest: string | null): DataInventoryResult {
  return {
    periods: [],
    totalRemoteSize: 0,
    totalLocalPeriods: oldest === null ? 0 : 1,
    totalRemotePeriods: 0,
    lastSync: null,
    local: { periods: oldest === null ? [] : [oldest], diskBytes: 0, oldestPeriod: oldest, newestPeriod: oldest },
  };
}

/** aws-main and aws-secondary, each answering as the test says. Counts the
 *  local reads, and fails the test's remote path: the hook must never list
 *  the bucket. */
class TwoProviderApi extends MockCostApi {
  localReads = 0;
  remoteListings = 0;
  constructor(private readonly answers: Record<string, () => Promise<DataInventoryResult>>) { super(); }
  override getConfig() { return Promise.resolve(MOCK_MULTI_PROVIDER_CONFIG); }
  override getLocalDataInventory(_tier?: string, providerName?: string): Promise<DataInventoryResult> {
    this.localReads += 1;
    const answer = this.answers[providerName ?? ''];
    return answer === undefined ? Promise.reject(new Error('unknown provider')) : answer();
  }
  override getDataInventory(): Promise<DataInventoryResult> {
    this.remoteListings += 1;
    return Promise.reject(new Error('the hook must not list the remote'));
  }
}

function renderOldest(api: MockCostApi, enabled = true) {
  const wrapper = ({ children }: { children: ReactNode }) => <CostApiProvider value={api}>{children}</CostApiProvider>;
  return renderHook(() => useOldestDailyPeriod(enabled), { wrapper });
}

describe('useOldestDailyPeriod', () => {
  it('takes the oldest local period across providers without listing the remote', async () => {
    const api = new TwoProviderApi({
      'aws-main': () => Promise.resolve(inventory('2025-04')),
      'aws-secondary': () => Promise.resolve(inventory('2025-02')),
    });
    const { result } = renderOldest(api);
    expect(result.current).toBeNull();
    await waitFor(() => { expect(result.current).toBe('2025-02-01'); });
    expect(api.remoteListings).toBe(0);
  });

  it('still reports the others when one provider fails to read', async () => {
    const api = new TwoProviderApi({
      'aws-main': () => Promise.reject(new Error('folder unreadable')),
      'aws-secondary': () => Promise.resolve(inventory('2025-03')),
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
      'aws-main': () => Promise.resolve(inventory(null)),
      'aws-secondary': () => Promise.resolve(inventory('not-a-period')),
    }));
    await new Promise(resolve => { setTimeout(resolve, 20); });
    expect(first.result.current).toBeNull();
    expect(empty.result.current).toBeNull();
  });

  it('makes no inventory calls while disabled', async () => {
    const api = new TwoProviderApi({
      'aws-main': () => Promise.resolve(inventory('2025-01')),
      'aws-secondary': () => Promise.resolve(inventory('2025-01')),
    });
    renderOldest(api, false);
    await new Promise(resolve => { setTimeout(resolve, 20); });
    expect(api.localReads).toBe(0);
    expect(api.remoteListings).toBe(0);
  });

  it('reads again on the next mount, so an older month synced since then counts', async () => {
    let secondaryOldest = '2025-02';
    const api = new TwoProviderApi({
      'aws-main': () => Promise.resolve(inventory('2025-04')),
      'aws-secondary': () => Promise.resolve(inventory(secondaryOldest)),
    });
    const first = renderOldest(api);
    await waitFor(() => { expect(first.result.current).toBe('2025-02-01'); });
    first.unmount();

    secondaryOldest = '2024-11';
    const second = renderOldest(api);
    await waitFor(() => { expect(second.result.current).toBe('2024-11-01'); });
    expect(api.remoteListings).toBe(0);
  });
});
