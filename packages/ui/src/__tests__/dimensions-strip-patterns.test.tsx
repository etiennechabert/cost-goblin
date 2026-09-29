import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { asDimensionId } from '@costgoblin/core/browser';
import type { ColumnValuesPreview, CostApi } from '@costgoblin/core/browser';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { DimensionsView } from '../views/dimensions.js';

const PREVIEW: ColumnValuesPreview = {
  values: [{ value: 'payments', cost: 100 }, { value: 'search', cost: 50 }],
  distinctCount: 2,
  period: '2026-04',
  stripIssues: { invalid: [], slow: [], skipped: [] },
};

function renderView(preview: ColumnValuesPreview = PREVIEW) {
  // Typed as the interface so the spy carries discoverColumnValues' real
  // parameters (the mock's own override declares none).
  const api: CostApi = new MockCostApi();
  vi.spyOn(api, 'getDimensionsConfig').mockResolvedValue({
    builtIn: [{
      name: asDimensionId('account'),
      label: 'Account',
      field: 'account_id',
      displayField: 'account_name',
      useOrgAccounts: true,
      nameStripPatterns: ['^acme-'],
    }],
    tags: [],
  });
  const discover = vi.spyOn(api, 'discoverColumnValues').mockResolvedValue(preview);
  render(
    <CostApiProvider value={api}>
      <DimensionsView />
    </CostApiProvider>,
  );
  return { discover };
}

/** Open the account dimension's editor and wait for its first preview. */
async function openAccountEditor(discover: ReturnType<typeof renderView>['discover']): Promise<HTMLElement> {
  const user = userEvent.setup();
  const row = await waitFor(() => {
    const found = screen.getAllByRole('button', { name: /account_id/ })[0];
    if (found === undefined) throw new Error('account row not rendered yet');
    return found;
  });
  await user.click(row);
  await waitFor(() => { expect(discover).toHaveBeenCalledTimes(1); });
  return screen.getByLabelText(/Name strip patterns/);
}

function saveButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Save' });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  cleanup();
});

describe('BuiltInEditor — name strip patterns', () => {
  it('debounces the preview: a burst of typing fires exactly one more request', async () => {
    const { discover } = renderView();
    const textarea = await openAccountEditor(discover);

    // A keystroke-by-keystroke burst with the clock frozen. Driven through
    // fireEvent rather than user-event: RTL's async wrapper around user-event
    // drains with a setTimeout(0) that it only advances under *jest* fake
    // timers, so it never resolves under Vitest's.
    vi.useFakeTimers();
    const typed = '\n-production$';
    for (let end = 1; end <= typed.length; end++) {
      fireEvent.change(textarea, { target: { value: `^acme-${typed.slice(0, end)}` } });
    }
    expect(discover).toHaveBeenCalledTimes(1);

    // Still inside the 300 ms window after the last keystroke.
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(discover).toHaveBeenCalledTimes(1);

    // Settled: one request, carrying the full edited list.
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(discover).toHaveBeenCalledTimes(2);
    expect(discover).toHaveBeenLastCalledWith('account_id', expect.objectContaining({ nameStripPatterns: ['^acme-', '-production$'] }));

    // …and nothing more once it has settled.
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it('disables Save and explains why when a pattern is over the length cap', async () => {
    const { discover } = renderView();
    const textarea = await openAccountEditor(discover);
    const user = userEvent.setup();
    expect(saveButton().hasAttribute('disabled')).toBe(false);

    await user.clear(textarea);
    await user.paste('x'.repeat(257));

    expect(saveButton().hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/at most 256 are allowed/)).toBeDefined();
  });

  it('disables Save when there are more than 16 patterns, and never sends them to the preview', async () => {
    const { discover } = renderView();
    const textarea = await openAccountEditor(discover);
    const user = userEvent.setup();

    await user.clear(textarea);
    await user.paste(Array.from({ length: 17 }, (_, i) => `^p${String(i)}-`).join('\n'));

    expect(saveButton().hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/17 patterns/)).toBeDefined();
    // Let the debounce settle: an over-limit list is not previewed at all.
    await new Promise(resolve => { setTimeout(resolve, 500); });
    expect(discover.mock.calls.some(([, opts]) => (opts?.nameStripPatterns?.length ?? 0) > 16)).toBe(false);

    // Back within the caps: Save is enabled again.
    await user.clear(textarea);
    await user.paste('^acme-');
    expect(saveButton().hasAttribute('disabled')).toBe(false);
  });

  it('shows the patterns the preview could not apply, by 1-based position', async () => {
    const { discover } = renderView({ ...PREVIEW, stripIssues: { invalid: [1], slow: [0], skipped: [2, 3] } });
    await openAccountEditor(discover);

    await waitFor(() => { expect(screen.getByText(/Pattern 1 took too long/)).toBeDefined(); });
    expect(screen.getByText(/Pattern 2 is not a valid regular expression/)).toBeDefined();
    expect(screen.getByText(/Patterns 3, 4 were not evaluated/)).toBeDefined();
    // Issues are informational — they never block saving.
    expect(saveButton().hasAttribute('disabled')).toBe(false);
  });
});
