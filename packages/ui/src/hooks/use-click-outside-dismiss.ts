import { useEffect } from 'react';

/** Click outside the container fires `onCancel`. If `isDirty`, it instead
 *  flips `setDiscardConfirm(true)` so the caller can render a confirm modal.
 *  Suppressed while `discardConfirm` is already true so the modal's own
 *  outside-clicks don't recurse. */
export function useClickOutsideDismiss(
  containerRef: React.RefObject<HTMLDivElement | null>,
  onCancel: () => void,
  isDirty: boolean,
  discardConfirm: boolean,
  setDiscardConfirm: (v: boolean) => void,
): void {
  useEffect(() => {
    function onDocClick(e: MouseEvent): void {
      if (containerRef.current === null) return;
      if (!(e.target instanceof Node)) return;
      if (containerRef.current.contains(e.target)) return;
      if (discardConfirm) return;
      if (isDirty) { setDiscardConfirm(true); }
      else { onCancel(); }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => { document.removeEventListener('mousedown', onDocClick); };
  }, [containerRef, onCancel, isDirty, discardConfirm, setDiscardConfirm]);
}
