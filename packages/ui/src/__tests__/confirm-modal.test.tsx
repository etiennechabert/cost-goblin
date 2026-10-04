import { render, screen, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { ConfirmModal } from '../components/confirm-modal.js';

afterEach(cleanup);

describe('ConfirmModal', () => {
  it('is a modal dialog named by its title and described by its message', () => {
    render(
      <ConfirmModal title="Delete workspace" message="This cannot be undone." onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Delete workspace', description: 'This cannot be undone.' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('keeps two open modals apart: each is named and described by its own text', () => {
    render(
      <>
        <ConfirmModal title="First" message="one" onConfirm={vi.fn()} onCancel={vi.fn()} />
        <ConfirmModal title="Second" message="two" onConfirm={vi.fn()} onCancel={vi.fn()} />
      </>,
    );
    expect(screen.getByRole('dialog', { name: 'First', description: 'one' })).toBeDefined();
    expect(screen.getByRole('dialog', { name: 'Second', description: 'two' })).toBeDefined();
  });

  it('calls onCancel on a backdrop click; only the backdrop is aria-hidden', async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(
      <ConfirmModal title="Test" message="msg" onConfirm={vi.fn()} onCancel={onCancel} />,
    );
    // Found by role at all ⇒ no aria-hidden ancestor hides the dialog.
    const dialog = screen.getByRole('dialog', { name: 'Test' });
    const backdrop = dialog.querySelector(':scope > [aria-hidden="true"]');
    if (!(backdrop instanceof HTMLElement)) throw new Error('backdrop not found');
    await user.click(backdrop);
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
