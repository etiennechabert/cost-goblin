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
});
