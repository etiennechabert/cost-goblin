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
  it('surfaces the rollup impact estimate for the current grain', async () => {
    renderView();
    await waitFor(() => { expect(screen.getByText('Rollup impact')).toBeDefined(); });
    await waitFor(() => { expect(screen.getByText('Est. size')).toBeDefined(); });
    expect(screen.getByText('Compression')).toBeDefined();
    expect(screen.getByText('Rebuild')).toBeDefined();
    expect(screen.getByText(/directional/)).toBeDefined();
  });

  it('flags resource_id raw-only with a badge and a panel warning', async () => {
    renderView();
    await waitFor(() => { expect(screen.getByText(/heavy for the rollup/i)).toBeDefined(); });
    // The resource pill carries a "raw" badge.
    expect(screen.getAllByText('raw').length).toBeGreaterThan(0);
  });

  it('re-estimates and clears the raw-only warning when the dim is toggled off', async () => {
    const { user } = renderView();
    await waitFor(() => { expect(screen.getByText(/heavy for the rollup/i)).toBeDefined(); });

    // The SECTION 1 pill is the first button matching the dim label.
    const resourcePill = screen.getAllByRole('button', { name: /Resource/ })[0];
    expect(resourcePill).toBeDefined();
    await user.click(resourcePill as HTMLElement);

    await waitFor(() => { expect(screen.queryByText(/heavy for the rollup/i)).toBeNull(); });
  });
});
