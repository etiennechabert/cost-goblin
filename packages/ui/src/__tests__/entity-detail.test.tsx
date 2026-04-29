import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { PaletteProvider } from '../hooks/use-palette.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { EntityDetail } from '../views/entity-detail.js';

function renderDetail(
  overrides?: Partial<{ onBack: () => void; api: MockCostApi }>,
) {
  const api = overrides?.api ?? new MockCostApi();
  const onBack = overrides?.onBack ?? vi.fn();
  const user = userEvent.setup();
  return {
    api,
    onBack,
    user,
    ...render(
      <PaletteProvider>
        <CostApiProvider value={api}>
          <EntityDetail entity="platform" dimension="account" onBack={onBack} />
        </CostApiProvider>
      </PaletteProvider>,
    ),
  };
}

afterEach(cleanup);

describe('EntityDetail', () => {
  it('shows histogram with Groups/Products/Services tabs after data loads', async () => {
    renderDetail();

    await waitFor(() => {
      expect(screen.getByText('Daily Costs')).toBeDefined();
    });

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

  it('shows loading state initially', () => {
    renderDetail();
    expect(screen.getByText('Loading...')).toBeDefined();
  });

  it('renders view header with empty data', async () => {
    const api = MockCostApi.withEmptyData();
    renderDetail({ api });
    await waitFor(() => {
      expect(screen.queryByText('Loading...')).toBeNull();
    });
    expect(screen.getByText('platform')).toBeDefined();
  });

  it('shows back button with empty data', async () => {
    const api = MockCostApi.withEmptyData();
    renderDetail({ api });
    await waitFor(() => {
      expect(screen.queryByText('Loading...')).toBeNull();
    });
    expect(screen.getByRole('button', { name: /Back/i })).toBeDefined();
  });

  it('displays date range picker even with empty data', async () => {
    const api = MockCostApi.withEmptyData();
    renderDetail({ api });
    await waitFor(() => {
      expect(screen.queryByText('Loading...')).toBeNull();
    });
    const buttons = screen.getAllByText('30 days');
    expect(buttons.length).toBeGreaterThan(0);
  });

  it('shows loading indicator on initial render', async () => {
    renderDetail();
    expect(screen.getByText('Loading...')).toBeDefined();
    await waitFor(() => {
      expect(screen.queryByText('Loading...')).toBeNull();
    });
  });
});
