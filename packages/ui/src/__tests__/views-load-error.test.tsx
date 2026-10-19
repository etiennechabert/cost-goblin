import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { ViewsLoadError } from '../components/views-load-error.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderError(props: { onRetry: () => void; showOpenFolder?: boolean }, api: MockCostApi = new MockCostApi()) {
  return render(
    <CostApiProvider value={api}>
      <ViewsLoadError message="views[0].rows[0].widgets[0].size must be one of: small, medium, large, full (got jumbo)" {...props} />
    </CostApiProvider>,
  );
}

describe('ViewsLoadError', () => {
  it('says why views.yaml did not load and that it was left as it is', () => {
    renderError({ onRetry: vi.fn() });

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain("Couldn't load your dashboards");
    expect(alert.textContent).toContain('views.yaml was left as it is');
    expect(alert.textContent).toContain('size must be one of: small, medium, large, full (got jumbo)');
  });

  it('retries the load', async () => {
    const onRetry = vi.fn();
    renderError({ onRetry });

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(onRetry).toHaveBeenCalledTimes(1);
    // The button settles back once the retry has run.
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Retry' })).toHaveProperty('disabled', false); });
  });

  it('opens the views folder when asked to offer it', () => {
    const api = new MockCostApi();
    const reveal = vi.spyOn(api, 'revealViewsFolder');
    renderError({ onRetry: vi.fn(), showOpenFolder: true }, api);

    fireEvent.click(screen.getByRole('button', { name: 'Open folder' }));

    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it('leaves Open folder out by default, for pages that have their own', () => {
    renderError({ onRetry: vi.fn() });

    expect(screen.queryByRole('button', { name: 'Open folder' })).toBeNull();
  });
});
