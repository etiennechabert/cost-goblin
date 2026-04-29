import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, describe, it, expect } from 'vitest';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { ViewsEditor } from '../views/views-editor.js';

afterEach(cleanup);

function renderEditor(api?: MockCostApi) {
  const mockApi = api ?? new MockCostApi();
  return render(
    <CostApiProvider value={mockApi}>
      <ViewsEditor />
    </CostApiProvider>,
  );
}

describe('ViewsEditor', () => {
  it('shows the seed view name after load', async () => {
    renderEditor();
    await waitFor(() => {
      expect(screen.getAllByText('Cost Overview').length).toBeGreaterThan(0);
    });
  });

  it('lets the user add a new view', async () => {
    renderEditor();
    await waitFor(() => {
      expect(screen.getAllByText('Cost Overview').length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getByText('+ New view'));
    expect(screen.getAllByText('New view').length).toBeGreaterThan(0);
  });

  it('renders header even with empty data', async () => {
    const api = MockCostApi.withEmptyData();
    renderEditor(api);
    await waitFor(() => {
      expect(screen.getByText('Views')).toBeDefined();
    });
    expect(screen.getByText('Compose dashboards from the widget library')).toBeDefined();
  });

  it('shows new view button with empty data', async () => {
    const api = MockCostApi.withEmptyData();
    renderEditor(api);
    await waitFor(() => {
      expect(screen.getByText('+ New view')).toBeDefined();
    });
  });

  it('shows empty state message when no view is selected', async () => {
    const api = MockCostApi.withEmptyData();
    renderEditor(api);
    await waitFor(() => {
      expect(screen.getByText('Pick a view on the left, or create a new one.')).toBeDefined();
    });
  });

  it('displays error message when save fails', async () => {
    const api = MockCostApi.withMethodError('saveViewsConfig', new Error('Failed to save views'));
    renderEditor(api);
    await waitFor(() => {
      expect(screen.getAllByText('Cost Overview').length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getByText('+ New view'));
    await waitFor(() => {
      expect(screen.getByText('Save changes')).toBeDefined();
    });
    fireEvent.click(screen.getByText('Save changes'));
    await waitFor(() => {
      expect(screen.getByText('Failed to save views')).toBeDefined();
    });
  });

  it('renders action buttons even with empty data', async () => {
    const api = MockCostApi.withEmptyData();
    renderEditor(api);
    await waitFor(() => {
      expect(screen.getByText('Open folder')).toBeDefined();
    });
    expect(screen.getByText('Import')).toBeDefined();
    expect(screen.getByText('Export')).toBeDefined();
    expect(screen.getByText('Reset built-ins')).toBeDefined();
  });

  it('shows saved button state when no changes', async () => {
    renderEditor();
    await waitFor(() => {
      expect(screen.getByText('Saved')).toBeDefined();
    });
  });
});
