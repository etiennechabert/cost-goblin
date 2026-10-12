import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asDimensionId } from '@costgoblin/core/browser';
import type { CostApi } from '@costgoblin/core/browser';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { Dialog, DialogContent, DialogTitle } from '../components/ui/dialog.js';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { DimensionsView } from '../views/dimensions.js';

/** An open dimension editor closes on a mousedown outside it (or asks to
 *  discard its edits). A mousedown inside a modal layered over the page — the
 *  palette's "Reload data?" dialog, the release notes — is that modal's, not
 *  "outside the editor": acting on it would close the editor, or mount the
 *  discard prompt behind the modal the user is working in. */

const STRIP_PATTERNS = /Name strip patterns/;

function Page({ api, reload }: Readonly<{ api: CostApi; reload: boolean }>): React.JSX.Element {
  return (
    <CostApiProvider value={api}>
      <DimensionsView />
      <button type="button">Page behind</button>
      <Dialog open={reload}>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Reload data?</DialogTitle>
          <button type="button">Reload</button>
        </DialogContent>
      </Dialog>
    </CostApiProvider>
  );
}

function makeApi(): CostApi {
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
  return api;
}

/** Renders the view and opens the account dimension's editor. */
async function openEditor(): Promise<{ user: ReturnType<typeof userEvent.setup>; rerender: (reload: boolean) => void }> {
  const api = makeApi();
  const user = userEvent.setup();
  const { rerender } = render(<Page api={api} reload={false} />);
  const row = await waitFor(() => {
    const found = screen.getAllByRole('button', { name: /account_id/ })[0];
    if (found === undefined) throw new Error('account row not rendered yet');
    return found;
  });
  await user.click(row);
  expect(screen.getByLabelText(STRIP_PATTERNS)).toBeDefined();
  return { user, rerender: (reload) => { rerender(<Page api={api} reload={reload} />); } };
}

function reloadButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Reload' });
}

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe('Dimension editor — click outside', () => {
  it('closes on a mousedown on the page outside it', async () => {
    await openEditor();
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Page behind' }));
    expect(screen.queryByLabelText(STRIP_PATTERNS)).toBeNull();
  });

  it('stays open on a mousedown inside a modal over the page', async () => {
    const { rerender } = await openEditor();
    rerender(true);
    fireEvent.mouseDown(reloadButton());
    expect(screen.getByLabelText(STRIP_PATTERNS)).toBeDefined();
  });

  it('does not ask to discard its edits on a mousedown inside a modal over the page', async () => {
    const { user, rerender } = await openEditor();
    await user.type(screen.getByLabelText(STRIP_PATTERNS), '{End}\n^beta-');
    rerender(true);
    fireEvent.mouseDown(reloadButton());
    expect(screen.queryByRole('dialog', { name: 'Discard unsaved changes?', hidden: true })).toBeNull();
    expect(screen.getByLabelText(STRIP_PATTERNS)).toBeDefined();
  });
});
