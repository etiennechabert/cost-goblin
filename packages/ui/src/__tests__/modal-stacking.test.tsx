import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { CommandPalette } from '../components/command-palette.js';
import { ConfirmModal } from '../components/confirm-modal.js';
import { TitledModal } from '../components/titled-modal.js';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '../components/ui/dialog.js';
import { ModalShell, ModalShellTitle } from '../components/ui/modal-shell.js';
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover.js';
import { ViewYamlModal } from '../components/view-yaml-modal.js';
import { getOpenModalLayerKinds } from '../hooks/modal-layers.js';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { DataManagement } from '../views/data-management.js';
import { appRegionOf } from './app-region.js';
import { expectTopLayer } from './modal-dom.js';

/** How every modal surface in the app stacks. Two layer systems that cannot
 *  see each other (a body-portaled Radix dialog with its pointer lock and
 *  focus trap, and a dialog opened over it from somewhere else) let clicks
 *  meant for the visible dialog land on the hidden one underneath — the
 *  "Switch workspace" confirm whose clicks opened the release notes' GitHub
 *  links. */

const PALETTE_ITEMS = [{ id: 'workspace:acme', label: 'Switch to workspace: acme' }];
const PLACEHOLDER = 'Type to search...';
const NOTES = 'Update available';

/** The release-notes dialog the update flow opens on its own, at any time. */
function ReleaseNotes({ open, onLink }: Readonly<{ open: boolean; onLink?: () => void }>): React.JSX.Element {
  const [dismissed, setDismissed] = useState(false);
  return (
    <Dialog open={open && !dismissed} onOpenChange={(next) => { if (!next) setDismissed(true); }}>
      <DialogContent aria-describedby={undefined}>
        <DialogTitle>{NOTES}</DialogTitle>
        <a href="https://github.com/etiennechabert/cost-goblin/pull/1" onClick={(e) => { e.preventDefault(); onLink?.(); }}>#1</a>
        <DialogClose><button type="button">Dismiss</button></DialogClose>
      </DialogContent>
    </Dialog>
  );
}

/** The confirm a palette navigation opens beside whatever modal is up. */
function SwitchConfirm({ onConfirm = vi.fn() }: Readonly<{ onConfirm?: () => void }>): React.JSX.Element | null {
  const [cancelled, setCancelled] = useState(false);
  if (cancelled) return null;
  return (
    <ConfirmModal
      title="Switch workspace"
      message="The app restarts into acme."
      confirmLabel="Switch & Restart"
      onConfirm={onConfirm}
      onCancel={() => { setCancelled(true); }}
    />
  );
}

/** The z-index a surface paints at: the nearest Tailwind z-class on it or an
 *  ancestor (jsdom does not paint). */
function zIndexOf(el: Element): number {
  for (let node: Element | null = el; node !== null; node = node.parentElement) {
    for (const cls of node.classList) {
      const match = /^z-(?:\[(\d+)\]|(\d+))$/.exec(cls);
      if (match !== null) return Number(match[1] ?? match[2]);
    }
  }
  return 0;
}

/** Whether `top` paints over `below`: the higher z-index wins, and at equal
 *  z-index the one later in the document (both sit in the root stacking
 *  context). */
function paintsAbove(top: Element, below: Element): boolean {
  const zTop = zIndexOf(top);
  const zBelow = zIndexOf(below);
  if (zTop !== zBelow) return zTop > zBelow;
  return (below.compareDocumentPosition(top) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

/** A dialog by its title (or aria-label), whether or not a modal over it
 *  hides it from assistive tech — role queries cannot name a dialog that is
 *  itself aria-hidden, as the release notes' content is under a modal. */
function queryDialogTitled(title: string): HTMLElement | null {
  return screen.queryAllByRole('dialog', { hidden: true }).find((dialog) => {
    const labelledBy = dialog.getAttribute('aria-labelledby');
    const label = labelledBy === null ? dialog.getAttribute('aria-label') : document.getElementById(labelledBy)?.textContent;
    return label === title;
  }) ?? null;
}

function dialogTitled(title: string): HTMLElement {
  const dialog = queryDialogTitled(title);
  if (dialog === null) throw new Error(`no dialog titled "${title}"`);
  return dialog;
}

function notesDialog(): HTMLElement {
  return dialogTitled(NOTES);
}

describe('modal stacking', () => {
  it('counts the palette and a Radix dialog opened over it as one stack', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <><CommandPalette items={PALETTE_ITEMS} onNavigate={vi.fn()} /><ReleaseNotes open={false} /></>,
    );
    expect(getOpenModalLayerKinds()).toEqual([]);

    await user.keyboard('{Meta>}k{/Meta}');
    expect(getOpenModalLayerKinds()).toEqual(['palette']);

    // An update arrives while the palette is open.
    rerender(<><CommandPalette items={PALETTE_ITEMS} onNavigate={vi.fn()} /><ReleaseNotes open /></>);
    expect(getOpenModalLayerKinds()).toEqual(['palette', 'dialog']);
    await expectTopLayer(screen.getByRole('dialog', { name: NOTES }));

    // Escape closes the topmost layer only.
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: NOTES })).toBeNull();
    expect(getOpenModalLayerKinds()).toEqual(['palette']);

    await user.keyboard('{Meta>}k{/Meta}');
    expect(getOpenModalLayerKinds()).toEqual([]);
  });

  // The reported route: the release notes auto-open, then Cmd+K → "Switch to
  // workspace" mounted the confirm under the release notes' pointer lock.
  it('does not open the palette over an open Radix dialog, which stays usable', async () => {
    const onNavigate = vi.fn();
    const onLink = vi.fn();
    const user = userEvent.setup();
    render(
      <><CommandPalette items={PALETTE_ITEMS} onNavigate={onNavigate} /><ReleaseNotes open onLink={onLink} /></>,
    );
    const notes = screen.getByRole('dialog', { name: NOTES });

    await user.keyboard('{Meta>}k{/Meta}');
    expect(screen.queryByPlaceholderText(PLACEHOLDER)).toBeNull();
    expect(getOpenModalLayerKinds()).toEqual(['dialog']);
    expect(notes.contains(document.activeElement)).toBe(true);

    await user.click(screen.getByRole('link', { name: '#1' }));
    expect(onLink).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('dialog', { name: NOTES })).toBeNull();
    expect(onNavigate).not.toHaveBeenCalled();

    // With the dialog gone, Cmd+K opens the palette again.
    await user.keyboard('{Meta>}k{/Meta}');
    expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeDefined();
  });

  it('counts a ModalShell and a Radix dialog opened over it, and gates the palette on both', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <>
        <CommandPalette items={PALETTE_ITEMS} onNavigate={vi.fn()} />
        <ModalShell onClose={vi.fn()}><ModalShellTitle><h3>Switch workspace</h3></ModalShellTitle></ModalShell>
        <ReleaseNotes open={false} />
      </>,
    );
    expect(getOpenModalLayerKinds()).toEqual(['modal-shell']);
    rerender(
      <>
        <CommandPalette items={PALETTE_ITEMS} onNavigate={vi.fn()} />
        <ModalShell onClose={vi.fn()}><ModalShellTitle><h3>Switch workspace</h3></ModalShellTitle></ModalShell>
        <ReleaseNotes open />
      </>,
    );
    expect(getOpenModalLayerKinds()).toEqual(['modal-shell', 'dialog']);
    await user.keyboard('{Meta>}k{/Meta}');
    expect(screen.queryByPlaceholderText(PLACEHOLDER)).toBeNull();
  });

  // Each portaled surface paints over the app header, a window drag region:
  // one that does not opt out lets clicks in the top band drag the window.
  it('opts every portaled modal surface out of the window drag region', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Popover open>
          <PopoverTrigger>Workspaces</PopoverTrigger>
          <PopoverContent><div role="group" aria-label="Workspace menu" /></PopoverContent>
        </Popover>
        <CommandPalette items={PALETTE_ITEMS} onNavigate={vi.fn()} />
      </>,
    );
    expect(appRegionOf(screen.getByRole('group', { name: 'Workspace menu' }))).toBe('no-drag');

    await user.keyboard('{Meta>}k{/Meta}');
    for (const selector of ['[cmdk-overlay]', '[cmdk-dialog]']) {
      const surface = document.querySelector(selector);
      if (surface === null) throw new Error(`${selector} not found`);
      expect(appRegionOf(surface)).toBe('no-drag');
    }
    await user.keyboard('{Escape}');

    const { unmount } = render(<ReleaseNotes open />);
    const notes = screen.getByRole('dialog', { name: NOTES });
    expect(appRegionOf(notes)).toBe('no-drag');
    const notesOverlay = notes.previousElementSibling;
    if (notesOverlay === null) throw new Error('dialog overlay not found');
    expect(appRegionOf(notesOverlay)).toBe('no-drag');
    unmount();

    render(
      <ModalShell onClose={vi.fn()} backdropTestId="shell-backdrop">
        <ModalShellTitle><h3>Shell</h3></ModalShellTitle>
      </ModalShell>,
    );
    expect(appRegionOf(screen.getByTestId('shell-backdrop'))).toBe('no-drag');
    expect(appRegionOf(screen.getByRole('dialog', { name: 'Shell' }))).toBe('no-drag');
  });
});

type User = ReturnType<typeof userEvent.setup>;

/** One of the app's own modals, with a control that does something. */
interface ModalCase {
  readonly name: string;
  readonly dialogName: string;
  readonly render: (handlers: { readonly onAction: () => void; readonly onClose: () => void }) => React.JSX.Element;
  /** Uses the modal's control wired to `onAction`. */
  readonly act: (user: User, dialog: HTMLElement) => Promise<void>;
  /** A field the user types into, which must survive another layer's Escape.
   *  A plain confirm has none. */
  readonly field?: (dialog: HTMLElement) => HTMLElement;
}

const VIEW_YAML = [
  'id: team-costs',
  'name: Team costs',
  'rows:',
  '  - widgets:',
  '      - id: w-pie',
  '        type: pie',
  '        size: medium',
  '        groupBy: service',
].join('\n');

const MODAL_CASES: readonly ModalCase[] = [
  {
    name: 'ConfirmModal',
    dialogName: 'Delete workspace',
    render: ({ onAction, onClose }) => (
      <ConfirmModal title="Delete workspace" message="This cannot be undone." confirmLabel="Delete Workspace" onConfirm={onAction} onCancel={onClose} />
    ),
    act: async (user, dialog) => { await user.click(within(dialog).getByRole('button', { name: 'Delete Workspace' })); },
  },
  {
    name: 'TitledModal',
    dialogName: 'New workspace',
    render: ({ onAction, onClose }) => (
      <TitledModal title="New workspace" onClose={onClose}>
        <label htmlFor="workspace-name">Workspace name</label>
        <input id="workspace-name" />
        <button type="button" onClick={onAction}>Create &amp; Restart</button>
      </TitledModal>
    ),
    act: async (user, dialog) => { await user.click(within(dialog).getByRole('button', { name: 'Create & Restart' })); },
    field: (dialog) => within(dialog).getByLabelText('Workspace name'),
  },
  {
    name: 'ViewYamlModal',
    dialogName: 'Import view',
    render: ({ onAction, onClose }) => (
      <ViewYamlModal mode="import" existingIds={new Set()} onImport={onAction} onClose={onClose} />
    ),
    act: async (user, dialog) => {
      await user.click(within(dialog).getByRole('textbox'));
      await user.paste(VIEW_YAML);
      await user.click(within(dialog).getByRole('button', { name: 'Import' }));
    },
    field: (dialog) => within(dialog).getByRole('textbox'),
  },
];

/** The case's modal (open until closed) beside the release notes. */
function CaseStack({ modalCase, modal, notes, confirm = false, onAction, onLink }: Readonly<{
  modalCase: ModalCase;
  modal: boolean;
  notes: boolean;
  confirm?: boolean;
  onAction: () => void;
  onLink: () => void;
}>): React.JSX.Element {
  const [closed, setClosed] = useState(false);
  return (
    <>
      {modal && !closed && modalCase.render({ onAction, onClose: () => { setClosed(true); } })}
      <ReleaseNotes open={notes} onLink={onLink} />
      {confirm && <SwitchConfirm />}
    </>
  );
}

describe.each(MODAL_CASES)('modal stacking — $name', (modalCase) => {
  function dialog(): HTMLElement {
    return dialogTitled(modalCase.dialogName);
  }

  it('under release notes that open on top: the notes take clicks and Escape, then the modal does', async () => {
    const onAction = vi.fn();
    const onLink = vi.fn();
    const user = userEvent.setup();
    const props = { modalCase, modal: true, onAction, onLink };
    const { rerender } = render(<CaseStack {...props} notes={false} />);
    rerender(<CaseStack {...props} notes />);

    expect(paintsAbove(notesDialog(), dialog())).toBe(true);
    expect(getOpenModalLayerKinds()).toEqual(['modal-shell', 'dialog']);
    expect(notesDialog().contains(document.activeElement)).toBe(true);
    await expectTopLayer(notesDialog(), [dialog()]);

    await user.keyboard('{Escape}');
    expect(queryDialogTitled(NOTES)).toBeNull();
    await expectTopLayer(dialog());

    await modalCase.act(user, screen.getByRole('dialog', { name: modalCase.dialogName }));
    expect(onAction).toHaveBeenCalledOnce();
    expect(onLink).not.toHaveBeenCalled();
  });

  // The reported bug: the confirm painted over the release notes but sat
  // under their pointer lock, so its clicks fell through to the notes' links.
  it('over release notes already open: the modal takes clicks and Escape, never the notes behind it', async () => {
    const onAction = vi.fn();
    const onLink = vi.fn();
    const user = userEvent.setup();
    const props = { modalCase, notes: true, onAction, onLink };
    const { rerender } = render(<CaseStack {...props} modal={false} />);
    rerender(<CaseStack {...props} modal />);

    expect(paintsAbove(dialog(), notesDialog())).toBe(true);
    expect(getOpenModalLayerKinds()).toEqual(['dialog', 'modal-shell']);
    expect(dialog().contains(document.activeElement)).toBe(true);
    await expectTopLayer(dialog(), [notesDialog()]);

    await modalCase.act(user, screen.getByRole('dialog', { name: modalCase.dialogName }));
    expect(onAction).toHaveBeenCalledOnce();
    expect(onLink).not.toHaveBeenCalled();

    await user.keyboard('{Escape}');
    expect(queryDialogTitled(modalCase.dialogName)).toBeNull();
    await expectTopLayer(notesDialog());
    await user.click(within(screen.getByRole('dialog', { name: NOTES })).getByRole('button', { name: 'Dismiss' }));
    expect(queryDialogTitled(NOTES)).toBeNull();
    expect(onLink).not.toHaveBeenCalled();
  });

  it('beside another modal opened later: Escape closes only that one and keeps what was typed', async () => {
    const user = userEvent.setup();
    const props = { modalCase, modal: true, notes: false, onAction: vi.fn(), onLink: vi.fn() };
    const { rerender } = render(<CaseStack {...props} />);
    const field = modalCase.field?.(dialog());
    if (field !== undefined) {
      await user.click(field);
      await user.keyboard('client-acme');
    }
    rerender(<CaseStack {...props} confirm />);
    const confirm = screen.getByRole('dialog', { name: 'Switch workspace' });
    expect(paintsAbove(confirm, dialog())).toBe(true);
    expect(confirm.contains(document.activeElement)).toBe(true);
    await expectTopLayer(confirm, [dialog()]);

    await user.keyboard('{Escape}');
    expect(queryDialogTitled('Switch workspace')).toBeNull();
    const kept = screen.getByRole('dialog', { name: modalCase.dialogName });
    if (field !== undefined) expect(modalCase.field?.(kept)).toHaveProperty('value', 'client-acme');
  });

  it('keeps the command palette from opening over it', async () => {
    const user = userEvent.setup();
    render(
      <>
        <CommandPalette items={PALETTE_ITEMS} onNavigate={vi.fn()} />
        <CaseStack modalCase={modalCase} modal notes={false} onAction={vi.fn()} onLink={vi.fn()} />
      </>,
    );
    await user.keyboard('{Meta>}k{/Meta}');
    expect(screen.queryByPlaceholderText(PLACEHOLDER)).toBeNull();
  });
});

// The setup wizard's modal, with the Import dialog it opens from inside.
describe('modal stacking — the Data Management wizard', () => {
  const ADD = 'Add provider';
  const IMPORT = 'Import configuration';

  function Page({ notes, confirm = false, onLink }: Readonly<{ notes: boolean; confirm?: boolean; onLink: () => void }>): React.JSX.Element {
    const [api] = useState(() => new MockCostApi());
    return (
      <CostApiProvider value={api}>
        <DataManagement />
        <ReleaseNotes open={notes} onLink={onLink} />
        {confirm && <SwitchConfirm />}
      </CostApiProvider>
    );
  }

  function wizard(): HTMLElement {
    return dialogTitled(ADD);
  }

  it('under release notes that open on top: the notes take Escape, then the wizard takes clicks', async () => {
    const onLink = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<Page notes={false} onLink={onLink} />);
    await user.click(await screen.findByRole('button', { name: 'Add Provider' }));
    await screen.findByRole('dialog', { name: ADD });
    rerender(<Page notes onLink={onLink} />);

    expect(paintsAbove(notesDialog(), wizard())).toBe(true);
    expect(getOpenModalLayerKinds()).toEqual(['modal-shell', 'dialog']);
    expect(notesDialog().contains(document.activeElement)).toBe(true);
    await expectTopLayer(notesDialog(), [wizard()]);

    await user.keyboard('{Escape}');
    expect(queryDialogTitled(NOTES)).toBeNull();
    await expectTopLayer(wizard());
    await user.click(within(screen.getByRole('dialog', { name: ADD })).getByRole('button', { name: 'Close' }));
    await waitFor(() => { expect(queryDialogTitled(ADD)).toBeNull(); });
    expect(onLink).not.toHaveBeenCalled();
  });

  it('over release notes already open: the wizard and its Import dialog take clicks and Escape', async () => {
    const onLink = vi.fn();
    const user = userEvent.setup();
    render(<Page notes onLink={onLink} />);
    // Something other than a click opens the wizard while the notes hold the
    // pointer (a click could not reach the button behind them).
    fireEvent.click(await screen.findByRole('button', { name: 'Add Provider', hidden: true }));
    await screen.findByRole('dialog', { name: ADD });

    expect(paintsAbove(wizard(), notesDialog())).toBe(true);
    expect(wizard().contains(document.activeElement)).toBe(true);
    await expectTopLayer(wizard(), [notesDialog()]);

    await user.click(within(wizard()).getByRole('button', { name: 'Import from a teammate' }));
    const importDialog = await screen.findByRole('dialog', { name: IMPORT });
    expect(paintsAbove(importDialog, wizard())).toBe(true);
    await expectTopLayer(importDialog, [wizard(), notesDialog()]);
    expect(onLink).not.toHaveBeenCalled();

    await user.keyboard('{Escape}');
    await waitFor(() => { expect(queryDialogTitled(IMPORT)).toBeNull(); });
    await expectTopLayer(wizard(), [notesDialog()]);
    await user.keyboard('{Escape}');
    await waitFor(() => { expect(queryDialogTitled(ADD)).toBeNull(); });
    expect(screen.getByRole('dialog', { name: NOTES })).toBeDefined();
    expect(onLink).not.toHaveBeenCalled();
  });

  it('beside a confirm opened later: Escape closes only the confirm and keeps the typed sharing key', async () => {
    const onLink = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<Page notes={false} onLink={onLink} />);
    await user.click(await screen.findByRole('button', { name: 'Add Provider' }));
    await user.click(within(await screen.findByRole('dialog', { name: ADD })).getByRole('button', { name: 'Import from a teammate' }));
    const importDialog = await screen.findByRole('dialog', { name: IMPORT });
    await expectTopLayer(importDialog, [wizard()]);
    await user.type(within(importDialog).getByLabelText('Sharing key from a teammate'), 'CGSHARE1-teammate');

    rerender(<Page notes={false} confirm onLink={onLink} />);
    const confirm = screen.getByRole('dialog', { name: 'Switch workspace' });
    expect(paintsAbove(confirm, importDialog)).toBe(true);
    await expectTopLayer(confirm, [importDialog, wizard()]);

    await user.keyboard('{Escape}');
    expect(queryDialogTitled('Switch workspace')).toBeNull();
    const kept = screen.getByRole('dialog', { name: IMPORT });
    expect(within(kept).getByLabelText('Sharing key from a teammate')).toHaveProperty('value', 'CGSHARE1-teammate');
    expect(wizard()).toBeDefined();
  });
});
