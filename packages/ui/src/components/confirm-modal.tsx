import { useEffect, useId, useRef } from 'react';

interface ConfirmModalProps {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

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
  const titleId = useId();
  const messageId = useId();

  // Mount only: callers pass an inline onCancel, so an effect keyed on it
  // re-runs on every parent render (the app re-renders on each sync poll) and
  // would pull focus back to Cancel off the button the user tabbed to.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    document.addEventListener('keydown', handleKey);
    return () => { document.removeEventListener('keydown', handleKey); };
  }, [onCancel]);

  return (
    <dialog open className="fixed inset-0 z-[100] flex items-center justify-center bg-transparent m-0 p-0 max-w-none max-h-none w-full h-full border-none" aria-modal="true" aria-labelledby={titleId} aria-describedby={messageId}>
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onCancel}
        aria-hidden="true"
      />

      {/* Modal */}
      <div className="relative rounded-xl border border-border bg-bg-secondary p-6 shadow-2xl max-w-sm w-full mx-4">
        <h3 id={titleId} className="text-sm font-semibold text-text-primary">{title}</h3>
        <p id={messageId} className="text-sm text-text-secondary mt-2 leading-relaxed">{message}</p>
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
      </div>
    </dialog>
  );
}
