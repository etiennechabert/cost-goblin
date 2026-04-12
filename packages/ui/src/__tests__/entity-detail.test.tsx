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

  it('shows histogram with Groups/Products/Services tabs after data loads', async () => {
    renderDetail();

    await waitFor(() => {
      expect(screen.getByText('Daily Costs')).toBeDefined();
    });

    // StackedBarChart uses Groups/Products/Services tabs (same as overview)
    expect(screen.getByRole('button', { name: 'Groups' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Products' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Services' })).toBeDefined();
  });

  it('histogram tab toggle switches active state', async () => {
    const { user } = renderDetail();

    await waitFor(() => {
      expect(screen.getByText('Daily Costs')).toBeDefined();
    });

    const groupsBtn = screen.getByRole('button', { name: 'Groups' });
    const servicesBtn = screen.getByRole('button', { name: 'Services' });

    await user.click(groupsBtn);
    expect(groupsBtn.className).toContain('bg-accent');

    await user.click(servicesBtn);
    expect(servicesBtn.className).toContain('bg-accent');
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

  it('date range picker is visible with daily and hourly presets', () => {
    renderDetail();
    expect(screen.getByText('Daily')).toBeDefined();
    expect(screen.getByText('Hourly')).toBeDefined();
    expect(screen.getByText('90 days')).toBeDefined();
  });
});
