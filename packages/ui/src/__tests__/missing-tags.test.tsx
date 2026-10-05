import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { CostScopeConfig, MissingTagsParams, MissingTagsResult } from '@costgoblin/core/browser';
import { DEFAULT_COST_SCOPE } from '@costgoblin/core/browser';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { MissingTags } from '../views/missing-tags.js';
import { getDefaultDateRange } from '../components/date-range-picker.js';

function renderMissingTags(api = new MockCostApi()) {
  return {
    api,
    ...render(
      <CostApiProvider value={api}>
        <MissingTags />
      </CostApiProvider>,
    ),
  };
}

/** Configures a 5-day lag and records every missing-tags query. */
class Lag5MissingTagsApi extends MockCostApi {
  readonly missingTagsCalls: MissingTagsParams[] = [];
  override getCostScope(): Promise<CostScopeConfig> {
    return Promise.resolve({ ...DEFAULT_COST_SCOPE, lagDays: 5 });
  }
  override queryMissingTags(params?: MissingTagsParams): Promise<MissingTagsResult> {
    if (params !== undefined) this.missingTagsCalls.push(params);
    return super.queryMissingTags();
  }
}

afterEach(cleanup);

describe('MissingTags', () => {
  it('shows table with resource data after loading', async () => {
    renderMissingTags();
    await waitFor(() => {
      expect(screen.getByText('Account')).toBeDefined();
      expect(screen.getByText('Resource')).toBeDefined();
      expect(screen.getByText('Service')).toBeDefined();
    });
  });

  it('has min cost filter input defaulting to 1', () => {
    renderMissingTags();
    expect(screen.getByDisplayValue('1')).toBeDefined();
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
      const api = new Lag5MissingTagsApi();
      renderMissingTags(api);
      await waitFor(() => {
        expect(api.missingTagsCalls.at(-1)?.dateRange).toEqual(getDefaultDateRange(5));
      });
      expect(screen.getByRole('button', { name: /Last 30 days/ })).toBeDefined();
    });
  });
});
