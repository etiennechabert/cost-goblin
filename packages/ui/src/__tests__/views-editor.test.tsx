import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import type { ViewsConfig } from '@costgoblin/core/browser';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { ViewsEditor } from '../views/views-editor.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderEditor(api: MockCostApi = new MockCostApi(), onConfigLoaded?: (cfg: ViewsConfig) => void) {
  return render(
    <CostApiProvider value={api}>
      <ViewsEditor onConfigLoaded={onConfigLoaded} />
    </CostApiProvider>,
  );
}

/** The editor's controls that change the views it would save. */
const WRITE_CONTROLS = ['+ New view', 'Import', 'Reset built-ins'];

const LOAD_ERROR = "Error invoking remote method 'views:get-config': ConfigValidationError: views[1].rows[0].widgets[0].topN must be a number";

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

describe('ViewsEditor when views.yaml fails to load', () => {
  it('shows why, and nothing in it can save over the file', async () => {
    const api = new MockCostApi();
    vi.spyOn(api, 'getViewsConfig').mockRejectedValue(new Error(LOAD_ERROR));
    renderEditor(api);

    expect(await screen.findByText(LOAD_ERROR)).not.toBeNull();
    expect(screen.getByText("Couldn't load your dashboards")).not.toBeNull();
    for (const name of [...WRITE_CONTROLS, 'Saved']) {
      expect(screen.getByRole('button', { name })).toHaveProperty('disabled', true);
    }

    // The editor starts from an empty config. Saving a new view from there
    // used to replace views.yaml with just that view.
    fireEvent.click(screen.getByRole('button', { name: '+ New view' }));
    expect(screen.queryByText('New view')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(api.savedViewsConfigs).toEqual([]);
  });

  it('reads views.yaml again on Retry, turns editing back on and hands the config to the host', async () => {
    const api = new MockCostApi();
    const realConfig = await api.getViewsConfig();
    const load = vi.spyOn(api, 'getViewsConfig').mockRejectedValueOnce(new Error(LOAD_ERROR));
    const onConfigLoaded = vi.fn();
    renderEditor(api, onConfigLoaded);
    await screen.findByText(LOAD_ERROR);
    expect(onConfigLoaded).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect((await screen.findAllByText('Cost Overview')).length).toBeGreaterThan(0);
    expect(screen.queryByText(LOAD_ERROR)).toBeNull();
    for (const name of WRITE_CONTROLS) {
      expect(screen.getByRole('button', { name })).toHaveProperty('disabled', false);
    }
    expect(load).toHaveBeenCalledTimes(2);
    // The app shell is still showing the load error; this is how it learns.
    expect(onConfigLoaded).toHaveBeenCalledExactlyOnceWith(realConfig);
  });

  it('keeps editing off until views.yaml has loaded', async () => {
    const api = new MockCostApi();
    let release: (cfg: ViewsConfig) => void = () => undefined;
    const realConfig = await api.getViewsConfig();
    vi.spyOn(api, 'getViewsConfig').mockReturnValue(new Promise(resolve => { release = resolve; }));
    renderEditor(api);

    for (const name of WRITE_CONTROLS) {
      expect(screen.getByRole('button', { name })).toHaveProperty('disabled', true);
    }

    release(realConfig);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '+ New view' })).toHaveProperty('disabled', false);
    });
  });
});
