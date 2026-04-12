import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, it, expect } from 'vitest';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { Savings } from '../views/savings.js';

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
  it('renders heading', () => {
    renderSavings();
    expect(screen.getByText('Savings Opportunities')).toBeDefined();
  });

  it('shows recommendations after loading', async () => {
    renderSavings();
    await waitFor(() => {
      expect(screen.getByText('$4.0k')).toBeDefined();
    });
    expect(screen.getByText('3')).toBeDefined();
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
