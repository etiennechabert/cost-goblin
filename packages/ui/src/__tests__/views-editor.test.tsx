import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, describe, it, expect } from 'vitest';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { ViewsEditor } from '../views/views-editor.js';

afterEach(cleanup);

function renderEditor() {
  return render(
    <CostApiProvider value={new MockCostApi()}>
      <ViewsEditor />
    </CostApiProvider>,
  );
}

describe('ViewsEditor', () => {
  it('renders the heading', () => {
    renderEditor();
    expect(screen.getByText('Views')).toBeDefined();
  });

  it('shows the seed view name after load', async () => {
    renderEditor();
    await waitFor(() => {
      // Seed view name appears in left pane and again as the live-preview
      // header — verify at least one is present.
      expect(screen.getAllByText('Cost Overview').length).toBeGreaterThan(0);
    });
  });

  it('shows the New view button', () => {
    renderEditor();
    expect(screen.getByText('+ New view')).toBeDefined();
  });

  it('lets the user add a new view', async () => {
    renderEditor();
    await waitFor(() => {
      expect(screen.getAllByText('Cost Overview').length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getByText('+ New view'));
    expect(screen.getAllByText('New view').length).toBeGreaterThan(0);
  });

  it('shows the Reset to defaults button', () => {
    renderEditor();
    expect(screen.getByText('Reset to defaults')).toBeDefined();
  });
});
