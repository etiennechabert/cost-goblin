import { useEffect, useRef } from 'react';

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
}: ConfirmModalProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();

    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    document.addEventListener('keydown', handleKey);
    return () => { document.removeEventListener('keydown', handleKey); };
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center" role="dialog" aria-modal="true">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        role="button"
        tabIndex={0}
        onClick={onCancel}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onCancel(); }}
        aria-label="Close dialog"
      />

      {/* Modal */}
      <div className="relative rounded-xl border border-border bg-bg-secondary p-6 shadow-2xl max-w-sm w-full mx-4">
        <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
        <p className="text-sm text-text-secondary mt-2 leading-relaxed">{message}</p>
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
    </div>
  );
}
