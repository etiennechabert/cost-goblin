import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { CostScopeConfig, TrendQueryParams, TrendResult } from '@costgoblin/core/browser';
import { DEFAULT_COST_SCOPE } from '@costgoblin/core/browser';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { CostTrends } from '../views/cost-trends.js';
import { getDefaultDateRange } from '../components/date-range-picker.js';

function renderTrends(api = new MockCostApi()) {
  const onEntityClick = vi.fn();
  return {
    api,
    onEntityClick,
    ...render(
      <CostApiProvider value={api}>
        <CostTrends onEntityClick={onEntityClick} />
      </CostApiProvider>,
    ),
  };
}

/** Configures a 5-day lag and records every trends query. */
class Lag5TrendsApi extends MockCostApi {
  readonly trendCalls: TrendQueryParams[] = [];
  override getCostScope(): Promise<CostScopeConfig> {
    return Promise.resolve({ ...DEFAULT_COST_SCOPE, lagDays: 5 });
  }
  override queryTrends(params?: TrendQueryParams): Promise<TrendResult> {
    if (params !== undefined) this.trendCalls.push(params);
    return super.queryTrends();
  }
}

afterEach(cleanup);

describe('CostTrends', () => {
  it('shows trend data and columns after loading', async () => {
    renderTrends();
    await waitFor(() => {
      expect(screen.getByText(/platform/)).toBeDefined();
      expect(screen.getByText('Entity')).toBeDefined();
      expect(screen.getByText('Current')).toBeDefined();
      expect(screen.getByText('Previous')).toBeDefined();
    });
  });

  describe('with a configured lag', () => {
    // Pinned so the view's seed and the expected range share one "today".
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-03-15T12:00:00Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('queries the default window for that lag, matching the picker', async () => {
      const api = new Lag5TrendsApi();
      renderTrends(api);
      await waitFor(() => {
        expect(api.trendCalls.at(-1)?.dateRange).toEqual(getDefaultDateRange(5));
      });
      expect(screen.getByRole('button', { name: /Last 30 days/ })).toBeDefined();
    });
  });
});
