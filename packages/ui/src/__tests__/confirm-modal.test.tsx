import { act, render, screen, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { ConfirmModal } from '../components/confirm-modal.js';
import { appRegionOf } from './app-region.js';
import { backdropOf, expectTopLayer } from './modal-dom.js';

afterEach(cleanup);

describe('ConfirmModal', () => {
  it('is a modal dialog named by its title and described by its message', () => {
    render(
      <ConfirmModal title="Delete workspace" message="This cannot be undone." onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Delete workspace', description: 'This cannot be undone.' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('keeps two open modals apart: each is named and described by its own text', async () => {
    function Stack({ second }: Readonly<{ second: boolean }>): React.JSX.Element {
      const [secondClosed, setSecondClosed] = useState(false);
      return (
        <>
          <ConfirmModal title="First" message="one" onConfirm={vi.fn()} onCancel={vi.fn()} />
          {second && !secondClosed && <ConfirmModal title="Second" message="two" onConfirm={vi.fn()} onCancel={() => { setSecondClosed(true); }} />}
        </>
      );
    }
    const user = userEvent.setup();
    const { rerender } = render(<Stack second={false} />);
    const first = screen.getByRole('dialog', { name: 'First', description: 'one' });
    rerender(<Stack second />);
    await expectTopLayer(screen.getByRole('dialog', { name: 'Second', description: 'two' }), [first]);
    // Only the topmost modal is exposed: the one under it is inert until the
    // top one closes.
    expect(screen.queryByRole('dialog', { name: 'First' })).toBeNull();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'First', description: 'one' })).toBeDefined();
  });

  it('calls onCancel on a backdrop click; nothing hides the dialog itself', async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(
      <ConfirmModal title="Test" message="msg" onConfirm={vi.fn()} onCancel={onCancel} />,
    );
    // Found by role at all ⇒ no aria-hidden ancestor hides the dialog.
    const dialog = screen.getByRole('dialog', { name: 'Test' });
    await user.click(backdropOf(dialog));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  // Callers pass inline arrows, and the app re-renders on every sync poll: a
  // fresh onCancel must not pull focus back to Cancel off the button the user
  // tabbed to.
  it('keeps focus where the user moved it when a parent re-render passes a new onCancel', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ConfirmModal title="Test" message="msg" onConfirm={vi.fn()} onCancel={() => undefined} />,
    );
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    await user.tab();
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    expect(document.activeElement).toBe(confirm);

    const onCancel = vi.fn();
    rerender(<ConfirmModal title="Test" message="msg" onConfirm={vi.fn()} onCancel={onCancel} />);
    expect(document.activeElement).toBe(confirm);
    // …and Escape reaches the latest handler.
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('returns focus to the opener on close and keeps it inside while open', async () => {
    function Page(): React.JSX.Element {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => { setOpen(true); }}>Delete</button>
          <button type="button">Behind</button>
          {open && <ConfirmModal title="Delete it?" message="msg" onConfirm={vi.fn()} onCancel={() => { setOpen(false); }} />}
        </>
      );
    }
    const user = userEvent.setup();
    render(<Page />);
    const trigger = screen.getByRole('button', { name: 'Delete' });
    await user.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Delete it?' });
    // The page behind is hidden from assistive tech while the modal is up.
    act(() => { screen.getByRole('button', { name: 'Behind', hidden: true }).focus(); });
    expect(dialog.contains(document.activeElement)).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Delete it?' })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('opts the modal out of window drag regions', () => {
    render(
      <ConfirmModal title="Test" message="msg" onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    // The backdrop covers the frameless window's drag region (app header), so
    // it must carve itself out — otherwise backdrop clicks in the top band
    // drag the window instead of dismissing the modal, and the buttons of a
    // dialog that reaches up into the band drag it too.
    expect(appRegionOf(screen.getByRole('dialog', { name: 'Test' }))).toBe('no-drag');
  });

  it('renders custom button labels', () => {
    render(
      <ConfirmModal title="Test" message="msg" confirmLabel="Yes" cancelLabel="No" onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByText('Yes')).toBeDefined();
    expect(screen.getByText('No')).toBeDefined();
  });

  it('calls onConfirm when confirm button clicked', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <ConfirmModal title="Test" message="msg" onConfirm={onConfirm} onCancel={vi.fn()} />,
    );
    await user.click(screen.getByText('Confirm'));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('calls onCancel when cancel button clicked', async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(
      <ConfirmModal title="Test" message="msg" onConfirm={vi.fn()} onCancel={onCancel} />,
    );
    await user.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('calls onCancel when escape key pressed', async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(
      <ConfirmModal title="Test" message="msg" onConfirm={vi.fn()} onCancel={onCancel} />,
    );
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('applies destructive styling when destructive prop is true', () => {
    render(
      <ConfirmModal title="Delete" message="msg" destructive onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    const confirmBtn = screen.getByText('Confirm');
    expect(confirmBtn.className).toContain('bg-negative');
  });
});
