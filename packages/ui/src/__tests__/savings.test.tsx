import { act, render, screen, waitFor, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { asBucketPath, asDollars, asProviderName } from '@costgoblin/core/browser';
import type { CostGoblinConfig, SavingsResult, SyncStatus } from '@costgoblin/core/browser';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { Savings, SAVINGS_SYNC_POLL_MS } from '../views/savings.js';
import { deferred } from './deferred.js';

function renderSavings() {
  const api = new MockCostApi();
  const user = userEvent.setup();
  return {
    api,
    user,
    ...render(
      <CostApiProvider value={api}>
        <Savings />
      </CostApiProvider>,
    ),
  };
}

afterEach(cleanup);

describe('Savings', () => {
  it('shows recommendations after loading', async () => {
    renderSavings();
    await waitFor(() => {
      expect(screen.getByText(/\$4\.0k\/mo potential savings/)).toBeDefined();
    });
  });

  it('displays action type filter badges', async () => {
    renderSavings();
    await waitFor(() => {
      expect(screen.getByText(/All \(3\)/)).toBeDefined();
    });
    expect(screen.getByText(/Purchase Reserved Instances \(1\)/)).toBeDefined();
    expect(screen.getByText(/Delete \(1\)/)).toBeDefined();
    expect(screen.getByText(/Rightsize \(1\)/)).toBeDefined();
  });

  it('filters table rows by action type when badge clicked', async () => {
    const { user } = renderSavings();
    await waitFor(() => {
      expect(screen.getByText(/Delete \(1\)/)).toBeDefined();
    });

    // all 3 recs visible initially
    expect(screen.getByText(/Detach and delete/)).toBeDefined();
    expect(screen.getByText(/10 db.t4g.micro/)).toBeDefined();
    expect(screen.getByText(/Downsize to t3.medium/)).toBeDefined();

    // click Delete filter
    await user.click(screen.getByText(/Delete \(1\)/));

    // only Delete row visible, others gone
    expect(screen.getByText(/Detach and delete/)).toBeDefined();
    expect(screen.queryByText(/10 db.t4g.micro/)).toBeNull();
    expect(screen.queryByText(/Downsize to t3.medium/)).toBeNull();

    // click Rightsize filter
    await user.click(screen.getByText(/Rightsize \(1\)/));

    // only Rightsize row visible
    expect(screen.getByText(/Downsize to t3.medium/)).toBeDefined();
    expect(screen.queryByText(/Detach and delete/)).toBeNull();
    expect(screen.queryByText(/10 db.t4g.micro/)).toBeNull();

    // click All to reset
    await user.click(screen.getByText(/All \(3\)/));

    // all 3 back
    expect(screen.getByText(/Detach and delete/)).toBeDefined();
    expect(screen.getByText(/10 db.t4g.micro/)).toBeDefined();
    expect(screen.getByText(/Downsize to t3.medium/)).toBeDefined();
  });

  it('shows resource ARN in recommendation column', async () => {
    renderSavings();
    await waitFor(() => {
      expect(screen.getByText('volume/vol-abc123')).toBeDefined();
    });
  });

  it('shows account name and ID', async () => {
    renderSavings();
    await waitFor(() => {
      expect(screen.getAllByText('Production').length).toBeGreaterThan(0);
      expect(screen.getAllByText('111111111111').length).toBeGreaterThan(0);
    });
  });

  it('expands row on click to show details', async () => {
    const { user } = renderSavings();
    await waitFor(() => {
      expect(screen.getByText(/Detach and delete/)).toBeDefined();
    });
    const row = screen.getByText(/Detach and delete/).closest('tr');
    expect(row).not.toBeNull();
    await user.click(row as HTMLElement);
    await waitFor(() => {
      expect(screen.getByText('vol-abc123')).toBeDefined();
    });
  });

  it('shows effort badges with correct labels', async () => {
    renderSavings();
    await waitFor(() => {
      expect(screen.getByText('Very Low')).toBeDefined();
      expect(screen.getByText('Low')).toBeDefined();
      expect(screen.getByText('Medium')).toBeDefined();
    });
  });
});

/** One AWS provider with a cost-optimization tier, and the server-side status
 *  of that tier, which the test moves the way a sync would. */
class SyncingApi extends MockCostApi {
  costOptStatus: SyncStatus = { status: 'idle', lastSync: null };
  readonly polled: string[] = [];

  override getConfig(): Promise<CostGoblinConfig> {
    return Promise.resolve({
      providers: [{
        name: asProviderName('aws-main'),
        type: 'aws',
        credentialsProfile: 'default',
        sync: {
          daily: { bucket: asBucketPath('acme-cur/daily'), retentionDays: 90 },
          costOptimization: { bucket: asBucketPath('acme-cur/cost-opt'), retentionDays: 90 },
          intervalMinutes: 60,
        },
      }],
      defaults: { periodDays: 30, costMetric: 'effective', lagDays: 2 },
    });
  }

  override getSyncStatus = (syncId?: string): Promise<SyncStatus> => {
    this.polled.push(syncId ?? 'default');
    return Promise.resolve(this.costOptStatus);
  };
}

const NO_RECOMMENDATIONS: SavingsResult = { recommendations: [], totalMonthlySavings: asDollars(0), snapshots: [], unreadSnapshots: [] };

/** A completed sync that finished `agoMs` before now (the fake clock's). */
function completed(agoMs: number, filesDownloaded: number): SyncStatus {
  return { status: 'completed', lastSync: new Date(Date.now() - agoMs), filesDownloaded };
}

async function nextPoll(): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(SAVINGS_SYNC_POLL_MS); });
}

function renderWith(api: MockCostApi) {
  return render(
    <CostApiProvider value={api}>
      <Savings />
    </CostApiProvider>,
  );
}

describe('Savings — a cost optimization sync finishing while the page is open', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('shows the downloaded recommendations without leaving the page', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = new SyncingApi();
    api.costOptStatus = { status: 'syncing', phase: 'downloading', progress: 0, filesDone: 0, filesTotal: 1, bytesDone: 0, bytesTotal: 0, message: '' };
    vi.spyOn(api, 'querySavings').mockResolvedValueOnce(NO_RECOMMENDATIONS);
    renderWith(api);
    expect(await screen.findByText(/No cost optimization data available/)).toBeDefined();
    await waitFor(() => { expect(api.polled).toContain('aws-main:cost-optimization'); });

    api.costOptStatus = completed(0, 1);
    await nextPoll();

    expect(await screen.findByText(/\$4\.0k\/mo potential savings/)).toBeDefined();
    expect(screen.queryByText(/No cost optimization data available/)).toBeNull();
  });

  it('keeps showing the current recommendations while the new ones load', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = new SyncingApi();
    api.costOptStatus = completed(3_600_000, 2);
    const original = api.querySavings.bind(api);
    const spy = vi.spyOn(api, 'querySavings');
    renderWith(api);
    expect(await screen.findByText(/Detach and delete/)).toBeDefined();
    await waitFor(() => { expect(api.polled.length).toBeGreaterThan(0); });

    const next = deferred<SavingsResult>();
    spy.mockReturnValueOnce(next.promise);
    api.costOptStatus = completed(0, 1);
    await nextPoll();
    await waitFor(() => { expect(spy).toHaveBeenCalledTimes(2); });
    // Still the table, not the loader.
    expect(screen.getByText(/Detach and delete/)).toBeDefined();

    const current = await original();
    await act(async () => {
      next.resolve({ ...current, recommendations: current.recommendations.filter(r => r.actionType === 'Delete') });
      await Promise.resolve();
    });
    await waitFor(() => { expect(screen.queryByText(/Downsize to t3.medium/)).toBeNull(); });
    expect(screen.getByText(/Detach and delete/)).toBeDefined();
  });

  it('does not refetch for a sync that finished before the page opened, or one that downloaded nothing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = new SyncingApi();
    api.costOptStatus = completed(3_600_000, 3);
    const spy = vi.spyOn(api, 'querySavings');
    renderWith(api);
    expect(await screen.findByText(/Detach and delete/)).toBeDefined();
    await waitFor(() => { expect(api.polled.length).toBeGreaterThan(0); });
    await nextPoll();

    api.costOptStatus = completed(0, 0);
    await nextPoll();
    await nextPoll();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('refetches for a sync that finished after the page opened, though every poll before failed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = new SyncingApi();
    const poll = vi.fn<(syncId?: string) => Promise<SyncStatus>>().mockRejectedValue(new Error('ipc closed'));
    api.getSyncStatus = poll;
    const spy = vi.spyOn(api, 'querySavings').mockResolvedValueOnce(NO_RECOMMENDATIONS);
    renderWith(api);
    expect(await screen.findByText(/No cost optimization data available/)).toBeDefined();
    await waitFor(() => { expect(poll).toHaveBeenCalled(); });

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    poll.mockResolvedValue(completed(0, 1));
    await nextPoll();

    expect(await screen.findByText(/\$4\.0k\/mo potential savings/)).toBeDefined();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('waits for a slow status answer instead of asking again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = new SyncingApi();
    const answer = deferred<SyncStatus>();
    const poll = vi.fn<(syncId?: string) => Promise<SyncStatus>>().mockReturnValue(answer.promise);
    api.getSyncStatus = poll;
    renderWith(api);
    expect(await screen.findByText(/Detach and delete/)).toBeDefined();
    await waitFor(() => { expect(poll).toHaveBeenCalledTimes(1); });
    await nextPoll();
    await nextPoll();
    expect(poll).toHaveBeenCalledTimes(1);

    await act(async () => { answer.resolve({ status: 'idle', lastSync: null }); await Promise.resolve(); });
    await nextPoll();
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it('does not poll a provider without a cost optimization tier', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = new MockCostApi();
    const poll = vi.fn<(syncId?: string) => Promise<SyncStatus>>().mockResolvedValue({ status: 'idle', lastSync: null });
    api.getSyncStatus = poll;
    renderWith(api);
    expect(await screen.findByText(/Detach and delete/)).toBeDefined();
    await nextPoll();
    await nextPoll();
    expect(poll).not.toHaveBeenCalled();
  });
});
