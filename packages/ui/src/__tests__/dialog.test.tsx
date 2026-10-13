import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '../components/ui/button.js';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '../components/ui/dialog.js';
import { getModalLayerCount, getOpenModalLayerKinds } from '../hooks/modal-layers.js';
import { appRegionOf } from './app-region.js';

function TestDialog({ open }: Readonly<{ open: boolean }>): React.JSX.Element {
  return (
    <Dialog open={open}>
      <DialogContent aria-describedby={undefined}>
        <DialogTitle>Test dialog</DialogTitle>
      </DialogContent>
    </Dialog>
  );
}

describe('Dialog', () => {
  it('opts the overlay and content out of window drag regions', () => {
    render(<TestDialog open />);
    // The overlay covers the frameless window's drag region (app header), so
    // both layers must carve themselves out — otherwise clicks in the top
    // band drag the window instead of reaching the dialog.
    const content = screen.getByRole('dialog', { name: 'Test dialog' });
    expect(appRegionOf(content)).toBe('no-drag');
    const overlay = content.previousElementSibling;
    if (overlay === null) throw new Error('overlay not found');
    expect(appRegionOf(overlay)).toBe('no-drag');
  });

  // The wrapper component renders even while the dialog is closed, so the
  // registration must follow the content's presence, not the wrapper's.
  it('counts as a modal layer only while open', () => {
    const { rerender } = render(<TestDialog open={false} />);
    expect(getModalLayerCount()).toBe(0);
    rerender(<TestDialog open />);
    expect(getModalLayerCount()).toBe(1);
    expect(getOpenModalLayerKinds()).toEqual(['dialog']);
    rerender(<TestDialog open={false} />);
    expect(getModalLayerCount()).toBe(0);
  });

  // Without asChild, Radix's Close is a <button> of its own: wrapping our
  // button made a <button><button> — two tab stops, invalid HTML, and the
  // dialog's auto-focus landing on the unstyled outer one.
  it('renders DialogClose as its child button, not a button around it', async () => {
    function Closable(): React.JSX.Element {
      const [open, setOpen] = useState(true);
      return (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent aria-describedby={undefined}>
            <DialogTitle>Closable</DialogTitle>
            <DialogClose><Button variant="ghost" size="sm">Dismiss</Button></DialogClose>
            <DialogClose><button type="button">Cancel</button></DialogClose>
          </DialogContent>
        </Dialog>
      );
    }
    const user = userEvent.setup();
    render(<Closable />);
    const dialog = screen.getByRole('dialog', { name: 'Closable' });
    expect(dialog.querySelectorAll('button button')).toHaveLength(0);
    expect(screen.getAllByRole('button')).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('dialog', { name: 'Closable' })).toBeNull();
  });

  // The app's dialogs are controlled (`open` state, no Trigger): the release
  // notes, "Reload data?", the baseline dialogs. Radix only gives focus back
  // to a Trigger, so without this it dropped to <body> on close.
  it('returns focus to what had it before a controlled dialog opened', async () => {
    function Page(): React.JSX.Element {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => { setOpen(true); }}>What&apos;s new</button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent aria-describedby={undefined}>
              <DialogTitle>Release notes</DialogTitle>
              <DialogClose><button type="button">Dismiss</button></DialogClose>
            </DialogContent>
          </Dialog>
        </>
      );
    }
    const user = userEvent.setup();
    render(<Page />);
    const opener = screen.getByRole('button', { name: "What's new" });

    await user.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Release notes' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard('{Escape}');
    await waitFor(() => { expect(document.activeElement).toBe(opener); });

    await user.click(opener);
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => { expect(document.activeElement).toBe(opener); });
  });

  it('does not pull focus behind a dialog that replaced it', async () => {
    // Baseline triage re-keys its dialog per item: the old one unmounts in the
    // same commit the next one mounts. Its opener, on the page now hidden
    // behind the new dialog, must not be focused (scrolling the page and
    // announcing it) before the new dialog's trap pulls focus back.
    function Page(): React.JSX.Element {
      const [item, setItem] = useState<number | null>(null);
      return (
        <>
          <button type="button" onClick={() => { setItem(0); }}>Triage new</button>
          {item !== null && (
            <Dialog key={item} open onOpenChange={(o) => { if (!o) setItem(null); }}>
              <DialogContent aria-describedby={undefined}>
                <DialogTitle>{`Baseline ${String(item)}`}</DialogTitle>
                <button type="button" onClick={() => { setItem(item + 1); }}>Next</button>
              </DialogContent>
            </Dialog>
          )}
        </>
      );
    }
    const user = userEvent.setup();
    render(<Page />);
    const opener = screen.getByRole('button', { name: 'Triage new' });
    await user.click(opener);
    // A spy, not a focus listener: in jsdom the new dialog's trap bounces focus
    // back before the opener's focus event lands, while a browser has already
    // scrolled the page to it by then.
    const focusOpener = vi.spyOn(opener, 'focus');

    await user.click(screen.getByRole('button', { name: 'Next' }));
    const next = screen.getByRole('dialog', { name: 'Baseline 1' });
    // Past Radix's close-time focus handling, which runs a tick after unmount.
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(focusOpener).not.toHaveBeenCalled();
    expect(next.contains(document.activeElement)).toBe(true);

    // The last one still closes. Its opener was the previous dialog's Next,
    // gone by now, so focus is not handed back to "Triage new".
    await user.keyboard('{Escape}');
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
  });

  it('leaves focus alone on close when its opener is gone', async () => {
    function Page(): React.JSX.Element {
      const [open, setOpen] = useState(false);
      return (
        <>
          {!open && <button type="button" onClick={() => { setOpen(true); }}>Open</button>}
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent aria-describedby={undefined}>
              <DialogTitle>Gone</DialogTitle>
            </DialogContent>
          </Dialog>
        </>
      );
    }
    const user = userEvent.setup();
    render(<Page />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Gone' })).toBeNull();
    // The new Open button is a different element: nothing to give focus back to.
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(document.activeElement).toBe(document.body);
  });
});
