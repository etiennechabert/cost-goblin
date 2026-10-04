import { useEffect, useId, useRef, useState } from 'react';

/** Native `<dialog open aria-modal>` chrome with a title row and ✕, named by
 *  its title heading — the same overlay pattern as ConfirmModal. Shared by
 *  the config-sharing and workspace dialogs.
 *
 *  Focus moves into the dialog on open (unless a child already took it), so
 *  assistive tech announces the dialog by name instead of leaving focus on
 *  the page aria-modal declares inert, and returns to the opener on close. */
export function TitledModal({ title, onClose, children, dismissable = true }: Readonly<{
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  /** When false, the modal cannot be dismissed (no Escape, no backdrop click,
   *  no ✕) — used to hold the window open during an in-progress pull. */
  dismissable?: boolean;
}>): React.JSX.Element {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  // Captured during the first render: by the time an effect runs, a child
  // that autofocuses an input has already moved focus off the opener.
  const [opener] = useState(() => document.activeElement);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.contains(document.activeElement)) dialog.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [opener]);

  useEffect(() => {
    if (!dismissable) return undefined;
    function handleKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => { document.removeEventListener('keydown', handleKey); };
  }, [onClose, dismissable]);

  return (
    // no-drag: the modal can open above a window drag region (the standalone
    // setup wizard's backdrop, or the app header) — without the opt-out,
    // clicks there would drag the window instead of reaching the modal. (#317)
    <dialog
      ref={dialogRef}
      open
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-transparent m-0 p-0 max-w-none max-h-none w-full h-full border-none outline-none [-webkit-app-region:no-drag]"
    >
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        {...(dismissable ? { onClick: onClose } : {})}
        aria-hidden="true"
      />
      <div className="relative rounded-xl border border-border bg-bg-secondary p-6 shadow-2xl max-w-md w-full mx-4 max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h3 id={titleId} className="text-base font-semibold text-text-primary">{title}</h3>
          {dismissable && (
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-2 py-1 text-sm text-text-muted hover:text-text-primary hover:bg-bg-tertiary transition-colors"
              aria-label="Close"
            >
              ✕
            </button>
          )}
        </div>
        <div className="mt-4 flex flex-col gap-4">{children}</div>
      </div>
    </dialog>
  );
}
