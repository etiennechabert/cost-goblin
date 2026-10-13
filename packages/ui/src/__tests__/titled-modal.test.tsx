import { act, fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmModal } from '../components/confirm-modal.js';
import { TitledModal } from '../components/titled-modal.js';
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover.js';
import { expectTopLayer } from './modal-dom.js';

/** A page with a trigger that opens a TitledModal holding a text input, and
 *  an unrelated button behind it. */
function Page({ onClose }: Readonly<{ onClose?: () => void }>): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => { setOpen(true); }}>Open</button>
      <button type="button">Behind</button>
      {open && (
        <TitledModal title="Rename" onClose={() => { onClose?.(); setOpen(false); }}>
          <label htmlFor="name">Name</label>
          <input id="name" />
        </TitledModal>
      )}
    </>
  );
}

describe('TitledModal', () => {
  it('moves focus into the dialog on open and returns it to the opener on close', async () => {
    const user = userEvent.setup();
    render(<Page />);
    const trigger = screen.getByRole('button', { name: 'Open' });
    await user.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Rename' }).contains(document.activeElement)).toBe(true);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Rename' })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  // aria-modal declares the page inert — Tab must not walk onto it.
  it('pulls focus that lands on the page behind back into the dialog', async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = screen.getByRole('dialog', { name: 'Rename' });
    // The page behind is hidden from assistive tech while the modal is up.
    act(() => { screen.getByRole('button', { name: 'Behind', hidden: true }).focus(); });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('leaves focus alone in another dialog opened alongside it', () => {
    const first = <TitledModal title="First" onClose={vi.fn()}><p>one</p></TitledModal>;
    const { rerender } = render(<>{first}{null}</>);
    rerender(<>{first}<ConfirmModal title="Second" message="two" onConfirm={vi.fn()} onCancel={vi.fn()} /></>);
    // ConfirmModal focused its Cancel on mount; the TitledModal must not
    // pull it back (the two would otherwise fight over focus forever).
    const second = screen.getByRole('dialog', { name: 'Second' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    expect(second.contains(document.activeElement)).toBe(true);
  });

  it('ignores an Escape that cancels an IME composition', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Page onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.click(screen.getByLabelText('Name'));

    // A real keydown, cancelable, on the field being composed in.
    fireEvent.keyDown(screen.getByLabelText('Name'), { key: 'Escape', isComposing: true });

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Rename' })).toBeDefined();
  });

  it('leaves Escape to a layer opened inside it', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <TitledModal title="Pick a profile" onClose={onClose}>
        <Popover>
          <PopoverTrigger>Profiles</PopoverTrigger>
          <PopoverContent><div role="group" aria-label="Profile list" /></PopoverContent>
        </Popover>
      </TitledModal>,
    );
    await user.click(screen.getByRole('button', { name: 'Profiles' }));
    const popover = screen.getByRole('group', { name: 'Profile list' }).parentElement;
    if (popover === null) throw new Error('popover not found');
    await expectTopLayer(popover);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('group', { name: 'Profile list' })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Pick a profile' })).toBeDefined();
  });

  it('leaves Escape to a dialog opened inside it', async () => {
    const outer = vi.fn();
    const inner = vi.fn();
    function Nested(): React.JSX.Element {
      const [open, setOpen] = useState(false);
      return (
        <TitledModal title="Outer" onClose={outer}>
          <button type="button" onClick={() => { setOpen(true); }}>Import</button>
          {open && <TitledModal title="Inner" onClose={() => { inner(); setOpen(false); }}><p>nested</p></TitledModal>}
        </TitledModal>
      );
    }
    const user = userEvent.setup();
    render(<Nested />);
    await user.click(screen.getByRole('button', { name: 'Import' }));
    await expectTopLayer(screen.getByRole('dialog', { name: 'Inner' }), [screen.getByRole('dialog', { name: 'Outer', hidden: true })]);
    await user.keyboard('{Escape}');
    expect(inner).toHaveBeenCalledOnce();
    expect(outer).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Inner' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Outer' })).toBeDefined();
  });

  it('ignores Escape while locked shut', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<TitledModal title="Pulling" onClose={onClose} dismissable={false}><p>busy</p></TitledModal>);
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });
});
