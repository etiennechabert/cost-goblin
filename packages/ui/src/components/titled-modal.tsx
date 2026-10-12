import { ModalShell, ModalShellTitle } from './ui/modal-shell.js';

/** Modal chrome with a title row and ✕, named by its title heading. Shared by
 *  the config-sharing and workspace dialogs.
 *
 *  Focus moves into the dialog on open (unless a child already took it), so
 *  assistive tech announces the dialog by name; it stays inside while open
 *  and returns to the opener on close (see ModalShell). */
export function TitledModal({ title, onClose, children, dismissable = true }: Readonly<{
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  /** When false, the modal cannot be dismissed (no Escape, no backdrop click,
   *  no ✕) — used to hold the window open during an in-progress pull. */
  dismissable?: boolean;
}>): React.JSX.Element {
  return (
    <ModalShell onClose={onClose} dismissable={dismissable}>
      <div className="flex items-center justify-between">
        <ModalShellTitle>
          <h3 className="text-base font-semibold text-text-primary">{title}</h3>
        </ModalShellTitle>
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
    </ModalShell>
  );
}
