import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { EntityDetail } from '../views/entity-detail.js';

function renderDetail(overrides?: Partial<{ onBack: () => void }>) {
  const api = new MockCostApi();
  const onBack = overrides?.onBack ?? vi.fn();
  const user = userEvent.setup();
  return {
    api,
    onBack,
    user,
    ...render(
      <CostApiProvider value={api}>
        <EntityDetail entity="platform" dimension="account" onBack={onBack} />
      </CostApiProvider>,
    ),
  };
}

afterEach(cleanup);

describe('EntityDetail', () => {
  it('renders entity name and dimension', () => {
    renderDetail();
    expect(screen.getByText('platform')).toBeDefined();
    expect(screen.getByText('account')).toBeDefined();
  });

  it('shows daily costs histogram with individual day bars after data loads', async () => {
    const { container } = renderDetail();

    await waitFor(() => {
      expect(screen.getByText('Daily Costs')).toBeDefined();
    });

    // Histogram container has bars (flex-1 children with cursor-pointer)
    const histogram = container.querySelector('[style*="height: 160px"]');
    expect(histogram).not.toBeNull();
    if (histogram === null) throw new Error('histogram not found');
    const bars = histogram.querySelectorAll('.group');
    // Mock has 3 days of data
    expect(bars.length).toBe(3);
  });

  it('service/account toggle switches active state', async () => {
    const { user } = renderDetail();

    await waitFor(() => {
      expect(screen.getByText('Daily Costs')).toBeDefined();
    });

    const serviceBtn = screen.getByRole('button', { name: 'service' });
    const accountBtn = screen.getByRole('button', { name: 'account' });

    expect(serviceBtn.className).toContain('bg-bg-secondary');
    expect(accountBtn.className).not.toContain('bg-bg-secondary');

    await user.click(accountBtn);

    expect(accountBtn.className).toContain('bg-bg-secondary');
    expect(serviceBtn.className).not.toContain('bg-bg-secondary');
  });

  it('back button calls onBack', async () => {
    const onBack = vi.fn();
    const { user } = renderDetail({ onBack });

    const backBtn = screen.getByRole('button', { name: /Back/i });
    await user.click(backBtn);

    expect(onBack).toHaveBeenCalledOnce();
  });

  it('export CSV button is visible when data loads', async () => {
    renderDetail();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Export CSV/i })).toBeDefined();
    });
  });

  it('date range picker is visible', () => {
    renderDetail();
    expect(screen.getByText('30 days')).toBeDefined();
    expect(screen.getByText('7 days')).toBeDefined();
  });
});
