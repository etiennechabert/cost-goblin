import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { pixelRangeToBars, pixelToIndex } from '../lib/drag-select.js';

interface DragState {
  startX: number;
  currentX: number;
  rect: DOMRect;
}

interface OverlayRect {
  readonly left: number;
  readonly width: number;
}

interface UseBarDragSelectOptions {
  readonly containerRef: RefObject<HTMLDivElement | null>;
  readonly bucketCount: number;
  readonly onRangeSelect: ((startIdx: number, endIdx: number) => void) | undefined;
  readonly disabled?: boolean | undefined;
}

interface DragSelection {
  readonly startIdx: number;
  readonly endIdx: number;
}

interface UseBarDragSelectResult {
  readonly isDragging: boolean;
  readonly overlay: OverlayRect | null;
  /** Bar indices currently under the drag overlay, mirrored from the same
   *  pixelToIndex math used at mouse-up. Lets callers display the
   *  start/end-of-period labels live while the user is still dragging. */
  readonly selection: DragSelection | null;
  readonly handleMouseDown: (event: React.MouseEvent<HTMLElement>) => void;
}

const MIN_DRAG_PX = 4;

export function useBarDragSelect(options: UseBarDragSelectOptions): UseBarDragSelectResult {
  const { containerRef, bucketCount, onRangeSelect, disabled } = options;
  const [overlay, setOverlay] = useState<OverlayRect | null>(null);
  const [selection, setSelection] = useState<DragSelection | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const bucketCountRef = useRef(bucketCount);
  const onRangeSelectRef = useRef(onRangeSelect);
  bucketCountRef.current = bucketCount;
  onRangeSelectRef.current = onRangeSelect;

  const handleMouseDown = useCallback((event: React.MouseEvent<HTMLElement>) => {
    if (disabled === true) return;
    if (bucketCount <= 0) return;
    if (event.button !== 0) return;
    const container = containerRef.current;
    if (container === null) return;
    const rect = container.getBoundingClientRect();
    const startX = event.clientX - rect.left;
    dragRef.current = { startX, currentX: startX, rect };
    setOverlay({ left: startX, width: 0 });
    const startIdx = pixelToIndex(startX, rect.width, bucketCount);
    setSelection({ startIdx, endIdx: startIdx });
    event.preventDefault();
  }, [containerRef, bucketCount, disabled]);

  useEffect(() => {
    const handleMove = (e: MouseEvent) => {
      const drag = dragRef.current;
      if (drag === null) return;
      const x = Math.max(0, Math.min(drag.rect.width, e.clientX - drag.rect.left));
      drag.currentX = x;
      const minX = Math.min(drag.startX, x);
      const maxX = Math.max(drag.startX, x);
      setOverlay({ left: minX, width: maxX - minX });
      const count = bucketCountRef.current;
      const range = pixelRangeToBars(minX, maxX, drag.rect.width, count);
      if (range !== null) setSelection(range);
    };
    const handleUp = () => {
      const drag = dragRef.current;
      if (drag === null) return;
      const minX = Math.min(drag.startX, drag.currentX);
      const maxX = Math.max(drag.startX, drag.currentX);
      // Sub-4px drags are treated as plain clicks so bar hover/click still works.
      if (maxX - minX >= MIN_DRAG_PX) {
        const count = bucketCountRef.current;
        const range = pixelRangeToBars(minX, maxX, drag.rect.width, count);
        if (range !== null) onRangeSelectRef.current?.(range.startIdx, range.endIdx);
      }
      dragRef.current = null;
      setOverlay(null);
      setSelection(null);
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      dragRef.current = null;
      setOverlay(null);
      setSelection(null);
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    window.addEventListener('keydown', handleEsc);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
      window.removeEventListener('keydown', handleEsc);
    };
  }, []);

  return { isDragging: overlay !== null, overlay, selection, handleMouseDown };
}
