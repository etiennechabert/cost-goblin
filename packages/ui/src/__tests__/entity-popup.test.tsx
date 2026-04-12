import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { EntityPopup } from '../components/entity-popup.js';

function renderPopup(overrides?: Partial<{ onClose: () => void; onSetFilter: () => void; onOpenDetail: () => void }>) {
  const api = new MockCostApi();
  const user = userEvent.setup();
  const onClose = overrides?.onClose ?? vi.fn();
  const onSetFilter = overrides?.onSetFilter ?? vi.fn();
  const onOpenDetail = overrides?.onOpenDetail ?? vi.fn();
  return {
    api,
    user,
    onClose,
    onSetFilter,
    onOpenDetail,
    ...render(
      <CostApiProvider value={api}>
        <EntityPopup
          entity="platform"
          dimension="team"
          onClose={onClose}
          onSetFilter={onSetFilter}
          onOpenDetail={onOpenDetail}
        />
      </CostApiProvider>,
    ),
  };
}

afterEach(cleanup);

describe('EntityPopup', () => {
  it('renders entity name and dimension', () => {
    renderPopup();
    expect(screen.getByText('platform')).toBeDefined();
    expect(screen.getByText('team')).toBeDefined();
  });

  it('shows loading state initially', () => {
    renderPopup();
    expect(screen.getByText('Loading…')).toBeDefined();
  });

  it('loads entity detail data', async () => {
    renderPopup();
    await waitFor(() => {
      expect(screen.getByText('Total Cost')).toBeDefined();
    });
  });

  it('shows close button', () => {
    renderPopup();
    expect(screen.getByLabelText('Close')).toBeDefined();
  });

  it('calls onClose when close button clicked', async () => {
    const onClose = vi.fn();
    const { user } = renderPopup({ onClose });
    await user.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('renders action buttons after data loads', async () => {
    renderPopup();
    await waitFor(() => {
      expect(screen.getByText('Set as filter')).toBeDefined();
    });
    expect(screen.getByText('Open full view')).toBeDefined();
  });
});
