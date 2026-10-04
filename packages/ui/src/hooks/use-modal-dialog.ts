import { useEffect, useState } from 'react';
import type { RefObject } from 'react';

interface ModalDialogOptions {
  readonly onClose: () => void;
  /** When false, Escape does nothing — the dialog is locked open (e.g. while
   *  an import pull runs). Defaults to true. */
  readonly dismissable?: boolean;
  /** Focused on open in place of the dialog itself (e.g. a confirm's Cancel). */
  readonly initialFocusRef?: RefObject<HTMLElement | null>;
}

/** Focus and Escape handling shared by the app's native `<dialog open
 *  aria-modal>` modals (ConfirmModal, TitledModal, ViewYamlModal and the Data
 *  Management wizard). The dialog element needs `tabIndex={-1}` so it can
 *  take focus itself.
 *
 *  - Focus moves in on open — to `initialFocusRef`, else the dialog — unless
 *    a child already took it (an `autoFocus` input). It moves in once, on
 *    mount: callers pass inline callbacks and the app re-renders on every sync
 *    poll, so re-focusing per render would yank focus off whatever the user
 *    tabbed to or is typing in.
 *  - aria-modal tells assistive tech the page behind is inert, so focus must
 *    not reach it: anything Tab (or a click) moves out is pulled back in.
 *    Focus that lands in another open dialog this one is not nested in is left
 *    alone, so two modals open side by side never fight over it.
 *  - Focus returns to the opener on close.
 *  - Escape closes only the topmost dialog: while one opened inside this one
 *    is up, the key is that dialog's to handle. A key a nested layer already
 *    consumed (`defaultPrevented`) and an Escape that cancels an IME candidate
 *    (`isComposing`) are left alone. */
export function useModalDialog(
  dialogRef: RefObject<HTMLDialogElement | null>,
  { onClose, dismissable = true, initialFocusRef }: ModalDialogOptions,
): void {
  // Captured during the first render: by the time an effect runs, a child
  // that autofocuses an input has already moved focus off the opener.
  const [opener] = useState(() => document.activeElement);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.contains(document.activeElement)) {
      (initialFocusRef?.current ?? dialog).focus();
    }
    function keepFocusInside(e: FocusEvent): void {
      const current = dialogRef.current;
      if (current === null || !(e.target instanceof Element) || current.contains(e.target)) return;
      const other = e.target.closest('dialog[open], [role="dialog"]');
      if (other !== null && !other.contains(current)) return;
      current.focus();
    }
    document.addEventListener('focusin', keepFocusInside);
    return () => {
      document.removeEventListener('focusin', keepFocusInside);
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [dialogRef, initialFocusRef, opener]);

  useEffect(() => {
    if (!dismissable) return undefined;
    function handleKey(e: KeyboardEvent): void {
      if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented) return;
      const dialog = dialogRef.current;
      if (dialog === null || dialog.querySelector('dialog[open], [role="dialog"]') !== null) return;
      onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => { document.removeEventListener('keydown', handleKey); };
  }, [dialogRef, onClose, dismissable]);
}
