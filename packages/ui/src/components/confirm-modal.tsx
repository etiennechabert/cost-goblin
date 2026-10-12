import { useRef } from 'react';
import { ModalShell, ModalShellDescription, ModalShellTitle } from './ui/modal-shell.js';

interface ConfirmModalProps {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** A yes/no question over the page, named by its title and described by its
 *  message. Escape and a backdrop click cancel (see ModalShell). */
export function ConfirmModal({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
  onCancel,
}: Readonly<ConfirmModalProps>) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  return (
    // Focus starts on Cancel — once, on open: callers pass an inline onCancel
    // and the app re-renders on each sync poll, so it must not be pulled back
    // off the button the user tabbed to.
    <ModalShell onClose={onCancel} initialFocusRef={cancelRef} size="sm">
      <ModalShellTitle>
        <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
      </ModalShellTitle>
      <ModalShellDescription>
        <p className="text-sm text-text-secondary mt-2 leading-relaxed">{message}</p>
      </ModalShellDescription>
      <div className="flex items-center justify-end gap-2 mt-5">
        <button
          ref={cancelRef}
          type="button"
          onClick={onCancel}
          className="rounded-md px-3 py-1.5 text-sm font-medium text-text-secondary hover:bg-bg-tertiary transition-colors"
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className={[
            'rounded-md px-3 py-1.5 text-sm font-medium text-white transition-colors',
            destructive
              ? 'bg-negative hover:bg-negative/80'
              : 'bg-accent hover:bg-accent-hover',
          ].join(' ')}
        >
          {confirmLabel}
        </button>
      </div>
    </ModalShell>
  );
}
