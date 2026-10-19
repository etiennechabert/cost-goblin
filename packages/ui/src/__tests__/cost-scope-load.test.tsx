import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import type { CostScopeConfig } from '@costgoblin/core/browser';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { CostScopeView } from '../views/cost-scope.js';
import { CostScopeLoadError } from '../components/cost-scope-load-error.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderView(api: MockCostApi = new MockCostApi(), onConfigLoaded?: (cfg: CostScopeConfig) => void) {
  return render(
    <CostApiProvider value={api}>
      <CostScopeView onConfigLoaded={onConfigLoaded} />
    </CostApiProvider>,
  );
}

const LOAD_ERROR = "Error invoking remote method 'cost-scope:get-config': ConfigValidationError: costScope.rules[0].conditions[0].values must be an array";

/** Past the preview's 300 ms debounce, for asserting none ran. */
function afterPreviewDebounce(): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, 400); });
}

describe('CostScopeView when cost-scope.yaml fails to load', () => {
  it('shows why, and nothing in it can save over the file', async () => {
    const api = new MockCostApi();
    vi.spyOn(api, 'getCostScope').mockRejectedValue(new Error(LOAD_ERROR));
    renderView(api);

    expect(await screen.findByText(LOAD_ERROR)).not.toBeNull();
    expect(screen.getByText("Couldn't load your cost scope")).not.toBeNull();
    // The editor starts from the defaults: none of them is shown as the
    // user's, and nothing that would write them (plus an edit) is offered.
    // Saving from there used to replace every rule in the file.
    expect(screen.queryByRole('heading', { name: 'Cost metric' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add rule' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByText('Saved')).toBeNull();
    expect(screen.getByRole('button', { name: 'Reveal YAML' })).not.toBeNull();

    // Nor does it preview the defaults as if they were the user's scope.
    await afterPreviewDebounce();
    expect(api.costScopePreviewRanges).toEqual([]);
    expect(api.savedCostScopes).toEqual([]);
  });

  it('reads cost-scope.yaml again on Retry, opens the editor and hands the config to the host', async () => {
    const api = new MockCostApi();
    const realConfig = await api.getCostScope();
    const load = vi.spyOn(api, 'getCostScope').mockRejectedValueOnce(new Error(LOAD_ERROR));
    const onConfigLoaded = vi.fn();
    renderView(api, onConfigLoaded);
    await screen.findByText(LOAD_ERROR);
    expect(onConfigLoaded).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('button', { name: 'Add rule' })).not.toBeNull();
    expect(screen.queryByText(LOAD_ERROR)).toBeNull();
    expect(screen.getByText('Saved')).not.toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
    // The app shell may still show the load error; this is how it learns.
    expect(onConfigLoaded).toHaveBeenCalledExactlyOnceWith(realConfig);
    await waitFor(() => { expect(api.costScopePreviewRanges.length).toBeGreaterThan(0); });
  });

  it('keeps editing off until cost-scope.yaml has loaded', async () => {
    const api = new MockCostApi();
    const realConfig = await api.getCostScope();
    let release: (cfg: CostScopeConfig) => void = () => undefined;
    vi.spyOn(api, 'getCostScope').mockReturnValue(new Promise(resolve => { release = resolve; }));
    renderView(api);

    expect(screen.queryByRole('button', { name: 'Add rule' })).toBeNull();
    await afterPreviewDebounce();
    expect(api.costScopePreviewRanges).toEqual([]);

    release(realConfig);
    expect(await screen.findByRole('button', { name: 'Add rule' })).not.toBeNull();
  });
});

describe('CostScopeLoadError', () => {
  it('says why cost-scope.yaml did not load and that it was left as it is', () => {
    render(
      <CostApiProvider value={new MockCostApi()}>
        <CostScopeLoadError message="costScope.lagDays must be a non-negative integer" onRetry={vi.fn()} />
      </CostApiProvider>,
    );

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain("Couldn't load your cost scope");
    expect(alert.textContent).toContain('cost-scope.yaml was left as it is');
    expect(alert.textContent).toContain('costScope.lagDays must be a non-negative integer');
    expect(screen.queryByRole('button', { name: 'Open folder' })).toBeNull();
  });

  it('opens the cost scope folder when asked to offer it', () => {
    const api = new MockCostApi();
    const reveal = vi.spyOn(api, 'revealCostScopeFolder');
    render(
      <CostApiProvider value={api}>
        <CostScopeLoadError message="EACCES: permission denied" onRetry={vi.fn()} showOpenFolder />
      </CostApiProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open folder' }));

    expect(reveal).toHaveBeenCalledTimes(1);
  });
});
