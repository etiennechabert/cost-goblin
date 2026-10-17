import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import type { CostApi } from '@costgoblin/core/browser';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { PaletteProvider } from '../hooks/use-palette.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { ViewsEditor } from '../views/views-editor.js';

afterEach(cleanup);

function renderEditor(api = new MockCostApi()) {
  return render(
    <CostApiProvider value={api}>
      <PaletteProvider>
        <ViewsEditor />
      </PaletteProvider>
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

  it('saves a view description, and drops it once cleared', async () => {
    const api = new MockCostApi();
    // Through the interface type: the mock's own method takes no config.
    const costApi: CostApi = api;
    const saveSpy = vi.spyOn(costApi, 'saveViewsConfig');
    renderEditor(api);
    const description = await screen.findByLabelText('View description');

    fireEvent.change(description, { target: { value: 'Where spend is heading' } });
    fireEvent.click(screen.getByText('Save changes'));
    await waitFor(() => { expect(saveSpy).toHaveBeenCalledTimes(1); });
    expect(saveSpy.mock.calls[0]?.[0].views[0]?.description).toBe('Where spend is heading');

    fireEvent.change(description, { target: { value: '  ' } });
    fireEvent.click(screen.getByText('Save changes'));
    await waitFor(() => { expect(saveSpy).toHaveBeenCalledTimes(2); });
    expect(saveSpy.mock.calls[1]?.[0].views[0]?.description).toBeUndefined();
  });
});
