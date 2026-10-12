import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ModalShell, ModalShellDescription, ModalShellTitle } from '../components/ui/modal-shell.js';
import { getModalLayerCount, getOpenModalLayerKinds } from '../hooks/modal-layers.js';
import { appRegionOf } from './app-region.js';

/** A page with an opener for a ModalShell holding a text input, and an
 *  unrelated button behind it. Nothing here is a Radix `Trigger`: the app's
 *  modals are all opened from plain buttons and conditional rendering. */
function Page({ onClose, dismissable, withInitialFocus = false }: Readonly<{
  onClose?: () => void;
  dismissable?: boolean;
  withInitialFocus?: boolean;
}>): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button type="button" onClick={() => { setOpen(true); }}>Open</button>
      <button type="button">Behind</button>
      {open && (
        <ModalShell
          onClose={() => { onClose?.(); setOpen(false); }}
          backdropTestId="modal-backdrop"
          {...(dismissable === undefined ? {} : { dismissable })}
          {...(withInitialFocus ? { initialFocusRef: cancelRef } : {})}
        >
          <ModalShellTitle><h3>Rename</h3></ModalShellTitle>
          <ModalShellDescription><p>Pick a new name.</p></ModalShellDescription>
          <label htmlFor="name">Name</label>
          <input id="name" />
          <button ref={cancelRef} type="button">Cancel</button>
        </ModalShell>
      )}
    </>
  );
}

async function openPage(props: Parameters<typeof Page>[0] = {}): Promise<{
  user: ReturnType<typeof userEvent.setup>;
  opener: HTMLElement;
  dialog: HTMLElement;
}> {
  const user = userEvent.setup();
  render(<Page {...props} />);
  const opener = screen.getByRole('button', { name: 'Open' });
  await user.click(opener);
  return { user, opener, dialog: screen.getByRole('dialog', { name: 'Rename' }) };
}

function backdrop(): HTMLElement {
  return screen.getByTestId('modal-backdrop');
}

describe('ModalShell', () => {
  it('is a modal dialog named by its title and described by its description', async () => {
    const { dialog } = await openPage();
    expect(screen.getByRole('dialog', { name: 'Rename', description: 'Pick a new name.' })).toBe(dialog);
    // Radix does not set aria-modal; assistive tech relies on it to treat the
    // page behind as inert.
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('can be named by an aria-label when it has no title', () => {
    render(
      <ModalShell onClose={vi.fn()} ariaLabel="Add provider">
        <button type="button">Next</button>
      </ModalShell>,
    );
    expect(screen.getByRole('dialog', { name: 'Add provider' }).getAttribute('aria-modal')).toBe('true');
  });

  it('hides the page behind it from assistive tech while open', async () => {
    await openPage();
    expect(screen.queryByRole('button', { name: 'Behind' })).toBeNull();
  });

  it('focuses the dialog itself on open, so it is announced by name', async () => {
    const { dialog } = await openPage();
    expect(document.activeElement).toBe(dialog);
  });

  it('focuses initialFocusRef on open when given', async () => {
    await openPage({ withInitialFocus: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
  });

  it('leaves focus on a child that took it while mounting', () => {
    render(
      <ModalShell onClose={vi.fn()} ariaLabel="New workspace">
        <input aria-label="Name" autoFocus />
      </ModalShell>,
    );
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Name' }));
  });

  it('keeps focus inside while open', async () => {
    const { dialog } = await openPage();
    act(() => { screen.getByRole('button', { name: 'Behind', hidden: true }).focus(); });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  // Radix only restores focus to a `Trigger`, and these modals have none: left
  // to Radix, focus would drop to <body> on close.
  it('returns focus to the opener on close', async () => {
    const { user, opener } = await openPage();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Rename' })).toBeNull();
    await waitFor(() => { expect(document.activeElement).toBe(opener); });
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    const { user } = await openPage({ onClose });
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes on a backdrop click, but not on a click inside the dialog', async () => {
    const onClose = vi.fn();
    const { user } = await openPage({ onClose });
    await user.click(screen.getByRole('textbox', { name: 'Name' }));
    expect(onClose).not.toHaveBeenCalled();
    await user.click(backdrop());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('stays open on Escape and backdrop clicks when not dismissable', async () => {
    const onClose = vi.fn();
    const { user } = await openPage({ onClose, dismissable: false });
    await user.keyboard('{Escape}');
    await user.click(backdrop());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Rename' })).toBeDefined();
  });

  // Escape while an IME candidate window is up cancels the composition; it
  // must not also close the dialog under the half-typed text.
  it('ignores an Escape that cancels an IME composition', async () => {
    const onClose = vi.fn();
    const { user } = await openPage({ onClose });
    const input = screen.getByRole('textbox', { name: 'Name' });
    await user.click(input);
    fireEvent.keyDown(input, { key: 'Escape', isComposing: true });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes only the topmost of two stacked shells on Escape', async () => {
    function Stack(): React.JSX.Element {
      const [outer, setOuter] = useState(true);
      const [inner, setInner] = useState(false);
      return (
        <>
          {outer && (
            <ModalShell onClose={() => { setOuter(false); }} ariaLabel="Outer">
              <button type="button" onClick={() => { setInner(true); }}>Open inner</button>
            </ModalShell>
          )}
          {inner && (
            <ModalShell onClose={() => { setInner(false); }} ariaLabel="Inner">
              <button type="button">Inner action</button>
            </ModalShell>
          )}
        </>
      );
    }
    const user = userEvent.setup();
    render(<Stack />);
    const openInner = screen.getByRole('button', { name: 'Open inner' });
    await user.click(openInner);
    expect(screen.getByRole('dialog', { name: 'Inner' })).toBeDefined();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Inner' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Outer' })).toBeDefined();
    // Focus goes back to the inner shell's opener, inside the outer shell.
    await waitFor(() => { expect(document.activeElement).toBe(openInner); });

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Outer' })).toBeNull();
  });

  it('nests the dialog in a scrollable, no-drag overlay', async () => {
    const { dialog } = await openPage();
    const overlay = backdrop();
    // Content inside the overlay (Radix's scrollable-overlay pattern): Radix
    // lets wheel events scroll only the overlay and the content, so a tall
    // dialog scrolls with the overlay instead of being cut off.
    expect(overlay.contains(dialog)).toBe(true);
    expect(overlay.className).toContain('overflow-y-auto');
    // The overlay covers the frameless window's drag region (the app header):
    // without the opt-out, clicks in the top band would drag the window.
    expect(appRegionOf(overlay)).toBe('no-drag');
    expect(appRegionOf(dialog)).toBe('no-drag');
  });

  // A transform, filter or backdrop-filter makes an element the containing
  // block of its `position: fixed` descendants: a fixed layer opened from
  // inside the dialog would be clipped to the card instead of covering the
  // window.
  it('has no transformed or filtered ancestor', async () => {
    const { dialog } = await openPage();
    const containingBlockClass = /^(?:-?translate-|transform|scale-|rotate-|skew-|filter|blur|backdrop-)/;
    for (let node: HTMLElement | null = dialog; node !== null; node = node.parentElement) {
      const offending = [...node.classList].filter((c) => containingBlockClass.test(c.replace(/^.*:/, '')));
      expect(offending).toEqual([]);
      expect(node.style.transform).toBe('');
      expect(node.style.filter).toBe('');
    }
  });

  it('registers as a modal layer while open', async () => {
    const { user } = await openPage();
    expect(getModalLayerCount()).toBe(1);
    expect(getOpenModalLayerKinds()).toEqual(['modal-shell']);
    await user.keyboard('{Escape}');
    expect(getModalLayerCount()).toBe(0);
  });
});
