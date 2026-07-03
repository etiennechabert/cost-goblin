import { render, screen, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { ConfirmModal } from '../components/confirm-modal.js';

afterEach(cleanup);

describe('ConfirmModal', () => {
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

  it('opts the modal out of window drag regions', () => {
    render(
      <ConfirmModal title="Test" message="msg" onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    // The overlay covers the frameless window's drag region (app header), so
    // it must carve itself out — otherwise backdrop clicks in the top band
    // drag the window instead of dismissing the modal.
    expect(screen.getByRole('dialog').className).toContain('[-webkit-app-region:no-drag]');
  });

  it('applies destructive styling when destructive prop is true', () => {
    render(
      <ConfirmModal title="Delete" message="msg" destructive onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    const confirmBtn = screen.getByText('Confirm');
    expect(confirmBtn.className).toContain('bg-negative');
  });
});
