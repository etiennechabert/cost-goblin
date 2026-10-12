import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
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
});
