import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { asDimensionId } from '@costgoblin/core/browser';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { DimensionsView } from '../views/dimensions.js';

function renderView() {
  const api = new MockCostApi();
  // A config that includes the high-cardinality resource_id built-in so the
  // estimator (mock) flags it raw-only.
  vi.spyOn(api, 'getDimensionsConfig').mockResolvedValue({
    builtIn: [
      { name: asDimensionId('account'), label: 'Account', field: 'account_id', displayField: 'account_name' },
      { name: asDimensionId('service'), label: 'AWS Service', field: 'service' },
      { name: asDimensionId('resource_id'), label: 'Resource', field: 'resource_id' },
    ],
    tags: [{ tagName: 'team', label: 'Team', concept: 'owner' }],
  });
  const user = userEvent.setup();
  return {
    api,
    user,
    ...render(
      <CostApiProvider value={api}>
        <DimensionsView />
      </CostApiProvider>,
    ),
  };
}

afterEach(cleanup);

describe('DimensionsView — rollup grain estimate', () => {
  it('surfaces the rollup impact estimate with a raw-data baseline', async () => {
    renderView();
    await waitFor(() => { expect(screen.getByText('Rollup impact')).toBeDefined(); });
    await waitFor(() => { expect(screen.getByText('Raw data')).toBeDefined(); });
    expect(screen.getByText('Est. rollup')).toBeDefined();
    expect(screen.getByText('Compression')).toBeDefined();
    expect(screen.getByText('Rebuild')).toBeDefined();
    expect(screen.getByText(/directional/)).toBeDefined();
  });

  it('flags resource_id as the dominant grain driver in the per-dimension list', async () => {
    renderView();
    await waitFor(() => { expect(screen.getByText('Per-dimension impact')).toBeDefined(); });
    // The outlier sentence questions the single dominant dimension.
    await waitFor(() => { expect(screen.getByText(/multiplies the rollup/i)).toBeDefined(); });
    // The resource pill still carries a high-cardinality count badge (~1.8M distinct).
    expect(screen.getAllByText('1.8M').length).toBeGreaterThan(0);
  });

  it('re-estimates and clears the outlier warning when the dim is toggled off', async () => {
    const { user } = renderView();
    await waitFor(() => { expect(screen.getByText(/multiplies the rollup/i)).toBeDefined(); });

    // The SECTION 1 pill is the first button matching the dim label.
    const resourcePill = screen.getAllByRole('button', { name: /Resource/ })[0];
    expect(resourcePill).toBeDefined();
    await user.click(resourcePill as HTMLElement);

    // Wait for the re-estimate to settle (it flashes the loading bar mid-probe):
    // the outlier warning is gone AND the per-dimension list is back.
    await waitFor(() => {
      expect(screen.queryByText(/multiplies the rollup/i)).toBeNull();
      expect(screen.getByText('Per-dimension impact')).toBeDefined();
    });
  });
});
