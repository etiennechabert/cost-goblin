import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asDimensionId } from '@costgoblin/core/browser';
import type { CostApi } from '@costgoblin/core/browser';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { Dialog, DialogContent, DialogTitle } from '../components/ui/dialog.js';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { DimensionsView } from '../views/dimensions.js';

/** An open dimension editor closes on a click outside it (or asks to discard
 *  its edits). On the click, not the press: closing on the press moved the
 *  rows below the editor up under the pointer, so a click meant to open one of
 *  them was lost. A click inside a modal layered over the page — the palette's
 *  "Reload data?" dialog, the release notes — is that modal's, not "outside
 *  the editor": acting on it would close the editor, or mount the discard
 *  prompt behind the modal the user is working in. */

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
    }, {
      name: asDimensionId('charge_category'),
      label: 'Charge Category',
      field: 'charge_category',
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
  it('closes on a click on the page outside it, not on the press', async () => {
    const { user } = await openEditor();
    const outside = screen.getByRole('button', { name: 'Page behind' });
    fireEvent.mouseDown(outside);
    expect(screen.getByLabelText(STRIP_PATTERNS)).toBeDefined();
    await user.click(outside);
    expect(screen.queryByLabelText(STRIP_PATTERNS)).toBeNull();
  });

  it('opens the row clicked while another editor is open', async () => {
    const { user } = await openEditor();
    await user.click(screen.getByRole('button', { name: /charge_category/ }));
    expect(screen.queryByLabelText(STRIP_PATTERNS)).toBeNull();
    expect(screen.getByLabelText('Display Label')).toHaveProperty('value', 'Charge Category');
  });

  it('with unsaved edits, asks first and keeps the clicked row closed', async () => {
    const { user } = await openEditor();
    await user.type(screen.getByLabelText(STRIP_PATTERNS), '{End}\n^beta-');
    await user.click(screen.getByRole('button', { name: /charge_category/ }));
    expect(await screen.findByRole('dialog', { name: 'Discard unsaved changes?' })).toBeDefined();
    expect(screen.getByLabelText('Display Label')).toHaveProperty('value', 'Account');
  });

  it('stays open when a press inside it ends outside, as a text selection does', async () => {
    await openEditor();
    fireEvent.mouseDown(screen.getByLabelText(STRIP_PATTERNS));
    fireEvent.click(screen.getByRole('button', { name: 'Page behind' }));
    expect(screen.getByLabelText(STRIP_PATTERNS)).toBeDefined();
  });

  it('stays open on a click inside a modal over the page', async () => {
    const { rerender } = await openEditor();
    rerender(true);
    fireEvent.mouseDown(reloadButton());
    fireEvent.click(reloadButton());
    expect(screen.getByLabelText(STRIP_PATTERNS)).toBeDefined();
  });

  it('does not ask to discard its edits on a click inside a modal over the page', async () => {
    const { user, rerender } = await openEditor();
    await user.type(screen.getByLabelText(STRIP_PATTERNS), '{End}\n^beta-');
    rerender(true);
    fireEvent.mouseDown(reloadButton());
    fireEvent.click(reloadButton());
    expect(screen.queryByRole('dialog', { name: 'Discard unsaved changes?', hidden: true })).toBeNull();
    expect(screen.getByLabelText(STRIP_PATTERNS)).toBeDefined();
  });
});
