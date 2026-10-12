import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { CommandPalette } from '../components/command-palette.js';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '../components/ui/dialog.js';
import { ModalShell, ModalShellTitle } from '../components/ui/modal-shell.js';
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover.js';
import { getOpenModalLayerKinds } from '../hooks/modal-layers.js';
import { appRegionOf } from './app-region.js';

/** How every modal surface in the app stacks. Two layer systems that cannot
 *  see each other (a body-portaled Radix dialog with its pointer lock and
 *  focus trap, and a dialog opened over it from somewhere else) let clicks
 *  meant for the visible dialog land on the hidden one underneath — the
 *  "Switch workspace" confirm whose clicks opened the release notes' GitHub
 *  links. */

const PALETTE_ITEMS = [{ id: 'workspace:acme', label: 'Switch to workspace: acme' }];
const PLACEHOLDER = 'Type to search...';

/** The release-notes dialog the update flow opens on its own, at any time. */
function ReleaseNotes({ open, onLink }: Readonly<{ open: boolean; onLink?: () => void }>): React.JSX.Element {
  const [dismissed, setDismissed] = useState(false);
  return (
    <Dialog open={open && !dismissed} onOpenChange={(next) => { if (!next) setDismissed(true); }}>
      <DialogContent aria-describedby={undefined}>
        <DialogTitle>Update available</DialogTitle>
        <a href="https://github.com/etiennechabert/cost-goblin/pull/1" onClick={(e) => { e.preventDefault(); onLink?.(); }}>#1</a>
        <DialogClose><button type="button">Dismiss</button></DialogClose>
      </DialogContent>
    </Dialog>
  );
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

    // Escape closes the topmost layer only.
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Update available' })).toBeNull();
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
    const notes = screen.getByRole('dialog', { name: 'Update available' });

    await user.keyboard('{Meta>}k{/Meta}');
    expect(screen.queryByPlaceholderText(PLACEHOLDER)).toBeNull();
    expect(getOpenModalLayerKinds()).toEqual(['dialog']);
    expect(notes.contains(document.activeElement)).toBe(true);

    await user.click(screen.getByRole('link', { name: '#1' }));
    expect(onLink).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('dialog', { name: 'Update available' })).toBeNull();
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
    const notes = screen.getByRole('dialog', { name: 'Update available' });
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
